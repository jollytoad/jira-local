/**
 * Category folder reconciliation.
 *
 * Materialises the categories returned by `categorizeIssue` (categorize.ts)
 * as folders of symlinks next to the flat `all/` folder:
 *
 *   .jira/issues/all/SRFR-1.md
 *   .jira/issues/status/Done/SRFR-1-QoL improvements for using repos.md
 *     -> ../../all/SRFR-1.md
 *
 * A category string "a/b" nests "b" inside "a"; an issue may be listed in any
 * number of categories. Every run recomputes the desired link set from the
 * files currently in `all/` and reconciles: missing links are created,
 * changed targets are retargeted, links for issues that left a category are
 * removed, and category folders that end up empty are rmdir'd. Every folder
 * under the issues directory except `all/` (and hidden entries) is treated
 * as managed, so stale folders are cleaned up even after the categoriser
 * stops producing them; foreign files are left alone and only empty managed
 * folders are ever removed.
 *
 * Which folders and index pages are materialised is configured in
 * `.jira/config.ts` (see `config.ts`). The two are independent:
 *
 * - `categoryFolders` restricts the symlink folders (everything else becomes
 *   stale and is cleaned up).
 * - `categoryIndex` selects which top-level folders get an index page and
 *   with which columns — including folders whose symlink folders are
 *   disabled, where only the `<leaf>.md` pages exist. When `categoryIndex`
 *   is omitted entirely, every leaf category gets an index page with the
 *   default columns.
 *
 * Alongside the symlinks, each indexed leaf category gets an index page: a
 * markdown table of its issues rendered by `category-indexes.ts` (e.g.
 * `status/Backlog.md` next to the `status/Backlog/` folder). Index pages are
 * written when their content differs and removed when their category is no
 * longer indexed (stale, or dropped from `categoryIndex`).
 */

import { extract } from "@std/front-matter/yaml";
import { test } from "@std/front-matter/test";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
  JiraLocalConfig,
  LocalIssueFile,
} from "./types.ts";
import { progress } from "./util.ts";

export interface CategoryCounters {
  linksCreated: number;
  linksRetargeted: number;
  linksRemoved: number;
  linksUnchanged: number;
  dirsCreated: number;
  dirsRemoved: number;
  indexesCreated: number;
  indexesUpdated: number;
  indexesRemoved: number;
  indexesUnchanged: number;
}

interface DesiredLink {
  key: string;
  linkPath: string;
  targetRel: string;
  targetAbs: string;
}

interface DesiredIndexes {
  /** Rendered markdown per category ("status/Backlog" -> file content). */
  content: Map<string, string>;
  /** Issues per category, for the index tables. */
  rows: Map<string, IndexRow[]>;
}

