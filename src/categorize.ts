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

export interface CategorizeInput {
  /** Parsed front-matter values (strings; keys as rendered, e.g. "status"). */
  frontMatter: Record<string, string>;
  /** Raw markdown body (everything after the front matter). */
  body: string;
}

/** Determine the categories of a single issue. */
export function categorizeIssue(input: CategorizeInput): string[] {
  const status = input.frontMatter["status"]?.trim() || "Unknown";
  return [`status/${status}`];
}
