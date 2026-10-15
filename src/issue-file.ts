/**
 * Reads an issue file back into the pieces a push needs: front matter, the
 * description body, and the comment section.
 *
 * The description runs from after `## Description` to before the *last* line
 * that is exactly `## Comments`. Generated files never contain more than one,
 * and the last one is the real boundary: splitting at the first would push the
 * whole comment dump into Jira as the description.
 */

import { extract } from "@std/front-matter/yaml";
import { test } from "@std/front-matter/test";
import { FRONT_MATTER_KEYS } from "./constants.ts";
import { jiraTimestamp } from "./util.ts";
import type { JiraIssue } from "./types/jira-raw.ts";
import type { IssueFrontMatter } from "./types/jira-local.ts";

const DESCRIPTION_HEADING = "\n## Description\n";
const COMMENTS_HEADING = "\n## Comments\n";

export interface CommentBlock {
  heading: string;
  body: string;
}

export interface ParsedIssue extends IssueFrontMatter {
  description: string;
  /** The whole `## Comments` section, verbatim after the heading. */
  commentsRaw: string;
  /** The comment blocks it holds, keyed by heading. */
  comments: CommentBlock[];
  /** The `# KEY summary` line, kept separate: front matter is authoritative. */
  title: string;
}

export function parseIssueFile(raw: string): ParsedIssue | undefined {
  let attrs: Record<string, unknown>;
  try {
    if (!test(raw)) return undefined;
    attrs = extract<Record<string, unknown>>(raw).attrs;
  } catch {
    return undefined;
  }

  const body = bodyOf(raw);
  const commentsAt = body.lastIndexOf(COMMENTS_HEADING);
  const beforeComments = commentsAt < 0 ? body : body.slice(0, commentsAt);
  const commentText = commentsAt < 0
    ? ""
    : body.slice(commentsAt + COMMENTS_HEADING.length);

  const titleMatch = /^#\s+.*$/m.exec(beforeComments);
  const title = titleMatch?.[0] ?? "";
  const afterTitle = titleMatch === null
    ? beforeComments
    : beforeComments.slice(titleMatch.index + titleMatch[0].length);

  // An issue with an empty description has no `## Description` section at all,
  // so text a user writes below the title is the description. Reading only the
  // heading would drop the first description anyone writes for such an issue.
  const descriptionAt = afterTitle.indexOf(DESCRIPTION_HEADING);
  const description =
    (descriptionAt < 0
      ? afterTitle
      : afterTitle.slice(descriptionAt + DESCRIPTION_HEADING.length)).trim();

  return {
    ...coerce(attrs),
    description,
    commentsRaw: commentText,
    comments: splitComments(commentText),
    title,
  };
}

/**
 * The same file's comment blocks, cut off at `limit` characters. A push uses
 * it to compare an edited file's comments against the base while ignoring any
 * text appended below them, which would otherwise read as an edit to the last
 * comment.
 */
export function truncateComments(
  parsed: ParsedIssue,
  limit: number,
): ParsedIssue {
  const cut = parsed.commentsRaw.slice(0, limit);
  if (cut === parsed.commentsRaw) return parsed;
  return { ...parsed, commentsRaw: cut, comments: splitComments(cut) };
}

/** The `# KEY summary` line is the first heading, above any `##` section. */
function bodyOf(raw: string): string {
  const end = /^---$/m.exec(raw.slice(raw.indexOf("\n") + 1))?.index;
  return end === undefined ? "" : raw.slice(end + 5).replace(/^\s*\n/, "");
}

/**
 * Each `### Comment N — Author (date)` heading and the body under it, so a
 * push can tell an edit to an existing comment from text appended below the
 * last one.
 */
function splitComments(text: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  const pattern = /^### .*$/gm;
  const marks: number[] = [];
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    marks.push(m.index);
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i] ?? 0;
    const end = marks[i + 1] ?? text.length;
    const chunk = text.slice(start, end);
    const lineBreak = chunk.indexOf("\n");
    blocks.push({
      heading: (lineBreak < 0 ? chunk : chunk.slice(0, lineBreak)).trim(),
      body: (lineBreak < 0 ? "" : chunk.slice(lineBreak)).trim(),
    });
  }
  return blocks;
}

/**
 * Text appended below the last comment, which is a new comment waiting to be
 * posted. An empty string means nothing was appended.
 *
 * The base file is the yardstick: it holds exactly what Jira had, so whatever
 * follows its comment section verbatim is the new text. Text that does not
 * follow it is not an append, and the caller treats it as an edit instead.
 */
export function appendedComment(
  base: ParsedIssue,
  local: ParsedIssue,
): string {
  if (local.commentsRaw === base.commentsRaw) return "";
  if (!local.commentsRaw.startsWith(base.commentsRaw)) return "";
  return local.commentsRaw.slice(base.commentsRaw.length).trim();
}

/**
 * The summary a `# KEY summary` line carries: everything after the `#` and the
 * key, if the key is there at all. `undefined` when the line carries no text,
 * which is a title with nothing in it rather than an empty summary.
 */
export function titleSummary(
  title: string,
  key: string,
): string | undefined {
  const text = title.replace(/^#/, "").trim();
  if (text === "") return undefined;
  const space = text.indexOf(" ");
  // A title that does not repeat the key is the summary on its own.
  if (space < 0) return text === key ? undefined : text;
  return text.slice(0, space) === key
    ? text.slice(space + 1).trim() || undefined
    : text;
}

const ARRAY_FIELDS = new Set(["labels", "children", "linked"]);

function coerce(attrs: Record<string, unknown>): IssueFrontMatter {
  const out: Record<string, string | string[]> = {};
  for (const key of FRONT_MATTER_KEYS) {
    const value = attrs[key];
    out[key] = ARRAY_FIELDS.has(key)
      ? Array.isArray(value)
        ? value.map((item) => String(item))
        : value == null
        ? []
        : [String(value)]
      : value == null
      ? ""
      : String(value);
  }
  return out as unknown as IssueFrontMatter;
}

/** The front matter of a freshly rendered file, for comparison against a push. */
export function frontMatterOf(
  issue: JiraIssue,
  childKeys?: readonly string[],
): IssueFrontMatter {
  const keys = new Set(
    (issue.fields.subtasks ?? [])
      .map((subtask) => subtask?.key ?? "")
      .filter((key) => key !== ""),
  );
  for (const key of childKeys ?? []) keys.add(key);
  return coerce({
    key: issue.key,
    summary: issue.fields.summary ?? "",
    status: issue.fields.status?.name ?? "",
    statusCategory: issue.fields.status?.statusCategory?.name ?? "",
    type: issue.fields.issuetype?.name ?? "",
    priority: issue.fields.priority?.name ?? "",
    assignee: issue.fields.assignee?.displayName ?? "",
    reporter: issue.fields.reporter?.displayName ?? "",
    labels: issue.fields.labels ?? [],
    parent: issue.fields.parent?.key ?? "",
    children: [...keys].sort((a, b) => a.localeCompare(b)),
    linked: (issue.fields.issuelinks ?? [])
      .map((link) => (link.inwardIssue ?? link.outwardIssue)?.key ?? "")
      .filter((key) => key !== ""),
    created: jiraTimestamp(issue.fields.created),
    updated: jiraTimestamp(issue.fields.updated),
    url: "",
  });
}
