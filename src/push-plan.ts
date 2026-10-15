/**
 * What changed between the base file and the edited working copy, expressed as
 * the payloads Jira expects.
 *
 * The base is the only trustworthy statement of what Jira held, so every
 * decision is a comparison against it. A field that reads the same in both is
 * not sent, which is what keeps an untouched description out of the request
 * and off the lossy markdown-to-ADF path entirely.
 */

import { markdownToAdf, MarkdownUnsupportedError } from "./markdown-to-adf.ts";
import type { AdfNode } from "./types/adf.ts";
import {
  appendedComment,
  titleSummary,
  truncateComments,
} from "./issue-file.ts";
import type { ParsedIssue } from "./issue-file.ts";
import type { JiraUpdate } from "./jira.ts";

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface PushPlan {
  key: string;
  update: JiraUpdate;
  /** Fields whose values differ, for the summary line. */
  fields: FieldChange[];
  /** A new comment to post, as markdown. */
  comment?: string;
  /** The status to move to, resolved later against the transition list. */
  transitionTo?: string;
  /**
   * The requested issue type by name. Resolved to an id against the project's
   * own list, so the payload names a type that certainly exists.
   */
  typeName?: string;
  /** Non-fatal notices: a read-only field was edited, or the H1 disagrees. */
  warnings: string[];
  /** Fatal for this issue. Nothing is sent. */
  refusal?: string;
}

/** Front matter a push may write. Everything else is reported and dropped. */
const READ_ONLY = new Set([
  "key",
  "assignee",
  "reporter",
  "statusCategory",
  "created",
  "updated",
  "url",
  "linked",
]);

export function planPush(
  base: ParsedIssue,
  local: ParsedIssue,
): PushPlan {
  const key = local.key || base.key;
  const warnings: string[] = [];
  // Compared without the appended tail, or every new comment would read as an
  // edit to the last one.
  const localComments = truncateComments(local, base.commentsRaw.length);
  const refusal = reasonToRefuse(base, localComments);
  if (refusal !== undefined) {
    return { key, update: {}, fields: [], warnings, refusal };
  }

  const fields: FieldChange[] = [];
  const payload: Record<string, unknown> = {};
  const subtasks: Record<string, unknown>[] = [];

  const resolved = resolveSummary(base, local, key);
  if (resolved.refusal !== undefined) {
    return { key, update: {}, fields: [], warnings, refusal: resolved.refusal };
  }
  if (resolved.summary !== undefined) {
    fields.push({
      field: "summary",
      from: base.summary,
      to: resolved.summary,
    });
    payload["summary"] = resolved.summary;
  }
  if (!sameList(local.labels, base.labels)) {
    fields.push({
      field: "labels",
      from: base.labels.join(", "),
      to: local.labels.join(", "),
    });
    payload["labels"] = local.labels;
  }
  if (local.priority !== base.priority) {
    fields.push({ field: "priority", from: base.priority, to: local.priority });
    payload["priority"] = local.priority === ""
      ? { name: null }
      : { name: local.priority };
  }
  if (local.parent !== base.parent) {
    if (local.parent === "") {
      // Jira reports `operations: ["set"]` for parent and no `remove`, so a
      // blanked field can only ever earn an error nobody can satisfy.
      return {
        key,
        update: {},
        fields: [],
        warnings,
        refusal:
          "a parent cannot be cleared — Jira has no way to remove one through the API; " +
          "put another parent in the field, or leave it as it is",
      };
    }
    fields.push({ field: "parent", from: base.parent, to: local.parent });
    payload["parent"] = { key: local.parent };
  }

  const added = local.children.filter((k) => !base.children.includes(k));
  const removed = base.children.filter((k) => !local.children.includes(k));
  if (added.length > 0 || removed.length > 0) {
    fields.push({
      field: "children",
      from: base.children.join(", "),
      to: local.children.join(", "),
    });
    // Left as keys: Jira's subtask operation is keyed by numeric id, and the
    // caller resolves each key with one lookup before sending.
    subtasks.push(...added.map((key) => ({ add: { key } })));
    subtasks.push(...removed.map((key) => ({ remove: { key } })));
  }

  // Only an edited description is converted. An untouched one never reaches
  // markdown-to-ADF, which is what keeps the lossy direction off the table
  // for every issue nobody is working on.
  if (local.description !== base.description) {
    fields.push({
      field: "description",
      from: summarise(base.description),
      to: summarise(local.description),
    });
    try {
      payload["description"] = markdownToAdf(local.description);
    } catch (error) {
      if (error instanceof MarkdownUnsupportedError) {
        return {
          key,
          update: {},
          fields: [],
          warnings,
          refusal: `description: ${error.message}`,
        };
      }
      throw error;
    }
  }

  let typeName: string | undefined;
  if (local.type !== base.type) {
    if (local.type === "") {
      return {
        key,
        update: {},
        fields: [],
        warnings,
        refusal: "type cannot be blanked",
      };
    }
    fields.push({ field: "type", from: base.type, to: local.type });
    // Left as a name: a type name is only unique within a project, so the
    // caller resolves it to an id against the project's own list.
    typeName = local.type;
  }

  let transitionTo: string | undefined;
  if (local.status !== base.status) {
    if (local.status === "") {
      return {
        key,
        update: {},
        fields: [],
        warnings,
        refusal: "status cannot be blanked",
      };
    }
    fields.push({ field: "status", from: base.status, to: local.status });
    transitionTo = local.status;
  }

  for (const name of READ_ONLY) {
    const before = valueOf(base, name);
    const after = valueOf(local, name);
    if (before !== after) {
      warnings.push(`${name} is read-only; the local edit to it is ignored`);
    }
  }

  const appended = appendedComment(base, local);
  let commentBody: AdfNode | undefined;
  if (appended !== "") {
    try {
      commentBody = markdownToAdf(appended);
    } catch (error) {
      if (error instanceof MarkdownUnsupportedError) {
        return {
          key,
          update: {},
          fields: [],
          warnings,
          refusal: `comment: ${error.message}`,
        };
      }
      throw error;
    }
  }
  const comment = appended === "" ? undefined : appended;

  const update: JiraUpdate = {};
  if (Object.keys(payload).length > 0) update.fields = payload;
  const operations: Record<string, unknown> = {};
  if (subtasks.length > 0) operations["subtasks"] = subtasks;
  // The comment rides in the same PUT, so a failed write posts nothing.
  if (commentBody !== undefined) {
    operations["comment"] = [{ add: { body: commentBody } }];
  }
  if (Object.keys(operations).length > 0) update.update = operations;

  return {
    key,
    update,
    fields,
    comment,
    transitionTo,
    typeName,
    warnings,
    refusal,
  };
}

