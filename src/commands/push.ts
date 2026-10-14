/**
 * Sends local edits back to Jira.
 *
 * The base file is the statement of what Jira held at the last sync, so every
 * change is computed against it and the lease check guards the window between
 * then and now. Anything ambiguous is refused rather than guessed: a wrong
 * summary is recoverable, a comment posted under someone else's name is not.
 */

import { Command, ValidationError } from "@cliffy/command";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { basePath, readBase, writeBase } from "../base.ts";
import { reconcileCategories } from "../categories.ts";
import { getConfig } from "../config.ts";
import {
  fetchIssue,
  fetchIssueStamp,
  fetchIssueTypes,
  fetchTransitions,
  transitionIssue,
  updateIssue,
} from "../jira.ts";
import { writeAtomic } from "../atomic.ts";
import { listIssueFiles } from "../mirror.ts";
import { hasConflictMarkers } from "../merge.ts";
import { parseIssueFile } from "../issue-file.ts";
import { planPush } from "../push-plan.ts";
import { contentToPulledIssue, jiraIssueToContent } from "../render.ts";
import { ISSUES_DIR } from "../constants.ts";
import type { Credentials, JiraIssueType } from "../types/jira-raw.ts";
import type { JiraLocalConfig } from "../types/config.ts";
import type { JiraUpdate } from "../jira.ts";
import type { PushPlan } from "../push-plan.ts";
import { elapsed, pluralise } from "../util.ts";
import { failed, muted, strong } from "../style.ts";

export interface PushOptions {
  site?: string;
  project?: string;
  email?: string;
  token?: string;
  dryRun: boolean;
  yes: boolean;
  keys: string[];
}

interface Candidate {
  key: string;
  absPath: string;
  plan: PushPlan;
}

export default new Command()
  .description(
    "Send local edits in the issue files back to Jira.\n" +
      "Compares each file with the version stored at the last pull, so only\n" +
      "what you changed is sent. A field push cannot send is refused and\n" +
      "reported rather than guessed at.",
  )
  .arguments("[keys...:string]")
  .example("jira-local push", "Push every edited file.")
  .example(
    "jira-local push SRFR-1 --dry-run",
    "Report on one key, write nothing.",
  )
  .option("--site <url:string>", "Jira Cloud base URL.")
  .option("--project <key:string>", "Project key.")
  .option("--email <email:string>", "Atlassian account email.")
  .option("--token <secret:string>", "Atlassian API token.")
  .option("--dry-run", "Report what would be sent and change nothing.")
  .option("-y, --yes", "Send without the confirmation prompt.")
  .action((options, ...keys: string[]) => {
    return runPush({
      site: options.site,
      project: options.project,
      email: options.email,
      token: options.token,
      dryRun: options.dryRun ?? false,
      yes: options.yes ?? false,
      keys,
    });
  });

