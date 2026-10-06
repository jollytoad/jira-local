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
 * issue front matter in `types/`.
 */

import type { FrontMatterKey, IndexColumn } from "./jira-local.ts";

/**
 * User configuration loaded from `.jira/.config.ts`. Every field is optional;
 * an omitted field means "current default behavior". The connection fields
 * (`site`, `project`, `email`, `token`) are used by `pull` and ignored by
 * `categorize`; flags beat config values. Since the config is a TypeScript
 * module, it may read environment variables itself
 * (`token: process.env.JIRA_API_TOKEN`) — the tool never reads env vars
 * directly. Category names are the front-matter field names they are derived
 * from ("status", "assignee", "labels", "parent"); other front-matter keys
 * are valid but inert (the categoriser never produces a category for them).
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
   * Index pages to create, per top-level category (front-matter field name),
   * with the table columns to render. Only listed categories get index
   * pages. Omit the whole field for index pages everywhere with the default
   * columns.
   */
  categoryIndex?: Partial<Record<FrontMatterKey, readonly IndexColumn[]>>;
}
