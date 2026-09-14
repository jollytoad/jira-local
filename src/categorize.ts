/**
 * Issue categorisation: the single function that decides which category
 * folders an issue belongs to. Categories are strings; a "/" separates
 * hierarchy levels ("status/Done" nests "Done" inside "status"). An issue may
 * belong to any number of categories. Category folders live next to `all/`
 * and contain symlinks into `all/`, so this never writes new issue content.
 *
 * Swap this function out to change the whole layout — the reconciler in
 * `categories.ts` is generic.
 */

import type { IssueFileContent } from "./types.ts";

/** Determine the categories of a single issue. */
export function categorizeIssue(issue: IssueFileContent): string[] {
  const status = issue.frontMatter.status?.trim() || "Unknown";
  return [`status/${status}`];
}
