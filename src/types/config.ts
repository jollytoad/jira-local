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
  /**
   * The issue type a declaration gets when its heading names none. Defaults to
   * `Task`, which is what a project nearly always has.
   */
  defaultIssueType?: string;
  /**
   * The link type used when a declared issue turns out not to be able to be a
   * child of the issue it was declared in. Defaults to `Relates To`.
   */
  newIssueLinkType?: string;
}
