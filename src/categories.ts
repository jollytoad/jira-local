/**
 * Category index reconciliation.
 *
 * Renders the categories returned by `categorizeIssue` (categorize.ts) as
 * index pages next to the flat `all/` folder:
 *
 *   .jira/issues/all/SRFR-1.md
 *   .jira/issues/status/Backlog.md
 *
 * A category string "a/b" nests "b" inside "a"; an issue may be listed in any
 * number of categories. Every run recomputes the desired index set from the
 * files currently in `all/`: index pages are written when their rendered
 * content differs, and removed when their category is no longer indexed
 * (stale, or dropped from `categoryIndex`).
 *
 * Which categories get index pages, and with which columns, is configured in
 * `.jira/.config.ts` (see `config.ts`): `categoryIndex` selects the
 * top-level categories with an index page. When it is omitted entirely,
 * every leaf category gets an index page with the default columns.
 *
 * Note: symlink category folders are no longer created. Folders left over
 * from older versions are ignored and left alone; deleting the whole
 * `.jira/` folder is always safe.
 */

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
import { progress } from "./util.ts";

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

/** Characters unsafe in file names, plus control characters. */
const UNSAFE_CHARS = /[\/\\:*?"<>|\p{C}]/gu;

/**
 * Reconcile the category index pages against the issues currently in `local`
 * (as scanned from `allDir`). Respects dry-run: decides but writes nothing.
 */
export async function reconcileCategories(
  local: ReadonlyMap<string, LocalIssueFile[]>,
  allDir: string,
  dryRun: boolean,
): Promise<CategoryCounters> {
  // Load (and validate) the config before anything is written: a malformed
  // config aborts the run instead of half-reconciling the tree.
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

  // Write index pages for indexed leaf categories (created/updated only when
  // the rendered content differs). Nested categories may be new, so ensure
  // the parent directory exists before writing.
  for (const category of byDepth(indexes.content.keys())) {
    const indexPath = join(categoriesDir, ...category.split("/")) + ".md";
    const content = indexes.content.get(category) ?? "";
    const rel = relative(categoriesDir, indexPath).replaceAll(sep, "/");
    let existing: string | undefined;
    try {
      existing = await readFile(indexPath, "utf8");
    } catch {
      existing = undefined; // missing (or unreadable): treat as to-be-created
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
      progress(`index     ${rel} (created)`);
    } else {
      counters.indexesUpdated++;
      progress(`index     ${rel} (updated)`);
    }
  }

  // Remove index pages of scanned categories that are no longer indexed
  // (stale categories, and categories whose `categoryIndex` entry was
  // dropped). Categories still present in the desired index set are never
  // removed here.
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
    progress(`index     ${rel} (removed)`);
  }

  return counters;
}

/**
 * Compute the desired index set: for each issue, ask the categoriser which
 * categories it belongs to. `categoryIndex` (see `indexOfCategory`) decides
 * whether the category gets an index page, and with which columns.
 *
 * Rows are collected per leaf category (sorted by key) and rendered into the
 * index content.
 */
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

/**
 * The index columns for a top-level category, or undefined when the category
 * gets no index page. An absent `categoryIndex` config indexes every
 * category with the default columns. Only front-matter field names (the
 * category vocabulary) can appear in `categoryIndex`, so anything else is
 * simply unindexed.
 */
function indexOfCategory(
  config: JiraLocalConfig,
  topLevel: string,
): readonly IndexColumn[] | undefined {
  if (config.categoryIndex === undefined) return DEFAULT_INDEX_COLUMNS;
  if (!isFrontMatterKey(topLevel)) return undefined;
  return config.categoryIndex[topLevel];
}

/**
 * Parse an issue file into its typed content (front matter + raw body).
 * Values are coerced to the `IssueFrontMatter` shape; unknown or malformed
 * front matter degrades to defaults, with the whole content as body, so
 * categorisation never crashes a pull.
 */
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

/** Coerce parsed YAML into the IssueFrontMatter shape (best effort). */
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

/**
 * Make a string safe as a file or folder name: replace unsafe characters and
 * control characters with spaces, collapse whitespace, trim, and optionally
 * clip to a maximum length.
 */
function sanitizeName(value: string, max = Number.POSITIVE_INFINITY): string {
  const cleaned = value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).replace(/\s+$/, "");
}

/** Split a category string into safe path segments ("a//b" -> ["a", "b"]). */
function sanitizeCategoryPath(raw: string): string[] {
  return raw
    .split("/")
    .map((segment) => sanitizeName(segment))
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Sort categories shallow-first by path depth. */
function byDepth(categories: Iterable<string>): string[] {
  const list = [...categories];
  list.sort((a, b) => a.localeCompare(b));
  list.sort((a, b) => a.split("/").length - b.split("/").length);
  return list;
}

/**
 * Discover the category directories currently on disk: every directory under
 * `issuesDir` except the flat issue store `rootDir` and hidden entries,
 * returned as sanitised "a/b" category strings (deduplicated). This is the
 * managed set — index pages found here whose category is no longer produced
 * by the categoriser are cleaned up. Symlinked directories (e.g. left over
 * from older versions) are never walked or managed.
 */
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
      // Symlinked dirs are never managed; walking them could escape the
      // issues directory entirely.
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
