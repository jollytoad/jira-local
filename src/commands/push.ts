/**
 * Sends local edits back to Jira, and creates the issues declared in the files.
 *
 * The base file is the statement of what Jira held at the last sync, so every
 * change is computed against it and the lease check guards the window between
 * then and now. Anything ambiguous is refused rather than guessed: a wrong
 * summary is recoverable, a comment posted under someone else's name is not.
 *
 * Declarations are cut out before anything else reads a file, so adding a new
 * issue to one is not itself an edit to its host. The type is resolved once,
 * and the same type is sent whether the issue ends up a child or a link.
 */

import { Command, ValidationError } from "@cliffy/command";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import { basePath, readBase, writeBase } from "../base.ts";
import { reconcileCategories } from "../categories.ts";
import { getConfig } from "../config.ts";
import { declarationRows, planCreate, rowForPlan } from "../create.ts";
import {
  bodyText,
  declarationSources,
  removeDeclarations,
  scanDeclarations,
} from "../declarations.ts";
import { JiraApiError } from "../errors.ts";
import {
  createIssue,
  fetchChildMap,
  fetchIssue,
  fetchIssueStamp,
  fetchIssueTypes,
  fetchTransitions,
  isParentRefusal,
  linkIssues,
  transitionIssue,
  updateIssue,
} from "../jira.ts";
import { writeAtomic } from "../atomic.ts";
import { hasConflictMarkers } from "../merge.ts";
import { parseIssueFile } from "../issue-file.ts";
import { planPush } from "../push-plan.ts";
import { contentToPulledIssue, jiraIssueToContent } from "../render.ts";
import {
  DEFAULT_ISSUE_TYPE,
  DEFAULT_LINK_TYPE,
  ISSUES_DIR,
  TEMP_DIR,
} from "../constants.ts";
import type { CreateContext, CreatePlan } from "../create.ts";
import type { ScanResult } from "../declarations.ts";
import type { Credentials, JiraIssueType } from "../types/jira-raw.ts";
import type { JiraLocalConfig } from "../types/config.ts";
import type { JiraUpdate } from "../jira.ts";
import type { PushPlan } from "../push-plan.ts";
import type { Declaration } from "../types/jira-local.ts";
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
  /** The file as push reads it, which may be a scratch copy without chunks. */
  diffPath: string;
}

interface Loaded {
  absPath: string;
  relPath: string;
  hostKey?: string;
  /** The file as it is on disk. */
  local: string;
  scan: ScanResult;
  /** The file without its declarations, which is what the diff compares. */
  stripped: string;
  /** Issues whose text a rewrite from Jira would lose nothing of. */
  baseRaw?: string;
}

