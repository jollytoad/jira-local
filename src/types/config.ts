import type { FrontMatterKey, IndexColumn } from "./jira-local.ts";

/**
 * Every field is optional, and an omitted one means the current default.
 * `site`, `project`, `email` and `token` are used by `pull` and ignored by
 * `categorize`, with flags beating config values. The tool reads no env vars
 * itself: the config is a TypeScript module, so read them there
 * (`token: process.env.JIRA_API_TOKEN`).
 */
export interface JiraLocalConfig {
  site?: string;
  project?: string;
  email?: string;
  token?: string;
  /**
   * Which top-level categories get an index page, and with which columns.
   * Categories are front-matter field names; other front-matter keys are valid
   * but inert, since the categoriser never produces a category for them. Omit
   * the field entirely to index every category with the default columns.
   */
  categoryIndex?: Partial<Record<FrontMatterKey, readonly IndexColumn[]>>;
}
