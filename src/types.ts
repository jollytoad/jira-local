/**
 * Shared data shapes for the jira-local tool: types used by more than one
 * module live here.
 */

/** A node in Atlassian Document Format (ADF). */
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/** A Jira user reference (assignee, reporter, comment author, ...). */
export interface JiraUserRef {
  displayName?: string;
  name?: string;
  accountId?: string;
}

/** A Jira comment (embedded by search, or fetched per issue). */
export interface JiraComment {
  id: string;
  author?: JiraUserRef | null;
  created?: string;
  updated?: string;
  body?: AdfNode | string | null;
}

/** An embedded issue reference (parent, subtask, link end). */
export interface JiraIssueRef {
  key?: string;
  fields?: {
    summary?: string;
    issuetype?: { name?: string; subtask?: boolean } | null;
  } | null;
}

/** An issue link (direction and link type are unimportant to this tool). */
export interface JiraIssueLink {
  type?: { name?: string; inward?: string; outward?: string } | null;
  inwardIssue?: JiraIssueRef;
  outwardIssue?: JiraIssueRef;
}

/** A Jira issue as returned by the REST v3 search (subset we consume). */
export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name?: string; statusCategory?: { name?: string } } | null;
    issuetype?: { name?: string } | null;
    parent?: JiraIssueRef | null;
    subtasks?: JiraIssueRef[];
    issuelinks?: JiraIssueLink[];
    priority?: { name?: string } | null;
    assignee?: JiraUserRef | null;
    reporter?: JiraUserRef | null;
    labels?: string[];
    created?: string;
    updated?: string;
    creator?: JiraUserRef | null;
    description?: AdfNode | null;
    /** Embedded by the search when "comment" is requested. */
    comment?: {
      total?: number;
      comments?: JiraComment[];
    } | null;
  };
}

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

/** Jira Cloud credentials (basic auth). */
export interface Credentials {
  site: string;
  email: string;
  token: string;
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
  /** Jira Cloud base URL (overrides nothing; beats nothing — flags win). */
  site?: string;
  /** Jira project key to pull. */
  project?: string;
  /** Atlassian account email (basic-auth username). */
  email?: string;
  /** Atlassian API token (basic-auth password). */
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
