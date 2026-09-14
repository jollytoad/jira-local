/**
 * Sync logic: stream issues from Jira and mirror them into a flat folder of
 * `<KEY>.md` files, logging each action as it happens.
 */

import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import type { Dirent } from "node:fs";
import type { SyncIssue } from "./jira.ts";
import { progress } from "./util.ts";

const ISSUE_FILE_PATTERN = /^([A-Za-z][A-Za-z0-9]*-\d+)\.md$/;

export interface LocalIssueFile {
  key: string;
  absPath: string;
  relPath: string;
  content: string;
}

/** Sync one streamed issue against the local tree. Returns the action taken. */
export type SyncAction = "create" | "update" | "unchanged";

export interface SyncCounters {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/** Scan the output folder for issue files belonging to `projectKey`. */
export async function scanLocal(
  outDir: string,
  projectKey: string,
): Promise<Map<string, LocalIssueFile[]>> {
  const local = new Map<string, LocalIssueFile[]>();
  const prefix = projectKey === "*" ? "" : `${projectKey.toLowerCase()}-`;
  let files: Dirent[];
  try {
    files = await readdir(outDir, { withFileTypes: true });
  } catch {
    return local;
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".md")) continue;
    const match = ISSUE_FILE_PATTERN.exec(file.name);
    if (!match || !match[1]) continue;
    const key = match[1];
    if (!key.toLowerCase().startsWith(prefix)) continue;
    const absPath = join(outDir, file.name);
    const relPath = relative(outDir, absPath);
    const content = await readFile(absPath, "utf8");
    const entry: LocalIssueFile = { key, absPath, relPath, content };
    const list = local.get(key) ?? [];
    list.push(entry);
    local.set(key, list);
  }
  return local;
}

/**
 * Write (or skip) a single streamed issue, logging the action with a running
 * counter. Respects dry-run (decides but does not write).
 */
export async function syncIssue(
  issue: SyncIssue,
  local: ReadonlyMap<string, LocalIssueFile[]>,
  outDir: string,
  dryRun: boolean,
  counters: SyncCounters,
  total: number | undefined,
): Promise<SyncAction> {
  const fileName = `${issue.key}.md`;
  const absPath = join(outDir, fileName);
  const relPath = fileName;
  const existing = local.get(issue.key) ?? [];
  const canonical = existing.find((f) => f.relPath === relPath);
  const content = canonical?.content;

  let action: SyncAction;
  if (content === undefined) action = "create";
  else if (content !== issue.markdown) action = "update";
  else action = "unchanged";

  if (action !== "unchanged" && !dryRun) {
    await mkdir(outDir, { recursive: true });
    await writeFile(absPath, issue.markdown);
  }
  bump(counters, action);
  // Unchanged issues stay silent: only report actual work.
  if (action !== "unchanged") {
    progress(
      `${action.padEnd(9)} ${relPath}${
        total !== undefined
          ? ` [${counters.created + counters.updated}/${total}]`
          : ""
      }`,
    );
  }
  return action;
}

/**
 * Delete local files for issues no longer present in Jira (prune enabled),
 * then remove the output folder if it is left empty.
 */
export async function pruneDeleted(
  local: ReadonlyMap<string, LocalIssueFile[]>,
  seenKeys: ReadonlySet<string>,
  outDir: string,
  dryRun: boolean,
  counters: SyncCounters,
): Promise<number> {
  let deleted = 0;
  for (const [key, files] of local) {
    if (seenKeys.has(key)) continue;
    for (const file of files) {
      deleted++;
      counters.deleted++;
      if (!dryRun) {
        await rm(file.absPath);
        progress(`delete     ${file.relPath} (deleted in Jira)`);
      } else {
        progress(`delete     ${file.relPath} (deleted in Jira, dry-run)`);
      }
    }
  }
  if (!dryRun && deleted > 0) {
    try {
      const remaining = await readdir(outDir);
      const mdFiles = remaining.filter((name) => name.endsWith(".md"));
      if (mdFiles.length === 0 && remaining.length > 0) {
        // Only non-markdown leftovers (none expected): leave them alone.
      }
      if (remaining.length === 0) await rm(outDir, { recursive: true });
    } catch {
      // dir already gone or unreadable: nothing to do
    }
  }
  return deleted;
}

function bump(counters: SyncCounters, action: SyncAction): void {
  if (action === "create") counters.created++;
  else if (action === "update") counters.updated++;
  else counters.unchanged++;
}

/** Ensure `outDir` exists (used before scanning when it may not exist yet). */
export async function ensureOutDir(outDir: string): Promise<void> {
  try {
    const info = await stat(outDir);
    if (!info.isDirectory()) throw new Error(`${outDir} is not a directory`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a directory")) {
      throw error;
    }
    await mkdir(outDir, { recursive: true });
  }
}
