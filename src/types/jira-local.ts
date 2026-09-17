/**
 * Types of the post-conversion data: the local issue file as written to disk
 * (front matter plus raw body) and its field-name vocabulary, which doubles
 * as the vocabulary for category folders and index columns (see
 * `types/config.ts` and `config.ts`), plus the pull-pipeline shapes
 * (rendered issue, local file records, counters, watermark state).
 */

/** The front-matter data of a rendered issue file, in file order. */
export interface IssueFrontMatter {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  type: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string[];
  parent: string;
  children: string[];
  linked: string[];
  created: string;
  updated: string;
  url: string;
}

/** A front-matter field name, usable as an index table column. */
export type IndexColumn = keyof IssueFrontMatter;

/** A category folder name: the front-matter field it is derived from. */
export type FrontMatterKey = keyof IssueFrontMatter;

/** The parsed content of an issue file: typed front matter plus raw body. */
export interface IssueFileContent {
  frontMatter: IssueFrontMatter;
  /** Raw markdown body (everything after the front matter). */
  body: string;
}

/** An issue rendered into its final markdown form. */
export interface PulledIssue {
  key: string;
  markdown: string;
}

/** A local issue file scanned from the flat `all/` folder. */
export interface LocalIssueFile {
  key: string;
  absPath: string;
  relPath: string;
  content: string;
}

/** Counters for the per-issue actions taken by a pull. */
export interface PullCounters {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/** Incremental-pull watermark state persisted as `.jira/.state.json`. */
export interface PullState {
  /** Jira server-side `updated` watermark, "yyyy-MM-dd HH:mm". */
  maxUpdated: string;
  /** Atlassian account timezone the watermark was rendered in. */
  timeZone?: string;
  /** ISO timestamp of the last completed run (informational). */
  lastRun?: string;
  /** Project the watermark belongs to. */
  project?: string;
}
