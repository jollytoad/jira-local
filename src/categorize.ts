/**
 * Issue categorisation: the single function that decides which category
 * folders an issue belongs to. Categories are strings; a "/" separates
 * hierarchy levels ("status/Done" nests "Done" inside "status"). An issue may
 * belong to any number of categories. Category folders live next to `all/`
 * and contain symlinks into `all/`, so this never writes new issue content.
 *
 * Current scheme: every issue lands in `status/<status>`, `assignee/<name>`
 * (or `assignee/Unassigned`), one `label/<label>` per label (slashes inside a
 * label nest subfolders), and `parent/<parent key>` when it has a parent.
 *
 * Swap this function out to change the whole layout — the reconciler in
 * `categories.ts` is generic.
 */

import type { IssueFileContent } from "./types.ts";

/** Determine the categories of a single issue. */
export function categorizeIssue(issue: IssueFileContent): string[] {
  const fm = issue.frontMatter;
  const categories = [`status/${fm.status?.trim() || "Unknown"}`];

  const assignee = fm.assignee?.trim();
  categories.push(`assignee/${assignee || "Unassigned"}`);

  for (const label of fm.labels ?? []) {
    const trimmed = label.trim().toLowerCase();
    if (trimmed !== "") categories.push(`label/${trimmed}`);
  }

  const parent = fm.parent?.trim();
  if (parent) categories.push(`parent/${parent}`);

  return categories;
}
