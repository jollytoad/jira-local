import { stringify } from "@std/yaml/stringify";
import { adfToMarkdown } from "./adf-to-markdown.ts";
import type {
  IssueFileContent,
  IssueFrontMatter,
  JiraIssue,
  JiraIssueRef,
} from "./types.ts";
import { displayName, isoDate } from "./util.ts";

export interface RenderedIssue {
  /** Full markdown file content. */
  markdown: string;
}

/** Convert a Jira issue into its parsed file representation. */
export function jiraIssueToContent(
  issue: JiraIssue,
  siteUrl: string,
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
    children: refKeys(fields.subtasks ?? []),
    linked: refKeys(
      (fields.issuelinks ?? []).map((link) =>
        link.inwardIssue ?? link.outwardIssue
      ),
    ),
    created: isoDate(fields.created),
    updated: isoDate(fields.updated),
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
      const date = isoDate(comment.created);
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

/** Render an issue file's content string from its parsed representation. */
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

/** Build the full markdown file content of a single issue. */
export function renderIssue(
  issue: JiraIssue,
  siteUrl: string,
): RenderedIssue {
  const content = jiraIssueToContent(issue, siteUrl);
  return { markdown: renderIssueFile(content) };
}

/**
 * Issue keys of an embedded-ref list (subtasks, link ends), de-duplicated and
 * in order.
 */
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
