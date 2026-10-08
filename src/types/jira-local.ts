/** Front matter, in the order it appears in the file. */
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

/** Front-matter field names, which double as category names. */
export type IndexColumn = keyof IssueFrontMatter;

/** The front-matter field a category is derived from. */
export type FrontMatterKey = keyof IssueFrontMatter;

export interface IssueFileContent {
  frontMatter: IssueFrontMatter;
  /** Raw markdown body (everything after the front matter). */
  body: string;
}

export interface PulledIssue {
  key: string;
  markdown: string;
}

export interface IssueFileRef {
  key: string;
  absPath: string;
  relPath: string;
}

export interface LocalIssueFile extends IssueFileRef {
  /** SHA-256 of the file's bytes: enough to detect a change, cheap to keep. */
  hash: string;
}

/** Persisted as `.jira/.state.json`. */
export interface PullState {
  /** Jira server-side `updated` watermark, "yyyy-MM-dd HH:mm". */
  maxUpdated: string;
  /** Atlassian account timezone the watermark was rendered in. */
  timeZone?: string;
  /** Informational. */
  lastRun?: string;
  /** Invalidates the watermark when the project changes. */
  project?: string;
}
