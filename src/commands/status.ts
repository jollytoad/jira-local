/**
 * Read-only report on the working copy. No network, so it is safe to run at
 * any time, and it is the fastest way to see whether a push would do anything.
 */

import { Command } from "@cliffy/command";
import process from "node:process";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { listIssueFiles } from "../mirror.ts";
import { hasConflictMarkers } from "../merge.ts";
import { readBase } from "../base.ts";
import { ISSUES_DIR } from "../constants.ts";
import { pluralise } from "../util.ts";
import { failed, muted, strong } from "../style.ts";

type Bucket = "clean" | "edited" | "conflicted" | "baseless";

const BUCKETS: readonly Bucket[] = [
  "clean",
  "edited",
  "conflicted",
  "baseless",
];

const LABELS: Record<Bucket, string> = {
  clean: "in sync with its base",
  edited: "edited locally, not yet pushed",
  conflicted: "has conflict markers, needs resolving",
  baseless: "no base file yet, run a pull",
};

export default new Command()
  .description(
    "Report which issue files have local edits, conflicts, or no base yet.\n" +
      "Read-only: no Jira connection and nothing written.",
  )
  .arguments("[keys...:string]")
  .example("jira-local status", "Report on every issue.")
  .example("jira-local status SRFR-1 SRFR-2", "Report on two keys only.")
  .action((_options, ...keys: string[]) => {
    return runStatus(keys);
  });

export async function runStatus(keys: readonly string[]): Promise<void> {
  const outDir = resolve(process.cwd(), ISSUES_DIR);
  const wanted = new Set(keys.map((key) => key.toUpperCase()));

  const found = new Map<string, Bucket>();
  const seen = new Set<string>();
  for (const file of await listIssueFiles(outDir, "*")) {
    const upper = file.key.toUpperCase();
    seen.add(upper);
    if (wanted.size > 0 && !wanted.has(upper)) continue;
    found.set(file.key, await bucketOf(file.key, file.absPath));
  }

  for (const key of wanted) {
    if (!seen.has(key)) console.log(`${key}  ${muted("no issue file here")}`);
  }
  if (found.size === 0) {
    console.log(`No issue files in ${outDir}. Run a pull first.`);
    return;
  }

  const counts = new Map<Bucket, number>();
  const listing = new Map<Bucket, string[]>();
  for (const [key, bucket] of found) {
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    listing.set(bucket, [...(listing.get(bucket) ?? []), key]);
  }

  console.log(`Issue files in ${outDir}\n`);
  for (const bucket of BUCKETS) {
    const count = counts.get(bucket) ?? 0;
    const mark = bucket === "conflicted" && count > 0 ? failed("*") : " ";
    console.log(
      `  ${mark} ${String(count).padStart(5)}  ${LABELS[bucket]}`,
    );
  }

  for (const bucket of ["conflicted", "edited", "baseless"] as const) {
    const keys = listing.get(bucket);
    if (keys === undefined || keys.length === 0) continue;
    console.log(`\n${strong(`${bucket}:`)} ${summarise(keys)}`);
  }
}

async function bucketOf(key: string, absPath: string): Promise<Bucket> {
  const local = await readFile(absPath, "utf8").catch(() => "");
  const base = await readBase(key);
  if (base === undefined) return "baseless";
  if (hasConflictMarkers(local)) return "conflicted";
  return local === base ? "clean" : "edited";
}

function summarise(keys: string[]): string {
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  const shown = sorted.slice(0, 12);
  return shown.length === sorted.length
    ? pluralise(shown.length, "key", "keys") + ` (${shown.join(", ")})`
    : `${shown.join(", ")} and ${sorted.length - shown.length} more`;
}
