/**
 * The user configuration shape for `.jira/.config.ts`, published as the
 * package's root export so config authors can type their config without
 * importing the rest of the tool:
 *
 * ```ts
 * import type { JiraLocalConfig } from "jsr:@jollytoad/jira-local";
 * ```
 *
 * Field-name vocabulary (`FrontMatterKey`, `IndexColumn`) derives from the
 * issue front matter in `types.ts`.
 */

import type { FrontMatterKey, IndexColumn } from "./jira-local.ts";

/**
 * User configuration loaded from `.jira/.config.ts`. Every field is optional;
 * an omitted field means "current default behavior". The connection fields
 * (`site`, `project`, `email`, `token`) are used by `pull` and ignored by
 * `categorize`; flags beat config values. Since the config is a TypeScript
 * module, it may read environment variables itself
 * (`token: process.env.JIRA_API_TOKEN`) — the tool never reads env vars
 * directly. Folder names are the front-matter field names they are derived
 * from ("status", "assignee", "labels", "parent"); other front-matter keys
 * are valid but inert (the categoriser never produces a folder for them).
 * The two category fields are independent: a folder can have index pages
 * without materialised symlink folders, and vice versa.
 */
export interface JiraLocalConfig {
  /**
   * Jira Cloud base URL.
   */
  site?: string;

  /**
   * Jira project key to pull.
   */
  project?: string;

  /**
   * Atlassian account email.
   */
  email?: string;

  /**
   * Atlassian API token.
   */
  token?: string;

  /**
   * Top-level category folders to materialise as symlink folders (first
   * segment of a category string, e.g. "status" for "status/Done"). Omit to
   * create every category the categoriser produces. Does not affect index
   * pages (see `categoryIndex`).
   */
  categoryFolders?: readonly FrontMatterKey[];

  /**
   * Index pages to create, per top-level category folder, with the table
   * columns to render. Only listed folders get index pages — independent of
   * `categoryFolders`, so a folder can be indexed without its symlink
   * folders. Omit the whole field for index pages everywhere with the
   * default columns.
   */
  categoryIndex?: Partial<Record<FrontMatterKey, readonly IndexColumn[]>>;
}
