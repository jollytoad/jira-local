/**
 * Sync and categorize orchestration, invoked by the cliffy command actions
 * in `cli.ts`.
 */

import { ValidationError } from "@cliffy/command";
import { resolve } from "node:path";

import { reconcileCategories } from "./categories.ts";
import {
  countIssues,
  preflightAuth,
  preflightProject,
  streamIssues,
  validateFetchResult,
} from "./jira.ts";
import { pruneDeleted, scanLocal, syncIssue } from "./sync.ts";
import { loadState, saveState, statePath } from "./state.ts";
import type { Credentials, SyncCounters, SyncState } from "./types.ts";
import { pluralise, progress } from "./util.ts";

export interface SyncCliOptions {
  site: string;
  project: string;
  out: string;
  dryRun: boolean;
  prune: boolean;
  allowEmpty: boolean;
  full: boolean;
  email?: string;
  token?: string;
}

export async function runSync(cli: SyncCliOptions): Promise<void> {
  const cwd = Deno.cwd();
  const outDir = resolve(cwd, cli.out);

  const creds = resolveCredentials(cli);
  if (!creds) {
    throw new ValidationError(
      "credentials required — set JIRA_EMAIL and JIRA_API_TOKEN, pass --email/--token, " +
        'or set JIRA_API_TOKEN to "email:api-token"',
      { exitCode: 1 },
    );
  }

  const started = Date.now();
  console.log(
    `Fetching issues for ${cli.project} from ${cli.site}${
      cli.dryRun ? " (dry-run)" : ""
    }...`,
  );
  progress("checking credentials...");
  const { timeZone } = await preflightAuth(creds);
  progress("credentials ok");
  progress(`checking project ${cli.project}...`);
  await preflightProject(creds, cli.project);
  progress("project ok");

  const stateFile = statePath(outDir);
  const previous = await loadState(stateFile);
  const incremental = !cli.full && previous !== undefined &&
    previous.project === cli.project;
  const updatedSince = incremental
    ? overlapWindow(previous!.maxUpdated)
    : undefined;
  if (incremental) {
    progress(
      `incremental sync: issues updated since ${updatedSince}` +
        (previous!.timeZone && previous!.timeZone !== timeZone
          ? ` (previous run tz: ${previous!.timeZone}, now: ${timeZone})`
          : ""),
    );
  } else if (!cli.full && previous === undefined) {
    progress("no previous state found: running a full sync");
  } else if (cli.full) {
    progress("--full: running a full sync");
  }

  const local = await scanLocal(outDir, cli.project);
  const counters: SyncCounters = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
  };
  const seenKeys = new Set<string>();
  let issueCount = 0;
  // Watermark candidate: newest `updated` seen this run. Only promoted into
  // the state file after the whole stream completes without error.
  let maxUpdated: string | undefined = previous?.maxUpdated;

  for await (
    const issue of streamIssues(creds, cli.project, {
      updatedSince,
      sawUpdated: (updated: string) => {
        if (maxUpdated === undefined || updated > maxUpdated) {
          maxUpdated = updated;
        }
      },
    })
  ) {
    seenKeys.add(issue.key);
    issueCount++;
    await syncIssue(issue, local, outDir, cli.dryRun, counters, undefined);
  }

  if (issueCount === 0 && !incremental) {
    const expected = await countIssues(creds, cli.project);
    const verdict = validateFetchResult(issueCount, expected, cli.allowEmpty);
    if (verdict === "refuse-empty") {
      throw new ValidationError(
        `the project returned 0 issues. If ${cli.project} is genuinely empty, ` +
          "pass --allow-empty; otherwise this usually means an auth or visibility failure.",
        { exitCode: 1 },
      );
    }
    console.log(
      "Project is empty (confirmed by approximate-count); syncing empty state.",
    );
  }

  // Pruning needs full knowledge of the issue set: skip it in incremental
  // mode (a key absent from the update window is not necessarily deleted).
  if (cli.prune && !incremental) {
    await pruneDeleted(local, seenKeys, outDir, cli.dryRun, counters);
  }

  // Refresh category folders (cheap: re-categorises everything in `all/`).
  const categories = await reconcileCategories(local, outDir, cli.dryRun);

  const next: SyncState = {
    maxUpdated: truncateToMinute(maxUpdated ?? previous?.maxUpdated ?? ""),
    timeZone,
    lastRun: new Date().toISOString(),
    project: cli.project,
  };
  if (!cli.dryRun && next.maxUpdated) {
    await saveState(stateFile, next);
  }

  const parts = [
    `${counters.created} created`,
    `${counters.updated} updated`,
    `${counters.deleted} deleted`,
    `${counters.unchanged} unchanged`,
    `${categories.linksCreated + categories.linksRetargeted} links changed`,
    `${categories.linksRemoved} links removed`,
    `${categories.indexesCreated + categories.indexesUpdated} indexes changed`,
    `${categories.indexesRemoved} indexes removed`,
  ];
  console.log(
    `Synced ${pluralise(issueCount, "issue", "issues")} — ${
      parts.join(", ")
    } in ${elapsed(started)}${
      incremental ? ` (incremental since ${updatedSince})` : " (full)"
    }${cli.dryRun ? " — dry run: no changes written" : ""}.`,
  );
}