export default new Command()
  .description(
    "Send local edits in the issue files back to Jira, and create the new\n" +
      "issues declared in them. Compares each file with the version stored at\n" +
      "the last pull, so only what you changed is sent. A field push cannot\n" +
      "send is refused and reported rather than guessed at.",
  )
  .arguments("[keys...:string]")
  .example(
    "jira-local push",
    "Push every edited file and create every declared issue.",
  )
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
  const allDir = resolve(process.cwd(), ISSUES_DIR);
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

  // Fetched once: the answer is the same for every issue and declaration.
  const types = await fetchIssueTypes(creds, project);
  const context: CreateContext = {
    typeNames: types.map((type) => type.name),
    defaultType: config.defaultIssueType?.trim() || DEFAULT_ISSUE_TYPE,
  };
  const linkType = config.newIssueLinkType?.trim() || DEFAULT_LINK_TYPE;

  const wanted = new Set(cli.keys.map((key) => key.toUpperCase()));
  const loaded: Loaded[] = [];
  const candidates: Candidate[] = [];
  const creates: CreatePlan[] = [];
  const refused: string[] = [];
  const scratch: string[] = [];

  try {
    for (const source of await declarationSources(allDir, project)) {
      const host = source.hostKey;
      if (
        wanted.size > 0 && host !== undefined &&
        !wanted.has(host.toUpperCase())
      ) continue;
      const local = await readFile(source.absPath, "utf8").catch(() =>
        undefined
      );
      if (local === undefined) continue;

      const scan = scanDeclarations(local, {
        absPath: source.absPath,
        relPath: source.relPath,
        ...(host === undefined ? {} : { hostKey: host }),
        typeNames: context.typeNames,
      });
      const baseRaw = host === undefined ? undefined : await readBase(host);
      const entry: Loaded = {
        absPath: source.absPath,
        relPath: source.relPath,
        ...(host === undefined ? {} : { hostKey: host }),
        local,
        scan,
        stripped: scan.stripped,
        ...(baseRaw === undefined ? {} : { baseRaw }),
      };
      loaded.push(entry);

      // A conflicted file is half one version and half another, so there is no
      // telling what it now declares. Nothing from it is read or sent.
      if (host !== undefined && hasConflictMarkers(local)) {
        refused.push(
          `${host}: the file has conflict markers — resolve it first`,
        );
        continue;
      }

      for (const declaration of scan.declarations) {
        const plan = planCreate(declaration, context);
        if (plan.refusal !== undefined) {
          refused.push(`${whereOf(declaration)}: ${plan.refusal}`);
        } else {
          creates.push(plan);
        }
      }

      if (host === undefined) continue;
      // A file that only carries declarations has no edit to send, and asking
      // Jira about it would be a request for nothing.
      if (baseRaw !== undefined && scan.stripped === baseRaw) continue;

      // Asked before the base check, because a file named like a key that Jira
      // has never heard of is a mistake worth naming in those words rather than
      // as a missing base.
      let remote: string | undefined;
      try {
        remote = (await fetchIssueStamp(creds, host)).updated;
      } catch (error) {
        if (error instanceof JiraApiError && error.status === 404) {
          refused.push(
            `${host}: Jira has no issue with that key — an issue key cannot be ` +
              "chosen, so rename the file to anything else and its top-level " +
              "headings will declare a new issue instead",
          );
          continue;
        }
        throw error;
      }
      if (baseRaw === undefined) {
        refused.push(`${host}: no base file — run pull first`);
        continue;
      }

      const parsedBase = parseIssueFile(baseRaw);
      const parsedLocal = parseIssueFile(scan.stripped);
      if (parsedBase === undefined || parsedLocal === undefined) {
        refused.push(`${host}: the front matter could not be read`);
        continue;
      }

      const plan = planPush(parsedBase, parsedLocal);
      // The lease lives in the base's own front matter, so the sync state a
      // reader sees in the file is the state the check uses.
      const held = leaseHeld(parsedBase.updated, remote);
      if (held !== undefined) {
        refused.push(`${host}: ${held}`);
        continue;
      }
      if (plan.refusal !== undefined) {
        refused.push(`${host}: ${plan.refusal}`);
        continue;
      }
      for (const warning of plan.warnings) {
        console.log(`${host}  ${muted(warning)}`);
      }
      if (isNoop(plan)) continue;
      candidates.push({
        key: host,
        absPath: source.absPath,
        plan,
        diffPath: await scratchCopy(scratch, scan.stripped),
      });
    }

    if (candidates.length === 0 && creates.length === 0) {
      console.log(
        refused.length === 0
          ? "Nothing to push — no issue files differ from their base, and nothing is declared."
          : `Nothing to push. ${
            pluralise(refused.length, "change", "changes")
          } could not be sent.`,
      );
      for (const reason of refused) console.log(`  ${failed(reason)}`);
      if (refused.length > 0) process.exitCode = 1;
      return;
    }

    for (const candidate of candidates) console.log(describe(candidate));
    if (creates.length > 0) {
      console.log(`\n${strong(`new issues (${creates.length}):`)}`);
      for (const line of declarationRows(creates.map(rowForPlan))) {
        console.log(line);
      }
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
        } would be sent and ${
          pluralise(creates.length, "issue", "issues")
        } created, nothing written.`,
      );
      process.exitCode = refused.length > 0 ? 1 : 0;
      return;
    }

    if (
      !cli.yes &&
      !await confirm(candidates.length + creates.length, refused.length)
    ) {
      console.log("Aborted; nothing was sent.");
      return;
    }

    const written = await send(candidates, creates, loaded, {
      creds,
      project,
      allDir,
      linkType,
      types,
    });
    console.log(
      `Pushed ${pluralise(written.sent, "issue", "issues")}, created ${
        pluralise(written.created, "issue", "issues")
      } in ${elapsed(started)}.`,
    );
    if (refused.length > 0 || written.failed > 0) process.exitCode = 1;
  } finally {
    for (const path of scratch) await rm(path, { force: true }).catch(() => {});
  }
}

interface SendContext {
  creds: Credentials;
  project: string;
  allDir: string;
  linkType: string;
  types: readonly JiraIssueType[];
}

interface SendResult {
  sent: number;
  created: number;
  failed: number;
}

/**
 * Updates first, then creations, then one refresh of everything that changed.
 * The order matters in one place: a host is re-read only after its children
 * exist, so the child list it gains is the finished one.
 */
async function send(
  candidates: readonly Candidate[],
  creates: readonly CreatePlan[],
  loaded: readonly Loaded[],
  ctx: SendContext,
): Promise<SendResult> {
  const resolveType = typeResolver(ctx.types);
  const updated = new Set<string>();
  let sent = 0;
  let failedCount = 0;

  for (const candidate of candidates) {
    try {
      await sendUpdate(candidate, ctx.creds, resolveType);
      sent++;
      updated.add(candidate.key);
    } catch (error) {
      // A partial write is possible: the field update can land and the
      // transition then fail. The next pull reconciles, so say which step
      // stopped rather than pretending nothing happened.
      console.log(`  ${failed(`${candidate.key}: ${messageOf(error)}`)}`);
      failedCount++;
    }
  }

  const created = new Set<string>();
  const hosts = new Set<string>();
  /** absPath -> the declaration lines that have become issues. */
  const cut = new Map<string, Set<number>>();

  for (const plan of creates) {
    try {
      const outcome = await createOne(plan, ctx, resolveType);
      created.add(outcome.key);
      if (plan.parentKey !== undefined) hosts.add(plan.parentKey);
      const lines = cut.get(plan.source.absPath) ?? new Set<number>();
      lines.add(plan.source.line);
      cut.set(plan.source.absPath, lines);
      if (outcome.linked && plan.parentKey !== undefined) {
        console.log(
          `  ${
            muted(
              `${outcome.key} could not be a child of ${plan.parentKey}, so it was linked instead`,
            )
          }`,
        );
      }
    } catch (error) {
      console.log(
        `  ${failed(`${whereOf(plan.source)}: ${messageOf(error)}`)}`,
      );
      failedCount++;
    }
  }

  if (created.size > 0) {
    // The issues folder may not exist at all, if this is the first thing to
    // arrive in a fresh checkout.
    await mkdir(ctx.allDir, { recursive: true });
  }
  // Read once for the whole run: the same map answers for every refreshed key,
  // and it is what makes `children` mean Parent rather than Sub-task.
  const childMap = sent > 0 || created.size > 0
    ? await fetchChildMap(ctx.creds, ctx.project)
    : new Map<string, string[]>();

  for (const key of created) {
    try {
      await writeIssue(
        ctx.creds,
        key,
        join(ctx.allDir, `${key}.md`),
        [],
        childMap,
      );
    } catch (error) {
      console.log(
        `  ${
          failed(
            `${key} was created but could not be read back: ${
              messageOf(error)
            }`,
          )
        }`,
      );
      failedCount++;
    }
  }

  for (const entry of loaded) {
    const key = entry.hostKey;
    if (key === undefined) continue;
    const gone = cut.get(entry.absPath) ?? new Set<number>();
    const keep = entry.scan.declarations.filter((d) => !gone.has(d.line));
    if (!updated.has(key) && !hosts.has(key)) continue;
    // Re-reading a host whose own edits are still unsent would throw them away,
    // so a stale child list waits for the next pull instead.
    if (!updated.has(key) && entry.baseRaw !== entry.stripped) {
      console.log(
        `  ${
          muted(
            `${key} gained a new issue, but its file was left as it is because its own edits are still unsent; a pull reconciles it`,
          )
        }`,
      );
      continue;
    }
    try {
      await writeIssue(ctx.creds, key, entry.absPath, keep, childMap);
    } catch (error) {
      console.log(`  ${failed(`${key}: ${messageOf(error)}`)}`);
      failedCount++;
    }
  }

  // A loose file that held only declarations goes once they are all issues.
  // One that still holds notes stays, because those notes are the user's.
  for (const entry of loaded) {
    if (entry.hostKey !== undefined) continue;
    const gone = cut.get(entry.absPath);
    if (gone === undefined || gone.size === 0) continue;
    const text = removeDeclarations(entry.local, {
      absPath: entry.absPath,
      relPath: entry.relPath,
    }, [...gone]);
    try {
      if (bodyText(text) === "") await rm(entry.absPath, { force: true });
      else await writeAtomic(entry.absPath, withNewline(text));
    } catch (error) {
      console.log(
        `  ${failed(`${entry.relPath}: ${messageOf(error)}`)}`,
      );
      failedCount++;
    }
  }

  if (sent > 0 || created.size > 0) {
    // A pushed or created issue moves between category folders, so the index
    // pages have to follow.
    await reconcileCategories(ctx.allDir, ctx.project, false);
  }

  if (failedCount > 0) {
    console.log(
      muted(
        "a failed issue may be half-written — run pull to reconcile it, then push again",
      ),
    );
  }

  return { sent, created: created.size, failed: failedCount };
}

/**
 * Re-reads the issue so the file, its base and the lease all match what Jira
 * now holds. The base becomes the fresh render, never the local text and never
 * the declarations, so the next pull still sees our own writes as ours.
 *
 * `children` comes from a project-wide map rather than from `subtasks`, so the
 * Epic that just gained a child says so in its own file.
 */
async function writeIssue(
  creds: Credentials,
  key: string,
  absPath: string,
  keep: readonly Declaration[] = [],
  children: ReadonlyMap<string, string[]> = new Map(),
): Promise<void> {
  const issue = await fetchIssue(creds, key);
  const pulled = contentToPulledIssue(
    jiraIssueToContent(issue, creds.site, children.get(key)),
  );
  // Declarations that were not created go back on the end, so re-reading the
  // issue never drops text the user wrote.
  const text = keep.length === 0
    ? pulled.markdown
    : `${pulled.markdown}\n\n${keep.map((d) => d.chunk).join("\n\n")}\n`;
  await writeAtomic(absPath, text);
  await writeBase(key, pulled.markdown);
}

async function sendUpdate(
  candidate: Candidate,
  creds: Credentials,
  resolveType: (name: string) => JiraIssueType,
): Promise<void> {
  const { plan } = candidate;
  const children = await resolveChildren(plan.update, candidate.key, creds);
  let update = children.update;
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
  // A real child — anything but a Sub-task — is attached by writing the Parent
  // on the child itself, which is a different issue from the one being pushed.
  for (const childKey of children.reparent) {
    await updateIssue(creds, childKey, {
      fields: { parent: { key: candidate.key } },
    });
  }
  // The transition goes last: it can trigger automation that clears fields.
  if (plan.transitionTo !== undefined) {
    await applyTransition(candidate.key, plan.transitionTo, creds);
  }
}

/**
 * Creates the issue, as a child of the file it was declared in. Jira has no way
 * to ask in advance whether a type may hold children — a classic project only
 * lets an Epic, a team-managed one is open — so the parent is sent and a
 * refusal over it is the answer, at which point the relationship becomes a
 * link instead.
 *
 * The type is resolved once and sent in both attempts: a fallback that quietly
 * changed the type would create something nobody asked for.
 */
async function createOne(
  plan: CreatePlan,
  ctx: SendContext,
  resolveType: (name: string) => JiraIssueType,
): Promise<{ key: string; linked: boolean }> {
  const type = await resolveType(plan.typeName);
  const fields: Record<string, unknown> = {
    project: { key: ctx.project },
    summary: plan.summary,
    issuetype: { id: type.id },
    ...(plan.description === undefined
      ? {}
      : { description: plan.description }),
  };
  if (plan.parentKey === undefined) {
    return { key: (await createIssue(ctx.creds, fields)).key, linked: false };
  }
  fields["parent"] = { key: plan.parentKey };

  let key: string;
  try {
    key = (await createIssue(ctx.creds, fields)).key;
    return { key, linked: false };
  } catch (error) {
    if (!isParentRefusal(error)) throw error;
    if (type.subtask) {
      // Neither path can work, so say both halves rather than reporting the
      // second failure on its own.
      throw new Error(
        `${plan.summary}: ${plan.parentKey} cannot hold a ${type.name}, and a ` +
          `${type.name} cannot be created without a parent — give this heading ` +
          "a different [Type], or declare it in a file of its own",
      );
    }
    delete fields["parent"];
    key = (await createIssue(ctx.creds, fields)).key;
  }

  try {
    await linkIssues(ctx.creds, key, plan.parentKey as string, ctx.linkType);
  } catch (error) {
    throw new Error(
      `${key} was created but linking it to ${plan.parentKey} failed: ${
        messageOf(error)
      }`,
    );
  }
  return { key, linked: true };
}

/**
 * Resolves the `children` edits into something Jira accepts.
 *
 * The subtask operation is keyed by numeric id and only works for a Sub-task,
 * so each key needs a lookup to find out what it is. A real child — an Epic's
 * Story or Task — is attached by writing Parent on the child itself, so those
 * come back separately. Un-attaching one is not possible: the API reports no
 * `remove` operation for Parent, the same limit as clearing a parent by hand.
 */
async function resolveChildren(
  update: JiraUpdate,
  parentKey: string,
  creds: Credentials,
): Promise<{ update: JiraUpdate; reparent: string[] }> {
  const ops = update.update?.["subtasks"] as Record<
    string,
    { key?: string }
  >[] | undefined;
  if (ops === undefined) return { update, reparent: [] };
  const resolved: Record<string, unknown>[] = [];
  const reparent: string[] = [];
  for (const op of ops) {
    const action = op["add"] !== undefined ? "add" : "remove";
    const key = (op["add"] ?? op["remove"])?.key ?? "";
    const stamp = await fetchIssueStamp(creds, key);
    if (stamp.id === undefined) {
      throw new Error(
        `${key} could not be found, so it cannot be made a child of ` +
          `${parentKey} — push can re-parent an existing issue, not create one`,
      );
    }
    if (stamp.subtask === true) {
      resolved.push({ [action]: { id: stamp.id } });
      continue;
    }
    if (action === "remove") {
      throw new Error(
        `${key} is a ${
          stamp.typeName ?? "non Sub-task"
        }, so it cannot be taken ` +
          `off ${parentKey} — Jira has no way to clear a Parent through the API; ` +
          "set the child's own parent instead",
      );
    }
    reparent.push(key);
  }
  if (resolved.length === 0) {
    const { subtasks: _dropped, ...rest } = update.update ?? {};
    return {
      update: Object.keys(rest).length === 0
        ? { ...update, update: undefined }
        : { ...update, update: rest },
      reparent,
    };
  }
  return {
    update: { ...update, update: { ...update.update, subtasks: resolved } },
    reparent,
  };
}

/**
 * The issue type's id, from the project's own list. A type name is only unique
 * within a project, so it is resolved there rather than assumed.
 */
function typeResolver(
  types: readonly JiraIssueType[],
): (name: string) => JiraIssueType {
  return (name: string) => {
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
    const diff = await gitDiff(basePath(candidate.key), candidate.diffPath);
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

/**
 * A copy of the file as push reads it, which is the file without its
 * declarations. Diffing against the file on disk would show every declaration
 * as a deletion, which is the opposite of what happens.
 */
async function scratchCopy(scratch: string[], text: string): Promise<string> {
  const dir = join(process.cwd(), TEMP_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `push-diff-${process.pid}-${scratch.length}.md`);
  await writeAtomic(path, withNewline(text));
  scratch.push(path);
  return path;
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

function whereOf(declaration: Declaration): string {
  return `${declaration.relPath}:${declaration.line}`;
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
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
