/** Jira Cloud REST v3 payloads, before conversion (see `render.ts`). */

import type { AdfNode } from "./adf.ts";

export interface Credentials {
  site: string;
  email: string;
  token: string;
}

/** Users, projects and versions all spell their name differently. */
export interface JiraUserRef {
  displayName?: string;
  name?: string;
  accountId?: string;
}

export interface JiraComment {
  id: string;
  author?: JiraUserRef | null;
  created?: string;
  updated?: string;
  body?: AdfNode | string | null;
}

/** Parent, subtask or link end. */
export interface JiraIssueRef {
  key?: string;
  fields?: {
    summary?: string;
    issuetype?: { name?: string; subtask?: boolean } | null;
  } | null;
}

/** Direction and link type are unimportant to this tool. */
export interface JiraIssueLink {
  type?: { name?: string; inward?: string; outward?: string } | null;
  inwardIssue?: JiraIssueRef;
  outwardIssue?: JiraIssueRef;
}

/** The subset of a search issue this tool consumes. */
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
