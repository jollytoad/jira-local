import type { AdfNode } from "./adf-to-markdown.ts";
import { adfToMarkdown } from "./adf-to-markdown.ts";
import { displayName, isoDate, yamlScalar } from "./util.ts";

export interface JiraUserRef {
  displayName?: string;
  name?: string;
  accountId?: string;
}

export interface JiraComment {
  id: string;
  author?: JiraUserRef | null;
  created?: string;
  updated?: string;
  body?: AdfNode | string | null;
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name?: string; statusCategory?: { name?: string } } | null;
    issuetype?: { name?: string } | null;
    priority?: { name?: string } | null;
    assignee?: JiraUserRef | null;
    reporter?: JiraUserRef | null;
    labels?: string[];
    created?: string;
    updated?: string;
    creator?: JiraUserRef | null;
    description?: AdfNode | null;
    /** Embedded by the search when "comment" is requested. */
    comment?: {
      total?: number;
      comments?: JiraComment[];
    } | null;
  };
}

export interface RenderedIssue {
  /** Full markdown file content. */
  markdown: string;
}

const FRONT_MATTER_ORDER = [
  "key",
  "summary",
  "status",
  "type",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "created",
  "updated",
  "url",
] as const;

/** Build the markdown representation of a single issue. */
export function renderIssue(
  issue: JiraIssue,
  siteUrl: string,
  options: { comments?: JiraComment[] } = {},
): RenderedIssue {
  const fields = issue.fields;
  const status = fields.status?.name ?? "Unknown";
  const summary = fields.summary ?? "";

  const frontMatter: Record<string, string> = {
    key: issue.key,
    summary,
    status,
    type: fields.issuetype?.name ?? "",
    priority: fields.priority?.name ?? "",
    assignee: displayName(fields.assignee),
    reporter: displayName(fields.reporter),
    labels: fields.labels?.length ? fields.labels.join(", ") : "",
    created: isoDate(fields.created),
    updated: isoDate(fields.updated),
    url: `${siteUrl}/browse/${issue.key}`,
  };

  const sections: string[] = [];
  sections.push(renderFrontMatter(frontMatter));
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

function renderFrontMatter(values: Record<string, string>): string {
  const lines: string[] = ["---"];
  for (const key of FRONT_MATTER_ORDER) {
    lines.push(`${key}: ${yamlScalar(values[key] ?? "")}`);
  }
  lines.push("---");
  return lines.join("\n");
}
