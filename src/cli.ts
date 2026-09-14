import { env } from "./env.ts";

export interface CliOptions {
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

export interface ResolvedCliOptions extends CliOptions {
  site: string;
  project: string;
}

export function parseCli(args: readonly string[]): ResolvedCliOptions {
  const options: Partial<CliOptions> = {};
  const stringFlags = new Set([
    "--site",
    "--project",
    "--out",
    "--email",
    "--token",
  ]);
  const booleanFlags = new Set([
    "--dry-run",
    "--no-prune",
    "--allow-empty",
    "--full",
  ]);
  const seen = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      printHelp();
      Deno.exit(0);
    }
    if (arg === "--") {
      break;
    }
    if (booleanFlags.has(arg)) {
      if (arg === "--dry-run") options.dryRun = true;
      else if (arg === "--allow-empty") options.allowEmpty = true;
      else if (arg === "--full") options.full = true;
      else options.prune = false;
      continue;
    }
    if (!stringFlags.has(arg)) {
      console.error(`error: unknown option "${arg}"`);
      console.error("run with '--help' for usage");
      Deno.exit(1);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`error: ${arg} requires a value`);
      Deno.exit(1);
    }
    if (seen.has(arg)) {
      console.error(`error: ${arg} given more than once`);
      Deno.exit(1);
    }
    seen.add(arg);
    i++;
    if (arg === "--site") options.site = value;
    else if (arg === "--project") options.project = value;
    else if (arg === "--out") options.out = value;
    else if (arg === "--email") options.email = value;
    else if (arg === "--token") options.token = value;
  }

  const rawSite = (options.site ?? env("JIRA_SITE") ?? "").trim();
  if (!rawSite) {
    console.error(
      "error: Jira site URL required — set JIRA_SITE, or pass --site",
    );
    Deno.exit(1);
  }
  if (!URL.canParse(rawSite)) {
    console.error(`error: --site must be a valid URL (got "${rawSite}")`);
    Deno.exit(1);
  }
  const site = rawSite.replace(/\/+$/, "");
  const project = (options.project ?? env("JIRA_PROJECT") ?? "").trim();
  if (!project) {
    console.error(
      "error: project key required — set JIRA_PROJECT, or pass --project",
    );
    Deno.exit(1);
  }

  return {
    site: site.replace(/\/+$/, ""),
    project,
    out: options.out ?? ".jira/issues/all",
    dryRun: options.dryRun ?? false,
    prune: options.prune ?? true,
    allowEmpty: options.allowEmpty ?? false,
    full: options.full ?? false,
    email: options.email,
    token: options.token,
  };
}

function printHelp(): void {
  console.log(`Usage: jira-local [options]

Syncs Jira issues into a flat folder of <KEY>.md files.

Options:
  --site <url>       Jira Cloud base URL (or set JIRA_SITE)
  --project <key>    Project key (or set JIRA_PROJECT)
  --out <dir>        Output directory, relative to the project root (default: .jira/issues/all)
  --email <email>    Atlassian account email (or set JIRA_EMAIL)
  --token <secret>   Atlassian API token (or set JIRA_API_TOKEN)
  --dry-run          Print the plan without writing anything
  --no-prune         Do not delete files for issues no longer present in Jira
  --allow-empty      Permit a zero-issue result (required if the project is
                     legitimately empty; a non-empty project returning 0 issues
                     almost always means an auth/visibility failure)
  --full             Sync all issues, ignoring the incremental watermark
                     (also the only mode that prunes issue files deleted in Jira)
  --help             Show this help

Credentials come from JIRA_EMAIL + JIRA_API_TOKEN env vars unless overridden by
flags. JIRA_API_TOKEN may alternatively be the combined "email:api-token" value.
The Jira site URL and project key come from JIRA_SITE and JIRA_PROJECT unless
overridden by flags.

Requires network (fetch), read, write and env permissions:
  deno run --allow-net --allow-read --allow-write --allow-env src/main.ts`);
}
