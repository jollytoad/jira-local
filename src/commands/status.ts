/**
 * Read-only report on the working copy. No network, so it is safe to run at
 * any time, and it is the fastest way to see whether a push would do anything.
 */

import { Command } from "@cliffy/command";
import process from "node:process";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import {
  bodyText,
  declarationSources,
  scanDeclarations,
} from "../declarations.ts";
import { declarationRows, rowForDeclaration } from "../create.ts";
import { getConfig } from "../config.ts";
import { hasConflictMarkers } from "../merge.ts";
import { readBase } from "../base.ts";
import { DEFAULT_ISSUE_TYPE, ISSUES_DIR } from "../constants.ts";
import { pluralise } from "../util.ts";
import { failed, muted, strong } from "../style.ts";
import type { ScanResult } from "../declarations.ts";
import type { Declaration } from "../types/jira-local.ts";

type Bucket = "clean" | "edited" | "conflicted" | "baseless" | "declared";

const BUCKETS: readonly Bucket[] = [
  "clean",
  "edited",
  "conflicted",
  "baseless",
  "declared",
];

const LABELS: Record<Bucket, string> = {
  clean: "in sync with its base",
  edited: "edited locally, not yet pushed",
  conflicted: "has conflict markers, needs resolving",
  baseless: "no base file yet, run a pull",
  declared: "declared, not yet created",
};

export default new Command()
  .description(
    "Report which issue files have local edits, conflicts, or no base yet, and\n" +
      "which new issues are declared in them. Read-only: no Jira\n" +
      "connection and nothing written.",
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
  const config = await getConfig();
  const defaultType = config.defaultIssueType?.trim() || DEFAULT_ISSUE_TYPE;

  const found = new Map<string, Bucket>();
  const seen = new Set<string>();
  const declarations: Declaration[] = [];
  const unreadable: string[] = [];

  // One pass, because a file that declares an issue is still an issue file that
  // needs a bucket of its own.
  for (const source of await declarationSources(outDir, "*")) {
    const host = source.hostKey;
    if (host !== undefined) seen.add(host.toUpperCase());
    if (
      wanted.size > 0 && host !== undefined && !wanted.has(host.toUpperCase())
    ) continue;
    const text = await readFile(source.absPath, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const scan = scanDeclarations(text, {
      absPath: source.absPath,
      relPath: source.relPath,
      ...(host === undefined ? {} : { hostKey: host }),
    });

    if (host !== undefined) found.set(host, await bucketOf(host, scan, text));
    if (scan.declarations.length > 0) declarations.push(...scan.declarations);
    // A loose file that declares nothing is a mistake worth naming: the user
    // made a file for this and it would otherwise sit there forever.
    else if (source.standalone && bodyText(text) !== "") {
      unreadable.push(source.relPath);
    }
  }

  for (const key of wanted) {
    if (!seen.has(key)) console.log(`${key}  ${muted("no issue file here")}`);
  }
  if (found.size === 0 && declarations.length === 0) {
    console.log(`No issue files in ${outDir}. Run a pull first.`);
    return;
  }

  const counts = new Map<Bucket, number>();
  const listing = new Map<Bucket, string[]>();
  for (const [key, bucket] of found) {
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    listing.set(bucket, [...(listing.get(bucket) ?? []), key]);
  }
  // Declarations are counted one by one: three headings in a single file are
  // three issues to create, and one number for the file would hide that.
  counts.set("declared", declarations.length);

  console.log(`Issue files in ${outDir}\n`);
  for (const bucket of BUCKETS) {
    const count = counts.get(bucket) ?? 0;
    const mark = bucket === "conflicted" && count > 0 ? failed("*") : " ";
    console.log(
      `  ${mark} ${String(count).padStart(5)}  ${LABELS[bucket]}`,
    );
  }

  for (const bucket of ["conflicted", "edited", "baseless"] as const) {
    const list = listing.get(bucket);
    if (list === undefined || list.length === 0) continue;
    console.log(`\n${strong(`${bucket}:`)} ${summarise(list)}`);
  }

  if (declarations.length > 0) {
    console.log(`\n${strong("declared:")}`);
    for (
      const line of declarationRows(
        declarations.map((declaration) =>
          rowForDeclaration(declaration, defaultType)
        ),
      )
    ) {
      console.log(line);
    }
    console.log(
      muted(
        declarations.some((d) => d.typeHint === undefined)
          ? "a bracketed type is checked against the project when you push"
          : "push creates these, then removes the declarations from the files",
      ),
    );
  }
  for (const path of unreadable) {
    console.log(
      `  ${muted(`${path}  no top-level heading, so nothing is declared`)}`,
    );
  }
}

/**
 * Compared against the file as push reads it, which is without its
 * declarations: writing a new issue into an issue file is not itself an edit to
 * that issue, and reporting it as one would send people hunting for a change
 * that is not there.
 */
async function bucketOf(
  key: string,
  scan: ScanResult,
  text: string,
): Promise<Bucket> {
  const base = await readBase(key);
  if (base === undefined) return "baseless";
  if (hasConflictMarkers(text)) return "conflicted";
  return scan.stripped === base ? "clean" : "edited";
}

function summarise(keys: string[]): string {
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  const shown = sorted.slice(0, 12);
  return shown.length === sorted.length
    ? pluralise(shown.length, "key", "keys") + ` (${shown.join(", ")})`
    : `${shown.join(", ")} and ${sorted.length - shown.length} more`;
}
