import { Command, ValidationError } from "@cliffy/command";
import process from "node:process";
import { resolve } from "node:path";

import { reconcileCategories } from "../categories.ts";
import { getConfig } from "../config.ts";
import {
  countIssues,
  fetchJiraIssues,
  preflightAuth,
  preflightProject,
  validateFetchResult,
} from "../jira.ts";
import { pruneDeleted, pullIssue, scanLocal } from "../mirror.ts";
import { contentToPulledIssue, jiraIssueToContent } from "../render.ts";
import { loadState, saveState, statePath } from "../state.ts";
import { ISSUES_DIR } from "../constants.ts";
import type { Credentials } from "../types/jira-raw.ts";
import type { PullState } from "../types/jira-local.ts";
import type { JiraLocalConfig } from "../types/config.ts";
import { elapsed } from "../util.ts";
import { progress } from "../progress.ts";

export interface PullOptions {
  site?: string;
  project?: string;
  dryRun: boolean;
  prune: boolean;
  allowEmpty: boolean;
  full: boolean;
  email?: string;
  token?: string;
}

export default new Command()
  .description(
    "Pull Jira issues into a flat folder of <KEY>.md files and generate\n" +
      "categorised index pages.",
  )
  .option(
    "--site <url:string>",
    "Jira Cloud base URL.",
  )
  .option("--project <key:string>", "Project key.")
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
      dryRun: options.dryRun ?? false,
      prune: options.prune ?? true,
      allowEmpty: options.allowEmpty ?? false,
      full: options.full ?? false,
      email: options.email,
      token: options.token,
    };
    return runPull(cli);
  });

export async function runPull(cli: PullOptions): Promise<void> {
  const outDir = resolve(process.cwd(), ISSUES_DIR);

  const config = await getConfig();
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
  progress({ task: "creds", msg: "checking credentials", status: "start" });
  const { timeZone } = await preflightAuth(creds);
  progress({ task: "creds", status: "ok" });
  progress({
    task: "project",
    msg: `checking project ${project}`,
    status: "start",
  });
  await preflightProject(creds, project);
  progress({ task: "project", status: "ok" });

  const stateFile = statePath();
  const previous = await loadState(stateFile);
  const incremental = !cli.full && previous !== undefined &&
    previous.project === project;
  const updatedSince = incremental
    ? overlapWindow(previous!.maxUpdated)
    : undefined;
  if (incremental) {
    progress({
      msg: `incremental pull: issues updated since ${updatedSince}` +
        (previous!.timeZone && previous!.timeZone !== timeZone
          ? ` (previous run tz: ${previous!.timeZone}, now: ${timeZone})`
          : ""),
    });
  } else if (!cli.full && previous === undefined) {
    progress({ msg: "no previous state found: running a full pull" });
  } else if (cli.full) {
    progress({ msg: "--full: running a full pull" });
  }

  const local = await scanLocal(outDir, project);
  const seenKeys = new Set<string>();
  let issueCount = 0;
  let written = 0;
  // Promoted into the state file only once the whole stream finishes cleanly.
  let maxUpdated: string | undefined = previous?.maxUpdated;

  progress({ task: "render", msg: "rendering issues", status: "start" });

  for await (
    const issue of fetchJiraIssues(creds, project, {
      updatedSince,
      sawUpdated: (updated: string) => {
        if (maxUpdated === undefined || updated > maxUpdated) {
          maxUpdated = updated;
        }
      },
    })
  ) {
    const pulled = contentToPulledIssue(jiraIssueToContent(issue, creds.site));
    seenKeys.add(pulled.key);
    issueCount++;
    progress({ task: "render", msg: `issue rendered (${issue.key})`, inc: 1 });
    if (await pullIssue(pulled, local, outDir, cli.dryRun) !== "unchanged") {
      written++;
    }
  }

  progress({ task: "render", msg: "issues rendered", status: "ok" });

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

  // A key missing from the update window is not proof it was deleted.
  let pruned = 0;
  if (cli.prune && !incremental) {
    pruned = await pruneDeleted(local, seenKeys, outDir, cli.dryRun);
  }

  // Pages depend only on issue front matter, so a run that changed nothing has
  // nothing to reconcile. In dry-run they reflect the unchanged files on disk,
  // not the writes the run declined to make.
  if (written > 0 || pruned > 0) {
    await reconcileCategories(outDir, project, cli.dryRun);
  }

  // These rows only ever count, so nothing else would stop their spinners.
  // `stop` drops a row that never counted, keeping a no-op pull quiet.
  progress({ task: "issue-create", msg: "issues created", status: "stop" });
  progress({ task: "issue-update", msg: "issues updated", status: "stop" });
  progress({ task: "issue-delete", msg: "issues deleted", status: "stop" });

  const next: PullState = {
    maxUpdated: truncateToMinute(maxUpdated ?? previous?.maxUpdated ?? ""),
    timeZone,
    lastRun: new Date().toISOString(),
    project,
  };
  if (!cli.dryRun && next.maxUpdated) {
    await saveState(stateFile, next);
  }

  // What the task rows above cannot say: duration, mode, and whether
  // anything was written.
  console.log(
    `${incremental ? "Incremental pull" : "Full pull"} in ${elapsed(started)}${
      incremental ? ` since ${updatedSince}` : ""
    }${cli.dryRun ? " — dry run: no changes written" : ""}.`,
  );
}

/** Flags beat the config file; blank values count as unset. */
function resolveCredentials(
  cli: PullOptions,
  config: JiraLocalConfig,
): Credentials | undefined {
  const email = (cli.email ?? config.email ?? "").trim() || undefined;
  const token = (cli.token ?? config.token ?? "").trim() || undefined;
  if (!email || !token) return undefined;
  return { site: cli.site ?? config.site ?? "", email, token };
}

// Jira renders `updated` in the account's timezone and JQL has no seconds,
// so rewind a minute to catch edits landing in the watermark's own minute.
function overlapWindow(maxUpdated: string): string {
  const d = new Date(`${maxUpdated.replace(" ", "T")}:00`);
  if (Number.isNaN(d.getTime())) return maxUpdated;
  d.setMinutes(d.getMinutes() - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${
    pad(d.getHours())
  }:${pad(d.getMinutes())}`;
}

/** "yyyy-MM-ddTHH:mm:ss.fff+zz" -> "yyyy-MM-dd HH:mm", same timezone. */
function truncateToMinute(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}
