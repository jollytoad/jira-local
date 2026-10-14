/**
 * Three-way merge of an issue file, borrowed from git rather than reinvented:
 * `git merge-file` already decides what a conflict is, and its diff3 output is
 * the shape every merge tool and every agent knows how to read.
 *
 * The three inputs are the working copy (ours), the base file (the ancestor)
 * and the freshly rendered Jira version (theirs).
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { TEMP_DIR } from "./constants.ts";

/**
 * A conflict marker at the start of a line. Labels follow the marker, so
 * require the space: prose and code samples do not carry one.
 */
const CONFLICT_MARKER = /^<{7} /;

export class MergeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MergeError";
  }
}

export function hasConflictMarkers(text: string): boolean {
  return text.split("\n").some((line) => CONFLICT_MARKER.test(line));
}

export interface MergeRequest {
  /** The working copy, or undefined when the file does not exist yet. */
  localText: string | undefined;
  /** The last version known to match Jira, or undefined before the first sync. */
  baseText: string | undefined;
  jiraText: string;
  /** Absolute path of the working copy. Must exist when a merge is needed. */
  localPath: string;
  /** Absolute path of the base file. Must exist when a merge is needed. */
  basePath: string;
}

export interface MergeResult {
  text: string;
  conflicted: boolean;
  /** False when the working copy already holds this text. */
  changed: boolean;
}

export async function mergeIssueFile(
  request: MergeRequest,
): Promise<MergeResult> {
  const { localText, baseText, jiraText } = request;
  // No ancestor means no way to tell our edits from theirs, so Jira's version
  // wins. The same goes for a file that does not exist yet.
  if (localText === undefined || baseText === undefined) {
    return settled(jiraText, localText);
  }
  // Unchanged on our side, or unchanged on Jira's: one side already wins.
  if (localText === baseText) return settled(jiraText, localText);
  if (jiraText === baseText) return settled(localText, localText);
  if (localText === jiraText) return settled(localText, localText);

  const text = await threeWay(request, jiraText);
  return {
    text,
    conflicted: hasConflictMarkers(text),
    changed: text !== localText,
  };
}

function settled(text: string, localText: string | undefined): MergeResult {
  return { text, conflicted: false, changed: text !== localText };
}

/** Parallel merges in one pull would otherwise share a scratch file name. */
let tempSeq = 0;

/**
 * Only the Jira side needs a file, since the other two are already on disk in
 * the shape git expects. The base file in particular must not be regenerated:
 * `merge-file` compares bytes.
 */
async function threeWay(
  request: MergeRequest,
  jiraText: string,
): Promise<string> {
  const dir = join(process.cwd(), TEMP_DIR);
  await mkdir(dir, { recursive: true });
  tempSeq += 1;
  const remote = join(dir, `jira-local-${process.pid}-${tempSeq}.md`);
  try {
    await writeFile(remote, jiraText);
    const { code, stdout, stderr } = await runGit([
      "merge-file",
      "--diff3",
      "-p",
      "-L",
      "local",
      "-L",
      "base",
      "-L",
      "jira",
      request.localPath,
      request.basePath,
      remote,
    ]);
    // 0 is clean, 1-127 is the conflict count, anything else is a failure.
    if (code === null || code > 127) {
      throw new MergeError(
        `git merge-file failed (exit ${code ?? "none"})${
          stderr.trim() ? `: ${stderr.trim()}` : ""
        }`,
      );
    }
    return stdout;
  } finally {
    await rm(remote, { force: true }).catch(() => {});
  }
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", (error) => {
      if ((error as { code?: string }).code === "ENOENT") {
        reject(
          new MergeError(
            "git is required to merge issue files, but was not found on PATH. " +
              "Install git, or pull with --no-merge to overwrite local edits.",
            { cause: error },
          ),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