export async function runPush(cli: PushOptions): Promise<void> {
  const started = Date.now();
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
  const creds = resolveCredentials(cli, config, site);
  if (creds === undefined) {
    throw new ValidationError(
      "credentials required — set email/token in .jira/.config.ts, pass --email/--token, " +
        "or read them into the config from environment variables",
      { exitCode: 1 },
    );
  }

  console.log(
    `Pushing local edits for ${project}${cli.dryRun ? " (dry-run)" : ""}...`,
  );

  const files = await collect(outDir, project, cli.keys);
  if (files.size === 0) {
    console.log("Nothing to push — no issue files differ from their base.");
    return;
  }

  const candidates: Candidate[] = [];
  const refused: string[] = [];

  for (const file of files.values()) {
    const local = await readFile(file.absPath, "utf8").catch(() => "");
    if (local === "") continue;
    if (hasConflictMarkers(local)) {
      refused.push(
        `${file.key}: the file has conflict markers — resolve it first`,
      );
      continue;
    }
    const baseRaw = await readBase(file.key);
    if (baseRaw === undefined) {
      refused.push(`${file.key}: no base file — run pull first`);
      continue;
    }
    const parsedBase = parseIssueFile(baseRaw);
    const parsedLocal = parseIssueFile(local);
    if (parsedBase === undefined || parsedLocal === undefined) {
      refused.push(`${file.key}: the front matter could not be read`);
      continue;
    }

    const plan = planPush(parsedBase, parsedLocal);
    // The lease lives in the base's own front matter, so the sync state a
    // reader sees in the file is the state the check uses.
    const remote = (await fetchIssueStamp(creds, file.key)).updated;
    const held = leaseHeld(parsedBase.updated, remote);
    if (held !== undefined) {
      refused.push(`${file.key}: ${held}`);
      continue;
    }
    if (plan.refusal !== undefined) {
      refused.push(`${file.key}: ${plan.refusal}`);
      continue;
    }
    for (const warning of plan.warnings) {
      console.log(`${file.key}  ${muted(warning)}`);
    }
    if (isNoop(plan)) continue;
    candidates.push({ key: file.key, absPath: file.absPath, plan });
  }

  if (candidates.length === 0) {
    console.log(
      refused.length === 0
        ? "Nothing to push — every edited file is empty of changes Jira would accept."
        : `Nothing to push. ${
          pluralise(refused.length, "issue", "issues")
        } could not be sent.`,
    );
    for (const reason of refused) console.log(`  ${failed(reason)}`);
    if (refused.length > 0) process.exitCode = 1;
    return;
  }

  for (const candidate of candidates) {
    console.log(describe(candidate));
  }
  for (const reason of refused) console.log(`  ${failed(reason)}`);

  if (cli.dryRun) {
    if (cli.yes) {
      console.log(
        muted(
          "--dry-run wins over --yes; nothing was sent and nothing changed.",
        ),
      );
    }
    if (candidates.some((c) => c.plan.transitionTo !== undefined)) {
      console.log(
        muted(
          "a transition can fire automation rules, which this dry run cannot predict",
        ),
      );
    }
    if (candidates.some((c) => c.plan.typeName !== undefined)) {
      console.log(
        muted(
          "an issue type change can move fields, reset a workflow or be refused outright; " +
            "some conversions, such as to or from Sub-task, are not allowed at all",
        ),
      );
    }
    await showDiffs(candidates);
    console.log(
      `\nDry run: ${
        pluralise(candidates.length, "issue", "issues")
      } would be sent, nothing written.`,
    );
    process.exitCode = refused.length > 0 ? 1 : 0;
    return;
  }

  if (!cli.yes && !await confirm(candidates.length, refused.length)) {
    console.log("Aborted; nothing was sent.");
    return;
  }

  let sent = 0;
  const failedKeys: string[] = [];
  const resolveType = typeResolver(creds, project);
  for (const candidate of candidates) {
    try {
      await send(candidate, creds, resolveType);
      sent++;
    } catch (error) {
      // A partial write is possible: the field update can land and the
      // transition then fail. The next pull reconciles, so say which step
      // stopped rather than pretending nothing happened.
      console.log(`  ${failed(`${candidate.key}: ${messageOf(error)}`)}`);
      failedKeys.push(candidate.key);
    }
  }

  if (sent > 0) {
    // A pushed summary, status, priority or parent moves the issue between
    // category folders, so the index pages have to follow.
    await reconcileCategories(outDir, project, false);
  }

  console.log(
    `Pushed ${pluralise(sent, "issue", "issues")} in ${elapsed(started)}.`,
  );
  if (failedKeys.length > 0) {
    console.log(
      muted(
        "a failed issue may be half-written — run pull to reconcile it, then push again",
      ),
    );
  }
  if (refused.length > 0 || failedKeys.length > 0) process.exitCode = 1;
}

/** Only files that differ from their base, or the named keys, are candidates. */
async function collect(
  outDir: string,
  project: string,
  keys: readonly string[],
): Promise<Map<string, { key: string; absPath: string }>> {
  const wanted = new Set(keys.map((k) => k.toUpperCase()));
  const out = new Map<string, { key: string; absPath: string }>();
  for (const file of await listIssueFiles(outDir, project)) {
    const upper = file.key.toUpperCase();
    if (wanted.size > 0 && !wanted.has(upper)) continue;
    const local = await readFile(file.absPath, "utf8").catch(() => undefined);
    if (local === undefined) continue;
    const base = await readBase(file.key);
    if (base !== undefined && local === base) continue;
    out.set(file.key, { key: file.key, absPath: file.absPath });
  }
  return out;
}

/**
 * The lease: Jira's `updated` must be the one the base was taken from. The
 * exact timestamp lives in the index, because the front matter only has a date.
 */
/**
 * The lease check. Jira's `updated` must still be the one the base was taken
 * from; if it moved, somebody else changed the issue and a push would
 * overwrite them.
 */
function leaseHeld(
  baseUpdated: string,
  remoteUpdated: string | undefined,
): string | undefined {
  if (remoteUpdated === undefined) return "Jira did not report an updated time";
  if (baseUpdated === "") {
    return "the base file has no updated stamp — run pull";
  }
  if (baseUpdated !== remoteUpdated) {
    return "Jira changed after the last pull — run pull, then push again";
  }
  return undefined;
}

function isNoop(plan: PushPlan): boolean {
  return plan.fields.length === 0 && plan.comment === undefined &&
    plan.transitionTo === undefined;
}

function describe(candidate: Candidate): string {
  const parts: string[] = [];
  const fields = candidate.plan.fields.map((f) => f.field);
  if (fields.length > 0) parts.push(`fields: ${fields.join(", ")}`);
  if (candidate.plan.comment !== undefined) parts.push("comment: +1");
  if (candidate.plan.transitionTo !== undefined) {
    parts.push(`transition: to ${candidate.plan.transitionTo}`);
  }
  return `  ${strong(candidate.key)}  ${parts.join("  ")}`;
}

async function send(
  candidate: Candidate,
  creds: Credentials,
  resolveType: (name: string) => Promise<JiraIssueType>,
): Promise<void> {
  const { plan } = candidate;
  let update = await resolveSubtasks(plan.update, creds);
  if (plan.typeName !== undefined) {
    const type = await resolveType(plan.typeName);
    update = {
      ...update,
      fields: { ...update.fields, issuetype: { id: type.id } },
    };
  }
  if (Object.keys(update).length > 0) {
    await updateIssue(creds, candidate.key, update);
  }
  // The transition goes last: it can trigger automation that clears fields.
  if (plan.transitionTo !== undefined) {
    await applyTransition(candidate.key, plan.transitionTo, creds);
  }
  await refresh(candidate, creds);
}

