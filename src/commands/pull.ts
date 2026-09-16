/**
 * The `pull` command: fetch issues from Jira and mirror them into the local
 * output folder, then re-categorise. Contains its orchestration (`runPull`)
 * alongside the cliffy command definition. Connection settings (site,
 * project, email, token) resolve with precedence flags > `.jira/.config.ts`.
 */

import { Command, ValidationError } from "@cliffy/command";
import { resolve } from "node:path";

import { reconcileCategories } from "../categories.ts";
import { getConfig } from "../config.ts";
import {
  countIssues,
  preflightAuth,
  preflightProject,
  streamIssues,
  validateFetchResult,
} from "../jira.ts";
import { pruneDeleted, pullIssue, scanLocal } from "../pull.ts";
import { loadState, saveState, statePath } from "../state.ts";
import type {
  Credentials,
  JiraLocalConfig,
  PullCounters,
  PullState,
} from "../types.ts";
import { elapsed, pluralise, progress } from "../util.ts";

export interface PullOptions {
  site?: string;
  project?: string;
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
    .option(
      "--site <url:string>",
      "Jira Cloud base URL.",
    )
    .option("--project <key:string>", "Project key.")
    .option(
      "--out <dir:string>",
      "Output directory, relative to the project root.",
      { default: ".jira/issues/all" },
    )
    .option(
      "--email <email:string>",
      "Atlassian account email.",
    )
    .option(
      "--token <secret:string>",
      "Atlassian API token.",
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
      "Pull all issues, rather then an incremental update.",
    )
    .action((options) => {
      const cli: PullOptions = {
        site: options.site,
        project: options.project,
        out: options.out,
        dryRun: options.dryRun ?? false,
        prune: options.prune ?? true,
        allowEmpty: options.allowEmpty ?? false,
        full: options.full ?? false,
        email: options.email,
        token: options.token,
      };
      return runPull(cli);
    });
}

export async function runPull(cli: PullOptions): Promise<void> {
  const cwd = Deno.cwd();
  const outDir = resolve(cwd, cli.out);

  const config = await getConfig(outDir);
  const site = (cli.site ?? config.site ?? "").trim().replace(/\/+$/, "");
  const project = (cli.project ?? config.project ?? "").trim();
  if (!site || !project) {
    throw new ValidationError(
      !site
        ? "Jira site URL required — set site in .jira/.config.ts, or pass --site"
        : "project key required — set project in .jira/.config.ts, or pass --project",
      { exitCode: 1 },
    );
  }
  if (!URL.canParse(site)) {
    throw new ValidationError(
      `site must be a valid URL (got "${site}")`,
      { exitCode: 1 },
    );
  }

  const creds = resolveCredentials(cli, config);
  if (!creds) {
    throw new ValidationError(
      "credentials required — set email/token in .jira/.config.ts, pass --email/--token, " +
        "or read them into the config from environment variables " +
        "(e.g. token: process.env.JIRA_API_TOKEN)",
      { exitCode: 1 },
    );
  }

  const started = Date.now();
  console.log(
    `Pulling issues for ${project} from ${site}${
      cli.dryRun ? " (dry-run)" : ""
    }...`,
  );
  progress("checking credentials...");
  const { timeZone } = await preflightAuth(creds);
  progress("credentials ok");
  progress(`checking project ${project}...`);
  await preflightProject(creds, project);
  progress("project ok");

  const stateFile = statePath(outDir);
  const previous = await loadState(stateFile);
  const incremental = !cli.full && previous !== undefined &&
    previous.project === project;
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

  const local = await scanLocal(outDir, project);
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
    const issue of streamIssues(creds, project, {
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
    const expected = await countIssues(creds, project);
    const verdict = validateFetchResult(issueCount, expected, cli.allowEmpty);
    if (verdict === "refuse-empty") {
      throw new ValidationError(
        `the project returned 0 issues. If ${project} is genuinely empty, ` +
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
    project,
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
 * Credentials come from flags, falling back to the config file; empty or
 * whitespace-only values are treated as unset.
 */
function resolveCredentials(
  cli: PullOptions,
  config: JiraLocalConfig,
): Credentials | undefined {
  const email = (cli.email ?? config.email ?? "").trim() || undefined;
  const token = (cli.token ?? config.token ?? "").trim() || undefined;
  if (!email || !token) return undefined;
  return { site: cli.site ?? config.site ?? "", email, token };
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
