/**
 * Categories are the unit of the index pages the reconciler in
 * `categories.ts` builds; a "/" nests. Replace this one function to change
 * the whole layout.
 */
import type { IssueFileContent } from "./types/jira-local.ts";

export function categorizeIssue(issue: IssueFileContent): string[] {
  const fm = issue.frontMatter;

  const categories = [`status/${fm.status?.trim() || "Unknown"}`];

  // Done issues are status-only: no owner or label pages for closed work.
  if (fm.statusCategory === "Done") return categories;

  const assignee = fm.assignee?.trim();
  categories.push(`assignee/${assignee || "Unassigned"}`);

  for (const label of fm.labels ?? []) {
    const trimmed = label.trim().toLowerCase();
    if (trimmed !== "") categories.push(`labels/${trimmed}`);
  }

  const parent = fm.parent?.trim();
  if (parent) categories.push(`parent/${parent}`);

  return categories;
}