/**
 * Standalone re-categorisation: refresh the category folders of symlinks
 * from the files already present in `all/`. No network, no credentials, no
 * state file — a purely local reconcile.
 */
export async function runCategorize(
  outDir: string,
  dryRun: boolean,
): Promise<void> {
  const started = Date.now();
  console.log(
    `Re-categorising issues in ${outDir}${dryRun ? " (dry-run)" : ""}...`,
  );
  const local = await scanLocal(outDir, "*");
  const counters = await reconcileCategories(local, outDir, dryRun);
  const parts = [
    `${counters.linksCreated} created`,
    `${counters.linksRetargeted} retargeted`,
    `${counters.linksRemoved} removed`,
    `${counters.linksUnchanged} unchanged`,
    `${counters.dirsCreated} folders created`,
    `${counters.dirsRemoved} folders removed`,
    `${counters.indexesCreated + counters.indexesUpdated} indexes changed`,
    `${counters.indexesRemoved} indexes removed`,
  ];
  console.log(
    `Categorised ${pluralise(local.size, "issue", "issues")} — ${
      parts.join(", ")
    } in ${elapsed(started)}${dryRun ? " — dry run: no changes written" : ""}.`,
  );
}

/**
 * Credentials and defaults come from flags or cliffy env vars; the combined
 * "email:token" form of JIRA_API_TOKEN is also supported. Empty/whitespace
 * values are treated as unset.
 */
function resolveCredentials(cli: SyncCliOptions): Credentials | undefined {
  let email = cli.email?.trim() === "" ? undefined : cli.email?.trim();
  let token = cli.token?.trim() === "" ? undefined : cli.token;

  // Support the combined "email:token" form.
  if (!email && token?.includes(":")) {
    const idx = token.indexOf(":");
    email = token.slice(0, idx);
    token = token.slice(idx + 1);
  }
  if (!email || !token) return undefined;
  return { site: cli.site, email, token };
}

/**
 * Jira renders `updated` in the account's timezone; the watermark is stored
 * and queried in that same format. A minute of overlap absorbs edits that
 * land in the same minute as the previous watermark (JQL has no seconds).
 */
function overlapWindow(maxUpdated: string): string {
  const d = new Date(`${maxUpdated.replace(" ", "T")}:00`);
  if (Number.isNaN(d.getTime())) return maxUpdated;
  d.setMinutes(d.getMinutes() - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${
    pad(d.getHours())
  }:${pad(d.getMinutes())}`;
}

/** "yyyy-MM-ddTHH:mm:ss.fff+zz" (Jira) -> "yyyy-MM-dd HH:mm" (same tz). */
function truncateToMinute(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

function elapsed(started: number): string {
  const secs = (Date.now() - started) / 1000;
  return secs >= 10 ? `${secs.toFixed(0)}s` : `${secs.toFixed(1)}s`;
}