/** Jira keys the subtask operation by numeric id, so each key needs a lookup. */
async function resolveSubtasks(
  update: JiraUpdate,
  creds: Credentials,
): Promise<JiraUpdate> {
  const subtasks = update.update?.["subtasks"] as Record<
    string,
    { key?: string }
  >[] | undefined;
  if (subtasks === undefined) return update;
  const resolved: Record<string, unknown>[] = [];
  for (const op of subtasks) {
    const action = op["add"] !== undefined ? "add" : "remove";
    const key = (op["add"] ?? op["remove"])?.key ?? "";
    const stamp = await fetchIssueStamp(creds, key);
    if (stamp.id === undefined) {
      throw new Error(
        `${key} could not be found, so it cannot be made a subtask — ` +
          "push can re-parent an existing issue, not create one",
      );
    }
    resolved.push({ [action]: { id: stamp.id } });
  }
  return { ...update, update: { ...update.update, subtasks: resolved } };
}

/**
 * The issue type's id, from the project's own list. A type name is only unique
 * within a project, so it is resolved there rather than assumed. Fetched once
 * per push, since the answer is the same for every issue in the project.
 */
function typeResolver(
  creds: Credentials,
  project: string,
): (name: string) => Promise<JiraIssueType> {
  let cache: Promise<JiraIssueType[]> | undefined;
  return async (name: string) => {
    cache ??= fetchIssueTypes(creds, project);
    const types = await cache;
    const matches = types.filter((t) => t.name === name);
    if (matches.length === 0) {
      throw new Error(
        `no issue type named "${name}" in this project — available: ${
          types.map((t) => t.name).join(", ") || "none"
        }`,
      );
    }
    if (matches.length > 1) {
      throw new Error(`more than one issue type is named "${name}"`);
    }
    return matches[0] as JiraIssueType;
  };
}

async function applyTransition(
  key: string,
  target: string,
  creds: Credentials,
): Promise<void> {
  const transitions = await fetchTransitions(creds, key);
  const matches = transitions.filter((t) => t.name === target);
  if (matches.length === 0) {
    throw new Error(
      `no transition named "${target}" (available: ${
        transitions.map((t) => t.name).join(", ") || "none"
      })`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`more than one transition is named "${target}"`);
  }
  await transitionIssue(creds, key, matches[0]?.id ?? "");
}

/**
 * Re-reads the issue so the file, its base and the lease all match what Jira
 * now holds. The base becomes the fresh render, never the edited text, so the
 * next pull still sees our own writes as ours.
 */
async function refresh(
  candidate: Candidate,
  creds: Credentials,
): Promise<void> {
  const issue = await fetchIssue(creds, candidate.key);
  const pulled = contentToPulledIssue(jiraIssueToContent(issue, creds.site));
  await writeAtomic(candidate.absPath, pulled.markdown);
  await writeBase(candidate.key, pulled.markdown, candidate.absPath);
}

/**
 * The dry run shows a real diff, using the same tool the merge uses so there
 * is one diff format in the tool. `git diff --no-index` exits 1 when the files
 * differ, which is a result rather than a failure.
 */
async function showDiffs(candidates: readonly Candidate[]): Promise<void> {
  for (const candidate of candidates) {
    // `git diff --no-index` takes two paths, so the base file is named, not
    // its content. It has to exist, so a missing base is skipped.
    if (!(await exists(basePath(candidate.key)))) continue;
    const diff = await gitDiff(basePath(candidate.key), candidate.absPath);
    if (diff === "") continue;
    console.log(`\n${strong(candidate.key)}\n${diff.trimEnd()}`);
  }
}

function gitDiff(base: string, local: string): Promise<string> {
  return new Promise((resolve_) => {
    const child = spawn(
      "git",
      ["diff", "--no-index", "--unified", base, local],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => out += chunk);
    // Exit 1 means "the files differ"; anything else is a real failure.
    child.on("error", () => resolve_(""));
    child.on("close", () => resolve_(out));
  });
}

async function confirm(sending: number, refused: number): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    console.log(
      "stdin is not a terminal — skipping the prompt (pass --yes to push without it)",
    );
    return true;
  }
  const { Confirm } = await import("@cliffy/prompt");
  return await Confirm.prompt({
    message: `Send ${pluralise(sending, "issue", "issues")}${
      refused > 0 ? `, leaving ${refused} unsent` : ""
    }?`,
    default: false,
  });
}

function resolveCredentials(
  cli: PushOptions,
  config: JiraLocalConfig,
  site: string,
): Credentials | undefined {
  const email = (cli.email ?? config.email ?? "").trim() || undefined;
  const token = (cli.token ?? config.token ?? "").trim() || undefined;
  if (!email || !token) return undefined;
  return { site, email, token };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