const MAX_SUMMARY_LENGTH = 120;
/** Characters unsafe in file names, plus control characters. */
const UNSAFE_CHARS = /[\/\\:*?"<>|\p{C}]/gu;

/**
 * Reconcile the category folders against the issues currently in `local`
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
    linksCreated: 0,
    linksRetargeted: 0,
    linksRemoved: 0,
    linksUnchanged: 0,
    dirsCreated: 0,
    dirsRemoved: 0,
    indexesCreated: 0,
    indexesUpdated: 0,
    indexesRemoved: 0,
    indexesUnchanged: 0,
  };
  const categoriesDir = dirname(allDir);
  const scanned = await scanManagedCategories(categoriesDir, basename(allDir));
  const desired = buildDesired(local, allDir, config);

  // Category folders that are no longer produced by the categoriser.
  const staleDirs = scanned.filter(
    (category) => !desired.categories.has(category),
  );

  // 1. Ensure every desired category folder exists (parents first).
  for (const category of byDepth(desired.categories)) {
    const absDir = join(categoriesDir, ...category.split("/"));
    if (await isDirectory(absDir)) continue;
    if (!dryRun) await mkdir(absDir, { recursive: true });
    counters.dirsCreated++;
    progress(`mkdir     ${category}`);
  }

  // 2. Reconcile the links inside managed and desired folders: create links
  //    that don't exist yet, retarget changed ones, remove stale ones.
  for (const link of desired.links.values()) {
    const rel = relative(categoriesDir, link.linkPath).replaceAll(sep, "/");
    let entry: Dirent | undefined;
    try {
      entry = (await readdir(dirname(link.linkPath), { withFileTypes: true }))
        .find((candidate) => candidate.name === basename(link.linkPath));
    } catch {
      // Folder doesn't exist (dry-run: it was never created). Still count
      // the link as to-be-created so the plan reflects reality.
      entry = undefined;
    }
    if (entry === undefined) {
      if (!dryRun) {
        try {
          await symlink(link.targetAbs, link.linkPath);
        } catch (error) {
          return rethrowFs(error, "create symlink", rel);
        }
      }
      counters.linksCreated++;
      progress(`link      ${rel} -> ${link.targetRel}`);
      continue;
    }
    if (!entry.isSymbolicLink()) {
      progress(`skip      ${rel} (not a symlink — left alone)`);
      continue;
    }
    const linkDir = dirname(link.linkPath);
    const current = await readlink(link.linkPath);
    if (resolve(linkDir, current) === resolve(linkDir, link.targetRel)) {
      counters.linksUnchanged++;
      continue;
    }
    if (!dryRun) {
      await rm(link.linkPath);
      await symlink(link.targetAbs, link.linkPath);
    }
    counters.linksRetargeted++;
    progress(`retarget  ${rel} -> ${link.targetRel}`);
  }

  // 2b. Remove links inside managed or desired folders that are no longer
  //     wanted there. Foreign non-symlink files are left alone.
  for (
    const dirCategory of byDepth([
      ...scanned,
      ...desired.categories,
    ])
  ) {
    const absDir = join(categoriesDir, ...dirCategory.split("/"));
    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue; // folder vanished or never existed
    }
    for (const entry of entries) {
      const linkPath = join(absDir, entry.name);
      if (desired.links.has(linkPath)) continue; // handled above
      if (!entry.isSymbolicLink()) continue; // foreign file: leave it alone
      const rel = relative(categoriesDir, linkPath).replaceAll(sep, "/");
      if (!dryRun) await rm(linkPath);
      counters.linksRemoved++;
      progress(`unlink    ${rel}`);
    }
  }

  // 2c. Write index pages for indexed leaf categories (created/updated only
  //     when the rendered content differs). Indexed categories may not have
  //     materialised folders (index-only in the config), so ensure the
  //     parent directory exists before writing.
  for (const category of byDepth(desired.indexes.content.keys())) {
    const indexPath = join(categoriesDir, ...category.split("/")) + ".md";
    const content = desired.indexes.content.get(category) ?? "";
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

  // 2d. Remove index pages of scanned categories that are no longer indexed
  //     (stale categories, and kept categories whose `categoryIndex` entry
  //     was dropped), so folder cleanup in step 3 is not blocked by
  //     non-symlink files. Categories still present in the desired index
  //     set are never removed here — that covers index-only categories,
  //     whose folders are stale but whose index pages are kept.
  for (const category of scanned) {
    if (desired.indexes.content.has(category)) continue;
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

  // 3. Remove category folders that are no longer wanted (deepest first),
  //    including parents whose subfolders have all been removed.
  const removedLeaves = new Set(
    byDepth(staleDirs, true).map((category) => category.split("/")),
  );
  for (const segments of removedLeaves) {
    // Every prefix of a removed leaf is also removable if it ends up empty.
    while (segments.length > 0) {
      const absDir = join(categoriesDir, ...segments);
      if (dryRun) {
        // Only claim removal if nothing but removable symlinks would remain.
        try {
          const entries = await readdir(absDir, { withFileTypes: true });
          if (entries.some((entry) => !entry.isSymbolicLink())) break;
        } catch {
          break;
        }
      } else {
        try {
          await rmdir(absDir);
        } catch {
          break; // not empty (foreign files) or already gone
        }
      }
      counters.dirsRemoved++;
      progress(`rmdir     ${segments.join("/")}`);
      segments.pop();
    }
  }

  return counters;
}

/**
 * Compute the desired link and index sets: for each issue, ask the
 * categoriser which categories it belongs to. Two independent filters apply:
 *
 * - `categoryFolders` allowlist (first segment): disables the symlink
 *   folder/link for that category. Skipped categories contribute nothing to
 *   `links`/`categories`.
 * - `categoryIndex` (see `indexOfCategory`): decides whether the category
 *   gets an index page. Evaluated independently of the folder filter, so a
 *   folder can be indexed without materialising its symlink folders.
 *
 * Rows are collected per leaf category (sorted by key) and rendered into the
 * index content.
 */
function buildDesired(
  local: ReadonlyMap<string, LocalIssueFile[]>,
  allDir: string,
  config: JiraLocalConfig,
): {
  links: Map<string, DesiredLink>;
  categories: Set<string>;
  indexes: DesiredIndexes;
} {
  const categoriesDir = dirname(allDir);
  const links = new Map<string, DesiredLink>();
  const categories = new Set<string>();
  const rows = new Map<string, IndexRow[]>();
  // Columns per indexed leaf category; undefined = no index page.
  const columnsByCategory = new Map<string, readonly IndexColumn[]>();
  const folderFilter = config.categoryFolders
    ? new Set<string>(config.categoryFolders)
    : undefined;
  for (const files of local.values()) {
    for (const file of files) {
      const issue = parseIssueFile(file.content);
      for (const raw of categorizeIssue(issue)) {
        const segments = sanitizeCategoryPath(raw);
        if (segments.length === 0) continue;
        const category = segments.join("/");
        const folder = segments[0] ?? "";
        // Absolute target: some runtimes resolve a symlink's relative target
        // against the process CWD when checking write permissions, which a
        // relative "../.." target would push outside the sandbox.
        const targetAbs = join(allDir, `${file.key}.md`);

        // Index pages are independent of the folder filter: collect rows and
        // columns for every category the categoriser produces.
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
        const columns = indexOfCategory(config, folder);
        if (columns !== undefined) {
          columnsByCategory.set(category, columns);
        }

        // Symlink folders respect the `categoryFolders` allowlist.
        if (folderFilter && !folderFilter.has(folder)) continue;
        const summary = sanitizeName(issue.frontMatter.summary);
        const base = summary
          ? `${file.key}-${summary.slice(0, MAX_SUMMARY_LENGTH)}.md`
          : `${file.key}.md`;
        const linkPath = join(categoriesDir, ...segments, base);
        const targetRel = relative(dirname(linkPath), targetAbs).replaceAll(
          sep,
          "/",
        );
        categories.add(category);
        links.set(linkPath, {
          key: file.key,
          linkPath,
          targetRel,
          targetAbs,
        });
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
  return { links, categories, indexes: { content, rows } };
}

/**
 * The index columns for a top-level category folder, or undefined when the
 * folder gets no index page. An absent `categoryIndex` config indexes every
 * folder with the default columns. Only front-matter field names (the
 * folder vocabulary) can appear in `categoryIndex`, so anything else is
 * simply unindexed.
 */
function indexOfCategory(
  config: JiraLocalConfig,
  folder: string,
): readonly IndexColumn[] | undefined {
  if (config.categoryIndex === undefined) return DEFAULT_INDEX_COLUMNS;
  if (!isFrontMatterKey(folder)) return undefined;
  return config.categoryIndex[folder];
}

/**
 * Parse an issue file into its typed content (front matter + raw body).
 * Values are coerced to the `IssueFrontMatter` shape; unknown or malformed
 * front matter degrades to defaults, with the whole content as body, so
 * categorisation never crashes a sync.
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

/** Sort categories shallow-first (or deep-first) by path depth. */
function byDepth(categories: Iterable<string>, deepestFirst = false): string[] {
  const list = [...categories];
  list.sort((a, b) => a.localeCompare(b));
  list.sort((a, b) =>
    deepestFirst
      ? b.split("/").length - a.split("/").length
      : a.split("/").length - b.split("/").length
  );
  return list;
}

/**
 * Discover the category folders currently on disk: every directory under
 * `issuesDir` except the flat issue store `rootDir` and hidden entries,
 * returned as sanitised "a/b" category strings (deduplicated). This is the
 * managed set — folders found here but no longer produced by the categoriser
 * are cleaned up.
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
      // Symlinked dirs are never managed folders; walking them could escape
      // the issues directory entirely.
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Re-throw unexpected filesystem errors (permissions, etc.) with context.
 * Only benign races (the entry appeared/disappeared under us) are absorbed.
 */
function rethrowFs(error: unknown, action: string, path: string): never {
  if (error instanceof Deno.errors.AlreadyExists) {
    progress(`skip      ${path} (${action}: already exists)`);
    const exitError = new Error(`${action} ${path}: already exists`);
    exitError.cause = error;
    throw exitError;
  }
  if (error instanceof Deno.errors.NotFound) {
    progress(`skip      ${path} (${action}: vanished mid-run)`);
    const exitError = new Error(`${action} ${path}: vanished mid-run`);
    exitError.cause = error;
    throw exitError;
  }
  const wrapped = new Error(`${action} ${path}: ${messageOf(error)}`);
  wrapped.cause = error;
  throw wrapped;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
