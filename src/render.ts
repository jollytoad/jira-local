import { stringify } from "@std/yaml/stringify";
import { adfToMarkdown } from "./adf-to-markdown.ts";
import type {
  IssueFileContent,
  IssueFrontMatter,
  PulledIssue,
} from "./types/jira-local.ts";
import type { JiraIssue, JiraIssueRef } from "./types/jira-raw.ts";
import { displayName, jiraTimestamp } from "./util.ts";

export function jiraIssueToContent(
  issue: JiraIssue,
  siteUrl: string,
  childKeys?: readonly string[],
): IssueFileContent {
  const fields = issue.fields;
  const status = fields.status?.name ?? "Unknown";
  const statusCategory = fields.status?.statusCategory?.name ?? "";
  const summary = fields.summary ?? "";

  const frontMatter: IssueFrontMatter = {
    key: issue.key,
    summary,
    status,
    statusCategory,
    type: fields.issuetype?.name ?? "",
    priority: fields.priority?.name ?? "",
    assignee: displayName(fields.assignee),
    reporter: displayName(fields.reporter),
    labels: fields.labels ?? [],
    parent: fields.parent?.key ?? "",
    children: childrenOf(issue, childKeys),
    linked: refKeys(
      (fields.issuelinks ?? []).map((link) =>
        link.inwardIssue ?? link.outwardIssue
      ),
    ),
    created: jiraTimestamp(fields.created),
    updated: jiraTimestamp(fields.updated),
    url: `${siteUrl}/browse/${issue.key}`,
  };

  const comments = issue.fields.comment?.comments ?? [];
  const description = adfToMarkdown(fields.description);
  const renderedComments = comments
    .map((comment, index) => {
      const rawBody = comment.body;
      const body = typeof rawBody === "string"
        ? rawBody
        : adfToMarkdown(rawBody);
      if (!body) return "";
      const author = displayName(comment.author) || "Unknown";
      const date = jiraTimestamp(comment.created);
      const heading = `### Comment ${index + 1} — ${author}${
        date ? ` (${date})` : ""
      }`;
      return `${heading}\n\n${body}`;
    })
    .filter((part) => part !== "")
    .join("\n\n");

  const sections: string[] = [`# ${issue.key} ${summary}`];
  if (description) sections.push(`## Description\n\n${description}`);
  if (renderedComments) sections.push(`## Comments\n\n${renderedComments}`);

  return { frontMatter, body: sections.join("\n\n").replace(/\s+$/, "") };
}

export function renderIssueFile(content: IssueFileContent): string {
  const { frontMatter, body } = content;
  const sections: string[] = [
    `---\n${
      stringify(frontMatter, {
        lineWidth: -1,
        sortKeys: false,
        flowLevel: 1,
      }).trimEnd()
    }\n---`,
    body,
  ];
  return sections.join("\n\n").replace(/\s+$/, "") + "\n";
}

// Field order is the file's field order: sortKeys is off deliberately.
export function contentToPulledIssue(content: IssueFileContent): PulledIssue {
  return {
    key: content.frontMatter.key,
    markdown: renderIssueFile(content),
  };
}

/** Keys of an embedded-ref list, de-duplicated and in order. */
function refKeys(
  refs: ReadonlyArray<JiraIssueRef | null | undefined>,
): string[] {
  const keys: string[] = [];
  for (const ref of refs) {
    const key = ref?.key;
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * The issues whose Parent is this one.
 *
 * `childKeys` comes from `fetchChildMap`, which asks Jira for the Parent field
 * and so covers every kind of child. `fields.subtasks` is only Sub-tasks, so it
 * is the fallback for a caller with no map rather than the answer on its own:
 * an Epic's children are real issues, not subtasks, and reading it alone leaves
 * the array permanently empty. Sorted, so the file does not churn when Jira
 * returns the same children in another order.
 */
function childrenOf(
  issue: JiraIssue,
  childKeys: readonly string[] | undefined,
): string[] {
  const keys = new Set(refKeys(issue.fields.subtasks ?? []));
  for (const key of childKeys ?? []) keys.add(key);
  return [...keys].sort((a, b) => a.localeCompare(b));
}
