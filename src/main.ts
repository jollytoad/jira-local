#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
/**
 * Jira issue sync tool.
 *
 * Fetches all issues for a project from Jira Cloud and lays them out on disk
 * as `.jira/issues/all/<KEY>.md`, pruning files so the local folder mirrors
 * Jira. Streams: pages are fetched while earlier pages render and write.
 *
 * Run via `deno task sync` (from the project root).
 */

import { parseCli } from "./cli.ts";
import { reconcileCategories } from "./categories.ts";
import { env } from "./env.ts";
import {
  JiraApiError,
  JiraAuthError,
  JiraProjectError,
  JiraSearchMismatchError,
} from "./errors.ts";
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
import { resolve } from "node:path";

async function run(args: readonly string[]): Promise<void> {
  const cli = parseCli(args);
  const cwd = Deno.cwd();
  const outDir = resolve(cwd, cli.out);

  if (cli.mode === "categorize") {
    await runCategorize(outDir, cli.dryRun);
    return;
  }

  const email = cli.email ?? readEnv("JIRA_EMAIL");
  const token = readEnv("JIRA_API_TOKEN", cli.token);
  let resolvedToken = token;
  let resolvedEmail = email;

  // Support the combined "email:token" form.
  if (!resolvedEmail && resolvedToken?.includes(":")) {
    const idx = resolvedToken.indexOf(":");
    resolvedEmail = resolvedToken.slice(0, idx);
    resolvedToken = resolvedToken.slice(idx + 1);
  }
  if (!resolvedEmail || !resolvedToken) {
    console.error(
      "error: credentials required — set JIRA_EMAIL and JIRA_API_TOKEN, pass --email/--token, " +
        'or set JIRA_API_TOKEN to "email:api-token"',
    );
    Deno.exit(1);
  }

  const creds: Credentials = {
    site: cli.site,
    email: resolvedEmail,
    token: resolvedToken,
  };

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
      console.error(
        `error: the project returned 0 issues. If ${cli.project} is genuinely empty, ` +
          "pass --allow-empty; otherwise this usually means an auth or visibility failure.",
      );
      Deno.exit(1);
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
async function runCategorize(outDir: string, dryRun: boolean): Promise<void> {
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
  ];
  console.log(
    `Categorised ${pluralise(local.size, "issue", "issues")} — ${
      parts.join(", ")
    } in ${elapsed(started)}${dryRun ? " — dry run: no changes written" : ""}.`,
  );
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

export async function runGuarded(args: readonly string[]): Promise<number> {
  try {
    await run(args);
    return 0;
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) {
      console.error(
        `error: ${error.message}\nRun with the permissions shown in the header of this file, e.g.:\n` +
          "  deno run --allow-net --allow-read --allow-write --allow-env src/main.ts",
      );
      return 1;
    }
    if (error instanceof JiraAuthError || error instanceof JiraProjectError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    if (error instanceof JiraSearchMismatchError) {
      console.error(`error: ${error.message}`);
      console.error(
        "This is usually the search endpoint silently returning an empty result " +
          "(auth/visibility failure) — check the credentials and project key.",
      );
      return 1;
    }
    if (
      error instanceof JiraApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function readEnv(name: string, override?: string): string | undefined {
  const value = override ?? env(name);
  if (!value) return undefined;
  return value.trim() === "" ? undefined : value.trim();
}

function elapsed(started: number): string {
  const secs = (Date.now() - started) / 1000;
  return secs >= 10 ? `${secs.toFixed(0)}s` : `${secs.toFixed(1)}s`;
}

if (import.meta.main) {
  Deno.exit(await runGuarded(Deno.args));
}
