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
  type: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string[];
  parent: string;
  children: string;
  linked: string;
  created: string;
  updated: string;
  url: string;
}

/** Jira Cloud credentials (basic auth). */
export interface Credentials {
  site: string;
  email: string;
  token: string;
}

/** An issue rendered into its final markdown form. */
export interface SyncIssue {
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

/** Counters for the per-issue actions taken by a sync. */
export interface SyncCounters {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/** Incremental-sync watermark state persisted as `.jira/.state.json`. */
export interface SyncState {
  /** Jira server-side `updated` watermark, "yyyy-MM-dd HH:mm". */
  maxUpdated: string;
  /** Atlassian account timezone the watermark was rendered in. */
  timeZone?: string;
  /** ISO timestamp of the last completed run (informational). */
  lastRun?: string;
  /** Project the watermark belongs to. */
  project?: string;
}
