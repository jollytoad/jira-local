/**
 * The `pull` command: fetch issues from Jira and mirror them into the local
 * output folder, then re-categorise. Contains its orchestration (`runPull`)
 * alongside the cliffy command definition.
 */

import { Command, ValidationError } from "@cliffy/command";
import { resolve } from "node:path";

import { reconcileCategories } from "../categories.ts";
import {
  countIssues,
  preflightAuth,
  preflightProject,
  streamIssues,
  validateFetchResult,
} from "../jira.ts";
import { pruneDeleted, pullIssue, scanLocal } from "../pull.ts";
import { loadState, saveState, statePath } from "../state.ts";
import type { Credentials, PullCounters, PullState } from "../types.ts";
import { elapsed, pluralise, progress } from "../util.ts";

export interface PullOptions {
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

export function pullCommand() {
  return new Command()
    .description(
      "Pull Jira issues into a flat folder of <KEY>.md files and maintain\n" +
        "categorised views of symlinks.",
    )
    .env("JIRA_SITE=<site:string>", "Jira Cloud base URL.", { prefix: "JIRA_" })
    .env("JIRA_PROJECT=<project:string>", "Jira project key.", {
      prefix: "JIRA_",
    })
    .env("JIRA_EMAIL=<email:string>", "Atlassian account email.", {
      prefix: "JIRA_",
    })
    .env("JIRA_API_TOKEN=<api-token:string>", "Atlassian API token.", {
      prefix: "JIRA_",
    })
    .option("--site <url:string>", "Jira Cloud base URL (or set JIRA_SITE).")
    .option("--project <key:string>", "Project key (or set JIRA_PROJECT).")
    .option(
      "--out <dir:string>",
      "Output directory, relative to the project root.",
      { default: ".jira/issues/all" },
    )
    .option(
      "--email <email:string>",
      "Atlassian account email (or set JIRA_EMAIL).",
    )
    .option(
      "--token <secret:string>",
      "Atlassian API token (or set JIRA_API_TOKEN).",
    )
    .option("--dry-run", "Print the plan without writing anything.")
    .option(
      "--no-prune",
      "Do not delete files for issues no longer present in Jira.",
    )
    .option(
      "--allow-empty",
      "Permit a zero-issue result (required if the project is legitimately empty).",
    )
    .option(
      "--full",
      "Pull all issues, ignoring the incremental watermark (also the only\n" +
        "mode that prunes issue files deleted in Jira).",
    )
    .action((options) => {
      const site = options.site?.trim();
      const project = options.project?.trim();
      if (!site || !project) {
        throw new ValidationError(
          !site
            ? "Jira site URL required — set JIRA_SITE, or pass --site"
            : "project key required — set JIRA_PROJECT, or pass --project",
          { exitCode: 1 },
        );
      }
      const cli: PullOptions = {
        site: site.replace(/\/+$/, ""),
        project,
        out: options.out,
        dryRun: options.dryRun ?? false,
        prune: options.prune ?? true,
        allowEmpty: options.allowEmpty ?? false,
        full: options.full ?? false,
        email: options.email,
        token: options.apiToken ?? options.token,
      };
      return runPull(cli);
    });
}

export async function runPull(cli: PullOptions): Promise<void> {
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
    `Pulling issues for ${cli.project} from ${cli.site}${
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
      `incremental pull: issues updated since ${updatedSince}` +
        (previous!.timeZone && previous!.timeZone !== timeZone
          ? ` (previous run tz: ${previous!.timeZone}, now: ${timeZone})`
          : ""),
    );
  } else if (!cli.full && previous === undefined) {
    progress("no previous state found: running a full pull");
  } else if (cli.full) {
    progress("--full: running a full pull");
  }

  const local = await scanLocal(outDir, cli.project);
  const counters: PullCounters = {
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
    await pullIssue(issue, local, outDir, cli.dryRun, counters, undefined);
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
      "Project is empty (confirmed by approximate-count); pulling empty state.",
    );
  }

  // Pruning needs full knowledge of the issue set: skip it in incremental
  // mode (a key absent from the update window is not necessarily deleted).
  if (cli.prune && !incremental) {
    await pruneDeleted(local, seenKeys, outDir, cli.dryRun, counters);
  }

  // Refresh category folders (cheap: re-categorises everything in `all/`).
  const categories = await reconcileCategories(local, outDir, cli.dryRun);

  const next: PullState = {
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
    `Pulled ${pluralise(issueCount, "issue", "issues")} — ${
      parts.join(", ")
    } in ${elapsed(started)}${
      incremental ? ` (incremental since ${updatedSince})` : " (full)"
    }${cli.dryRun ? " — dry run: no changes written" : ""}.`,
  );
}

/**
 * Credentials and defaults come from flags or cliffy env vars; the combined
 * "email:token" form of JIRA_API_TOKEN is also supported. Empty/whitespace
 * values are treated as unset.
 */
function resolveCredentials(cli: PullOptions): Credentials | undefined {
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
