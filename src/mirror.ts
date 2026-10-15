/**
 * The local mirror of Jira: locate issue files, write one, prune deleted ones.
 *
 * Nothing here keeps an issue's content — only a hash, enough to tell whether a
 * file changed. Readers that want front matter read the file themselves, so no
 * in-memory snapshot can go stale behind a write. The one exception is a file
 * about to be merged, which is read at the moment it is written.
 */

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import type {
  IssueFileRef,
  LocalIssueFile,
  PulledIssue,
} from "./types/jira-local.ts";
import { writeAtomic } from "./atomic.ts";
import { basePath, removeBase, writeBase } from "./base.ts";
import { mergeIssueFile } from "./merge.ts";
import { progress } from "./progress.ts";

const ISSUE_FILE_PATTERN = /^([A-Za-z][A-Za-z0-9]*-\d+)\.md$/;

/**
 * The issue a mirrored file stands for, or undefined when the name is not
 * issue-key shaped. A loose file beside the mirrored ones is a declaration, so
 * this is also what tells the two apart.
 */
export function issueKeyFromFileName(name: string): string | undefined {
  return ISSUE_FILE_PATTERN.exec(name)?.[1];
}

export type PullAction = "create" | "update" | "unchanged" | "conflict";

export interface WriteIssueOptions {
  /** Three-way merge against the base. Off means overwrite, as before. */
  merge: boolean;
  dryRun: boolean;
}

export function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function listIssueFiles(
  outDir: string,
  projectKey: string,
): Promise<IssueFileRef[]> {
  const prefix = projectKey === "*" ? "" : `${projectKey.toLowerCase()}-`;
  let entries: Dirent[];
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const refs: IssueFileRef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const key = issueKeyFromFileName(entry.name);
    if (!key || !key.toLowerCase().startsWith(prefix)) continue;
    const absPath = join(outDir, entry.name);
    refs.push({ key, absPath, relPath: relative(outDir, absPath) });
  }
  return refs;
}

export async function scanLocal(
  outDir: string,
  projectKey: string,
): Promise<Map<string, LocalIssueFile>> {
  const local = new Map<string, LocalIssueFile>();
  for (const ref of await listIssueFiles(outDir, projectKey)) {
    const content = await readFile(ref.absPath, "utf8");
    local.set(ref.key, { ...ref, hash: hashOf(content) });
  }
  return local;
}

export async function pullIssue(
  issue: PulledIssue,
  local: ReadonlyMap<string, LocalIssueFile>,
  outDir: string,
  options: WriteIssueOptions,
): Promise<PullAction> {
  const fileName = `${issue.key}.md`;
  const absPath = join(outDir, fileName);
  const existing = local.get(issue.key);
  if (existing !== undefined && existing.hash === hashOf(issue.markdown)) {
    return "unchanged";
  }

  let text = issue.markdown;
  let conflicted = false;
  if (existing !== undefined && options.merge) {
    const baseText = await readFile(basePath(issue.key), "utf8").catch(
      () => undefined,
    );
    const result = await mergeIssueFile({
      localText: await readFile(absPath, "utf8"),
      baseText,
      jiraText: issue.markdown,
      localPath: absPath,
      basePath: basePath(issue.key),
    });
    text = result.text;
    conflicted = result.conflicted;
    if (!result.changed) return "unchanged";
  }

  const action: PullAction = conflicted
    ? "conflict"
    : existing === undefined
    ? "create"
    : "update";

  if (!options.dryRun) {
    await mkdir(outDir, { recursive: true });
    await writeAtomic(absPath, text);
    await writeBase(
      issue.key,
      issue.markdown,
      text === issue.markdown ? absPath : undefined,
    );
  }
  progress({
    task: `issue-${action}`,
    msg: `issue ${action} (${fileName})`,
    inc: 1,
  });
  return action;
}

export async function pruneDeleted(
  local: ReadonlyMap<string, LocalIssueFile>,
  seenKeys: ReadonlySet<string>,
  outDir: string,
  dryRun: boolean,
): Promise<number> {
  let deleted = 0;
  for (const [key, file] of local) {
    if (seenKeys.has(key)) continue;
    deleted++;
    if (!dryRun) {
      await rm(file.absPath);
      await removeBase(key);
    }
    progress({
      task: "issue-delete",
      msg: `issue delete (${file.relPath})`,
      inc: 1,
    });
  }
  if (!dryRun && deleted > 0) {
    try {
      const remaining = await readdir(outDir);
      if (remaining.length === 0) await rm(outDir, { recursive: true });
    } catch {
      // Already gone or unreadable: nothing to do.
    }
  }
  return deleted;
}
