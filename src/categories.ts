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
import { listIssueFiles } from "./mirror.ts";
import { FRONT_MATTER_KEYS } from "./constants.ts";
import type {
  FrontMatterKey,
  IndexColumn,
  IssueFrontMatter,
} from "./types/jira-local.ts";
import type { JiraLocalConfig } from "./types/config.ts";
import { progress } from "./progress.ts";

export interface CategoryCounters {
  indexesCreated: number;
  indexesUpdated: number;
  indexesRemoved: number;
  indexesUnchanged: number;
}

const UNSAFE_CHARS = /[\/\\:*?"<>|\p{C}]/gu;

export async function reconcileCategories(
  allDir: string,
  projectKey: string,
  dryRun: boolean,
): Promise<CategoryCounters> {
  // Validate before writing anything, so a bad config aborts rather than
  // leaving the tree half-reconciled.
  const config = await getConfig();
  const counters: CategoryCounters = {
    indexesCreated: 0,
    indexesUpdated: 0,
    indexesRemoved: 0,
    indexesUnchanged: 0,
  };
  const categoriesDir = dirname(allDir);
  const scanned = await scanManagedCategories(categoriesDir, basename(allDir));
  const content = await buildDesired(allDir, projectKey, config);

  // Nested categories can be new, so create the parent directory on demand.
  for (const category of byDepth(content.keys())) {
    const indexPath = join(categoriesDir, ...category.split("/")) + ".md";
    const rendered = content.get(category) ?? "";
    const rel = relative(categoriesDir, indexPath).replaceAll(sep, "/");
    let existing: string | undefined;
    try {
      existing = await readFile(indexPath, "utf8");
    } catch {
      existing = undefined; // missing or unreadable: treat as to-be-created
    }
    if (existing === rendered) {
      counters.indexesUnchanged++;
      continue;
    }
    if (!dryRun) {
      await mkdir(dirname(indexPath), { recursive: true });
      await writeFile(indexPath, rendered);
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
    if (content.has(category)) continue;
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

/**
 * Reads the issue files itself rather than taking a snapshot, so pages are
 * always built from what is on disk at call time.
 */
async function buildDesired(
  allDir: string,
  projectKey: string,
  config: JiraLocalConfig,
): Promise<Map<string, string>> {
  const categoriesDir = dirname(allDir);
  const pending = new Map<
    string,
    { rows: IndexRow[]; columns: readonly IndexColumn[] }
  >();
  for (const file of await listIssueFiles(allDir, projectKey)) {
    const frontMatter = await readFrontMatter(file.absPath);
    for (const raw of categorizeIssue({ frontMatter, body: "" })) {
      const segments = sanitizeCategoryPath(raw);
      if (segments.length === 0) continue;
      const category = segments.join("/");
      const columns = indexOfCategory(config, segments[0] ?? "");
      if (columns === undefined) continue;
      const entry = pending.get(category) ?? { rows: [], columns };
      entry.rows.push({
        key: file.key,
        frontMatter,
        targetRel: relative(
          join(categoriesDir, ...segments),
          file.absPath,
        ).replaceAll(sep, "/"),
      });
      pending.set(category, entry);
    }
  }
  const content = new Map<string, string>();
  for (const [category, { rows, columns }] of pending) {
    rows.sort((a, b) => a.key.localeCompare(b.key));
    content.set(category, renderIndex(category, rows, columns));
  }
  return content;
}

function indexOfCategory(
  config: JiraLocalConfig,
  topLevel: string,
): readonly IndexColumn[] | undefined {
  if (config.categoryIndex === undefined) return DEFAULT_INDEX_COLUMNS;
  if (!isFrontMatterKey(topLevel)) return undefined;
  return config.categoryIndex[topLevel];
}

/** Bad front matter degrades to defaults so categorisation never crashes. */
async function readFrontMatter(absPath: string): Promise<IssueFrontMatter> {
  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch {
    return coerceFrontMatter({});
  }
  try {
    if (!test(content)) return coerceFrontMatter({});
    return coerceFrontMatter(extract<Record<string, unknown>>(content).attrs);
  } catch {
    return coerceFrontMatter({});
  }
}

// Coerced by incoming type, so only the array-valued fields need naming; the
// rest follow FRONT_MATTER_KEYS.
const ARRAY_FIELDS = new Set<FrontMatterKey>(["labels", "children", "linked"]);

function coerceFrontMatter(attrs: Record<string, unknown>): IssueFrontMatter {
  const out: Record<string, string | string[]> = {};
  for (const key of FRONT_MATTER_KEYS) {
    const value = attrs[key];
    if (ARRAY_FIELDS.has(key)) {
      out[key] = Array.isArray(value)
        ? value.map((item) => String(item))
        : value == null
        ? []
        : [String(value)];
    } else {
      out[key] = value == null ? "" : String(value);
    }
  }
  return out as unknown as IssueFrontMatter;
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
