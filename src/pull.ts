import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Dirent } from "node:fs";
import type { LocalIssueFile, PulledIssue } from "./types/jira-local.ts";
import { progress } from "./progress.ts";

const ISSUE_FILE_PATTERN = /^([A-Za-z][A-Za-z0-9]*-\d+)\.md$/;

export type PullAction = "create" | "update" | "unchanged";

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

export async function pullIssue(
  issue: PulledIssue,
  local: ReadonlyMap<string, LocalIssueFile[]>,
  outDir: string,
  dryRun: boolean,
): Promise<PullAction> {
  const fileName = `${issue.key}.md`;
  const absPath = join(outDir, fileName);
  const relPath = fileName;
  const existing = local.get(issue.key) ?? [];
  const canonical = existing.find((f) => f.relPath === relPath);
  const content = canonical?.content;

  let action: PullAction;
  if (content === undefined) action = "create";
  else if (content !== issue.markdown) action = "update";
  else action = "unchanged";

  if (action !== "unchanged" && !dryRun) {
    await mkdir(outDir, { recursive: true });
    await writeFile(absPath, issue.markdown);
  }
  // An unchanged issue is not work, so it stays unreported.
  if (action !== "unchanged") {
    progress({
      task: `issue-${action}`,
      msg: `issue ${action} (${relPath})`,
      inc: 1,
    });
  }
  return action;
}

export async function pruneDeleted(
  local: ReadonlyMap<string, LocalIssueFile[]>,
  seenKeys: ReadonlySet<string>,
  outDir: string,
  dryRun: boolean,
): Promise<number> {
  let deleted = 0;
  for (const [key, files] of local) {
    if (seenKeys.has(key)) continue;
    for (const file of files) {
      deleted++;
      if (!dryRun) await rm(file.absPath);
      progress({
        task: "issue-delete",
        msg: `issue delete (${file.relPath})`,
        inc: 1,
      });
    }
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
