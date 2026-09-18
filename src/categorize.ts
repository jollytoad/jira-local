/**
 * Issue categorisation: the single function that decides which categories an
 * issue belongs to. Categories are strings; a "/" separates hierarchy levels
 * ("status/Done" nests "Done" inside "status"). An issue may belong to any
 * number of categories. Each category gets an index page next to `all/`
 * (rendered by the reconciler in `categories.ts`), so this never writes new
 * issue content.
 *
 * Current scheme: every issue lands in `status/<status>`; issues whose
 * status category is not "Done" also land in `assignee/<name>` (or
 * `assignee/Unassigned`), one `labels/<label>` per label (slashes inside a
 * label nest subcategories), and `parent/<parent key>` when it has a parent —
 * done issues are status-only. Category names mirror the front-matter field
 * each category is derived from.
 *
 * Swap this function out to change the whole layout — the reconciler in
 * `categories.ts` is generic.
 */

import type { IssueFileContent } from "./types/jira-local.ts";

/** Determine the categories of a single issue. */
export function categorizeIssue(issue: IssueFileContent): string[] {
  const fm = issue.frontMatter;

  const categories = [`status/${fm.status?.trim() || "Unknown"}`];

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
