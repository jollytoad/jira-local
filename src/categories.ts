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
 * removed, and category folders that end up empty are rmdir'd. Folders
 * previously managed are recorded in a manifest (`.categories.json`, sibling
 * of `all/`) so stale folders are cleaned up even after the categoriser stops
 * producing them; only manifest-claimed folders are ever removed.
 */

import { extractYaml, test } from "@std/front-matter";
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
import { categorizeIssue } from "./categorize.ts";
import type { LocalIssueFile } from "./sync.ts";
import { progress } from "./util.ts";

export interface CategoryCounters {
  linksCreated: number;
  linksRetargeted: number;
  linksRemoved: number;
  linksUnchanged: number;
  dirsCreated: number;
  dirsRemoved: number;
}

interface DesiredLink {
  key: string;
  linkPath: string;
  targetRel: string;
  targetAbs: string;
}

interface CategoryManifest {
  version: 1;
  categories: string[];
}

const MANIFEST_NAME = ".categories.json";
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
  const counters: CategoryCounters = {
    linksCreated: 0,
    linksRetargeted: 0,
    linksRemoved: 0,
    linksUnchanged: 0,
    dirsCreated: 0,
    dirsRemoved: 0,
  };
  const categoriesDir = dirname(allDir);
  const manifestPath = join(categoriesDir, MANIFEST_NAME);
  const previous = await loadManifest(manifestPath);
  const desired = buildDesired(local, allDir);

  // Category folders that are no longer produced by the categoriser.
  const staleDirs = previous.categories.filter(
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
      ...previous.categories,
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

  // 3. Remove category folders that are no longer wanted (deepest first),
  //    including manifest parents whose subfolders have all been removed.
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

  // 4. Rewrite the manifest when the managed set changed.
  const next: CategoryManifest = {
    version: 1,
    categories: [...desired.categories].sort(),
  };
  const serialized = JSON.stringify(next, null, 2) + "\n";
  const previousJson = JSON.stringify(
    previous.manifest ?? { version: 1, categories: [] },
    null,
    2,
  ) + "\n";
  if (!dryRun && serialized !== previousJson) {
    await writeFile(manifestPath, serialized);
  }
  return counters;
}

/**
 * Compute the desired link set: for each issue, ask the categoriser which
 * categories it belongs to and derive one link per (issue, category) pair.
 */
function buildDesired(
  local: ReadonlyMap<string, LocalIssueFile[]>,
  allDir: string,
): { links: Map<string, DesiredLink>; categories: Set<string> } {
  const categoriesDir = dirname(allDir);
  const links = new Map<string, DesiredLink>();
  const categories = new Set<string>();
  for (const files of local.values()) {
    for (const file of files) {
      const { frontMatter, body } = parseIssueFile(file.content);
      for (const raw of categorizeIssue({ frontMatter, body })) {
        const segments = sanitizeCategoryPath(raw);
        if (segments.length === 0) continue;
        const category = segments.join("/");
        const summary = sanitizeName(frontMatter["summary"] ?? "");
        const base = summary
          ? `${file.key}-${summary.slice(0, MAX_SUMMARY_LENGTH)}.md`
          : `${file.key}.md`;
        const linkPath = join(categoriesDir, ...segments, base);
        // Absolute target: some runtimes resolve a symlink's relative target
        // against the process CWD when checking write permissions, which a
        // relative "../.." target would push outside the sandbox.
        const targetAbs = join(allDir, `${file.key}.md`);
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
  return { links, categories };
}

/**
 * Parse an issue file into front-matter values (strings) and the raw
 * markdown body. Malformed front matter degrades to empty values, with the
 * whole content as body, so categorisation never crashes a sync.
 */
function parseIssueFile(
  content: string,
): { frontMatter: Record<string, string>; body: string } {
  try {
    if (!test(content)) return { frontMatter: {}, body: content };
    const { attrs, body } = extractYaml<Record<string, unknown>>(content);
    const frontMatter: Record<string, string> = {};
    for (const [key, value] of Object.entries(attrs)) {
      frontMatter[key] = value === null || value === undefined
        ? ""
        : typeof value === "string"
        ? value
        : String(value);
    }
    return { frontMatter, body };
  } catch {
    return { frontMatter: {}, body: content };
  }
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
 * Load the manifest of previously managed category folders. Stored category
 * strings are re-sanitised defensively before use.
 */
async function loadManifest(
  path: string,
): Promise<{ manifest?: CategoryManifest; categories: string[] }> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<CategoryManifest>;
    if (!Array.isArray(parsed.categories)) {
      return { categories: [] };
    }
    const categories = [
      ...new Set(
        parsed.categories
          .filter((category): category is string =>
            typeof category === "string"
          )
          .map((category) => sanitizeCategoryPath(category).join("/"))
          .filter((category) => category !== ""),
      ),
    ].sort();
    return {
      manifest: parsed as CategoryManifest,
      categories,
    };
  } catch {
    return { categories: [] };
  }
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
