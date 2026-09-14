import { stringify } from "@std/yaml";
import { adfToMarkdown } from "./adf-to-markdown.ts";
import type {
  IssueFrontMatter,
  JiraComment,
  JiraIssue,
  JiraIssueRef,
} from "./types.ts";
import { displayName, isoDate } from "./util.ts";

export interface RenderedIssue {
  /** Full markdown file content. */
  markdown: string;
}

/** Build the markdown representation of a single issue. */
export function renderIssue(
  issue: JiraIssue,
  siteUrl: string,
  options: { comments?: JiraComment[] } = {},
): RenderedIssue {
  const fields = issue.fields;
  const status = fields.status?.name ?? "Unknown";
  const summary = fields.summary ?? "";

  const frontMatter: IssueFrontMatter = {
    key: issue.key,
    summary,
    status,
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

  const sections: string[] = [];
  sections.push(
    `---\n${
      stringify(frontMatter, {
        lineWidth: -1,
        sortKeys: false,
        flowLevel: 1,
      }).trimEnd()
    }\n---`,
  );
  sections.push(`# ${issue.key} ${summary}`);
  const description = adfToMarkdown(fields.description);
  if (description) sections.push(`## Description\n\n${description}`);

  const comments = options.comments ?? [];
  if (comments.length) {
    const rendered = comments
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
    if (rendered) sections.push(`## Comments\n\n${rendered}`);
  }

  return {
    markdown: sections.join("\n\n").replace(/\s+$/, "") + "\n",
  };
}

/**
 * Issue keys of an embedded-ref list (subtasks, link ends), de-duplicated and
 * in order — rendered as a comma-separated front-matter value, like labels.
 */
function refKeys(refs: ReadonlyArray<JiraIssueRef | null | undefined>): string {
  const keys: string[] = [];
  for (const ref of refs) {
    const key = ref?.key;
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.join(", ");
}
