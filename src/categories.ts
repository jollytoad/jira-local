import { extract } from "@std/front-matter/yaml";
import { test } from "@std/front-matter/test";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Dirent } from "node:fs";
import {
  DEFAULT_INDEX_COLUMNS,
  type IndexRow,
  renderIndex,
} from "./category-indexes.ts";
import { getConfig, isFrontMatterKey } from "./config.ts";
import { categorizeIssue } from "./categorize.ts";
import type {
  IndexColumn,
  IssueFileContent,
  IssueFrontMatter,
  LocalIssueFile,
} from "./types/jira-local.ts";
import type { JiraLocalConfig } from "./types/config.ts";
import { progress } from "./progress.ts";

export interface CategoryCounters {
  indexesCreated: number;
  indexesUpdated: number;
  indexesRemoved: number;
  indexesUnchanged: number;
}

interface DesiredIndexes {
  /** Rendered markdown per category ("status/Backlog" -> file content). */
  content: Map<string, string>;
  /** Issues per category, for the index tables. */
  rows: Map<string, IndexRow[]>;
}

const UNSAFE_CHARS = /[\/\\:*?"<>|\p{C}]/gu;

export async function reconcileCategories(
  local: ReadonlyMap<string, LocalIssueFile[]>,
  allDir: string,
  dryRun: boolean,
): Promise<CategoryCounters> {
  // Validate before writing anything, so a bad config aborts rather than
  // leaving the tree half-reconciled.
  const config = await getConfig(allDir);
  const counters: CategoryCounters = {
    indexesCreated: 0,
    indexesUpdated: 0,
    indexesRemoved: 0,
    indexesUnchanged: 0,
  };
  const categoriesDir = dirname(allDir);
  const scanned = await scanManagedCategories(categoriesDir, basename(allDir));
  const indexes = buildDesired(local, allDir, config);

  // Nested categories can be new, so create the parent directory on demand.
  for (const category of byDepth(indexes.content.keys())) {
    const indexPath = join(categoriesDir, ...category.split("/")) + ".md";
    const content = indexes.content.get(category) ?? "";
    const rel = relative(categoriesDir, indexPath).replaceAll(sep, "/");
    let existing: string | undefined;
    try {
      existing = await readFile(indexPath, "utf8");
    } catch {
      existing = undefined; // missing or unreadable: treat as to-be-created
    }
    if (existing === content) {
      counters.indexesUnchanged++;
      continue;
    }
    if (!dryRun) {
      await mkdir(dirname(indexPath), { recursive: true });
      await writeFile(indexPath, content);
    }
    if (existing === undefined) {
      counters.indexesCreated++;
      progress({ task: "index-create", msg: `index create (${rel})`, inc: 1 });
    } else {
      counters.indexesUpdated++;
      progress({ task: "index-update", msg: `index update (${rel})`, inc: 1 });
    }
  }

  // Anything on disk no longer in the desired set is stale and goes.
  for (const category of scanned) {
    if (indexes.content.has(category)) continue;
    const indexPath = join(categoriesDir, ...category.split("/")) + ".md";
    const rel = relative(categoriesDir, indexPath).replaceAll(sep, "/");
    let exists = false;
    try {
      exists = (await stat(indexPath)).isFile();
    } catch {
      exists = false;
    }
    if (!exists) continue;
    if (!dryRun) await rm(indexPath);
    counters.indexesRemoved++;
    progress({ task: "index-delete", msg: `index delete (${rel})`, inc: 1 });
  }

  // These rows only ever count, so nothing else would stop their spinners.
  progress({ task: "index-create", msg: "indexes created", status: "stop" });
  progress({ task: "index-update", msg: "indexes updated", status: "stop" });
  progress({ task: "index-delete", msg: "indexes removed", status: "stop" });

  return counters;
}

function buildDesired(
  local: ReadonlyMap<string, LocalIssueFile[]>,
  allDir: string,
  config: JiraLocalConfig,
): DesiredIndexes {
  const categoriesDir = dirname(allDir);
  const rows = new Map<string, IndexRow[]>();
  // Columns per indexed leaf category; undefined = no index page.
  const columnsByCategory = new Map<string, readonly IndexColumn[]>();
  for (const files of local.values()) {
    for (const file of files) {
      const issue = parseIssueFile(file.content);
      for (const raw of categorizeIssue(issue)) {
        const segments = sanitizeCategoryPath(raw);
        if (segments.length === 0) continue;
        const category = segments.join("/");
        const topLevel = segments[0] ?? "";
        const targetAbs = join(allDir, `${file.key}.md`);

        const indexTargetRel = relative(
          join(categoriesDir, ...segments),
          targetAbs,
        ).replaceAll(sep, "/");
        const rowsForCategory = rows.get(category) ?? [];
        rowsForCategory.push({
          key: file.key,
          frontMatter: issue.frontMatter,
          targetRel: indexTargetRel,
        });
        rows.set(category, rowsForCategory);
        const columns = indexOfCategory(config, topLevel);
        if (columns !== undefined) {
          columnsByCategory.set(category, columns);
        }
      }
    }
  }
  const content = new Map<string, string>();
  for (const [category, rowsForCategory] of rows) {
    const columns = columnsByCategory.get(category);
    if (columns === undefined) continue; // not indexed: no page
    rowsForCategory.sort((a, b) => a.key.localeCompare(b.key));
    content.set(category, renderIndex(category, rowsForCategory, columns));
  }
  return { content, rows };
}

function indexOfCategory(
  config: JiraLocalConfig,
  topLevel: string,
): readonly IndexColumn[] | undefined {
  if (config.categoryIndex === undefined) return DEFAULT_INDEX_COLUMNS;
  if (!isFrontMatterKey(topLevel)) return undefined;
  return config.categoryIndex[topLevel];
}

/** Bad front matter degrades to defaults so categorisation never crashes a pull. */
function parseIssueFile(content: string): IssueFileContent {
  try {
    if (!test(content)) {
      return { frontMatter: emptyFrontMatter(), body: content };
    }
    const { attrs, body } = extract<Record<string, unknown>>(content);
    return { frontMatter: coerceFrontMatter(attrs), body };
  } catch {
    return { frontMatter: emptyFrontMatter(), body: content };
  }
}

function emptyFrontMatter(): IssueFrontMatter {
  return {
    key: "",
    summary: "",
    status: "",
    statusCategory: "",
    type: "",
    priority: "",
    assignee: "",
    reporter: "",
    labels: [],
    parent: "",
    children: [],
    linked: [],
    created: "",
    updated: "",
    url: "",
  };
}

function coerceFrontMatter(attrs: Record<string, unknown>): IssueFrontMatter {
  const stringOf = (key: string): string => {
    const value = attrs[key];
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    return String(value);
  };
  const arrayOf = (key: string): string[] => {
    const value = attrs[key];
    if (Array.isArray(value)) return value.map((item) => String(item));
    if (value === null || value === undefined) return [];
    return [String(value)];
  };
  return {
    ...emptyFrontMatter(),
    key: stringOf("key"),
    summary: stringOf("summary"),
    status: stringOf("status"),
    statusCategory: stringOf("statusCategory"),
    type: stringOf("type"),
    priority: stringOf("priority"),
    assignee: stringOf("assignee"),
    reporter: stringOf("reporter"),
    labels: arrayOf("labels"),
    parent: stringOf("parent"),
    children: arrayOf("children"),
    linked: arrayOf("linked"),
    created: stringOf("created"),
    updated: stringOf("updated"),
    url: stringOf("url"),
  };
}

/** Unsafe characters and whitespace collapse to spaces; optionally clipped. */
function sanitizeName(value: string, max = Number.POSITIVE_INFINITY): string {
  const cleaned = value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).replace(/\s+$/, "");
}

/** "a//b" -> ["a", "b"]; drops empty and relative segments. */
function sanitizeCategoryPath(raw: string): string[] {
  return raw
    .split("/")
    .map((segment) => sanitizeName(segment))
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function byDepth(categories: Iterable<string>): string[] {
  const list = [...categories];
  list.sort((a, b) => a.localeCompare(b));
  list.sort((a, b) => a.split("/").length - b.split("/").length);
  return list;
}

async function scanManagedCategories(
  issuesDir: string,
  rootDir: string,
): Promise<string[]> {
  const categories = new Set<string>();
  const walk = async (segments: string[]): Promise<void> => {
    const absDir = join(issuesDir, ...segments);
    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return; // vanished mid-run: nothing to clean up
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (segments.length === 0 && entry.name === rootDir) continue;
      if (!entry.isDirectory()) continue;
      // A symlinked dir could point anywhere, so never treat it as ours.
      if (entry.isSymbolicLink()) continue;
      const name = sanitizeName(entry.name);
      if (name === "") continue;
      const child = [...segments, name];
      categories.add(child.join("/"));
      await walk(child);
    }
  };
  await walk([]);
  return [...categories].sort();
}