/**
 * A summary lives in two places in the file, and either one is enough to change
 * it. Whichever moved against the base is the one that counts, so editing the
 * title line alone works exactly as editing the front matter alone does — and
 * the refresh afterwards rewrites the other, so the file settles on one answer.
 *
 * Only a file where both moved to *different* texts is ambiguous, and that is
 * refused rather than guessed at: there is no way to tell which one the author
 * meant.
 */
function resolveSummary(
  base: ParsedIssue,
  local: ParsedIssue,
  key: string,
): { summary?: string; refusal?: string } {
  const titleChanged = local.title !== base.title;
  const frontChanged = local.summary !== base.summary;
  if (!titleChanged && !frontChanged) return {};
  if (!titleChanged) return { summary: local.summary };

  const fromTitle = titleSummary(local.title, key);
  if (fromTitle === undefined) {
    return { refusal: "the title line carries no summary text" };
  }
  if (frontChanged && fromTitle !== local.summary) {
    return {
      refusal: `the title line says "${fromTitle}" but the summary says ` +
        `"${local.summary}" — change one of them, not both`,
    };
  }
  const summary = frontChanged ? local.summary : fromTitle;
  return summary === base.summary ? {} : { summary };
}

/**
 * The cases where a file must not be sent at all. Each one would put someone
 * else's words in the token owner's name, or lose text, so the rule is to stop.
 */
function reasonToRefuse(
  base: ParsedIssue,
  local: ParsedIssue,
): string | undefined {
  if (local.key !== base.key) {
    return `the key changed from ${base.key} to ${local.key}`;
  }
  if (local.comments.length !== base.comments.length) {
    return "a comment was added or removed; push only sends text appended after the last comment";
  }
  for (let i = 0; i < base.comments.length; i++) {
    const before = base.comments[i];
    const after = local.comments[i];
    if (before?.heading !== after?.heading || before?.body !== after?.body) {
      return `comment ${
        i + 1
      } was edited; push will not rewrite someone else's comment`;
    }
  }
  return undefined;
}

function valueOf(issue: ParsedIssue, name: string): string {
  const value = (issue as unknown as Record<string, unknown>)[name];
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  // Jira treats labels as a set, so order alone is not an edit.
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/** A long body does not belong on one summary line. */
function summarise(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 40 ? flat : `${flat.slice(0, 40)}...`;
}
