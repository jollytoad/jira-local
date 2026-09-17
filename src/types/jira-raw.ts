/**
 * Types of the raw data coming from the Jira Cloud REST v3 API: the issue
 * payload as Jira returns it, before any conversion to markdown/front-matter
 * (see `render.ts` and `types/jira-local.ts` for the converted shapes).
 */

import type { AdfNode } from "./adf.ts";

/** Jira Cloud credentials (basic auth). */
export interface Credentials {
  site: string;
  email: string;
  token: string;
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
