/**
 * The cliffy command definition: `jira-local` (sync, the default action) with
 * a `categorize` subcommand. Flag/env resolution is delegated to cliffy; the
 * actions in `run.ts` do the work.
 */

import { Command, ValidationError } from "@cliffy/command";

import { runCategorize, runSync } from "./run.ts";

export interface SyncOptions {
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

export function buildCommand() {
  const syncCommand = new Command()
    .name("jira-local")
    .description(
      "Sync Jira issues into a flat folder of <KEY>.md files and maintain\n" +
        "categorised views of symlinks. With no subcommand, runs a sync.",
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
      "Sync all issues, ignoring the incremental watermark (also the only\n" +
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
      const cli: SyncOptions = {
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
      return runSync(cli);
    });

  return syncCommand
    .command(
      "categorize",
      new Command()
        .description(
          "Re-categorise only (no Jira fetch, no credentials needed):\n" +
            "refresh the category folders of symlinks from the files in the\n" +
            "output directory.",
        )
        .option(
          "--out <dir:string>",
          "Output directory, relative to the project root.",
          { default: ".jira/issues/all" },
        )
        .option("--dry-run", "Print the plan without writing anything.")
        .action((options) => {
          return runCategorize(options.out, options.dryRun ?? false);
        }),
    );
}
