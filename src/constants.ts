import type { IssueFrontMatter } from "./types/jira-local.ts";

export const JIRA_DIR = ".jira";

export const ISSUES_DIR = `${JIRA_DIR}/issues/all`;

export const FRONT_MATTER_KEYS = [
  "key",
  "summary",
  "status",
  "statusCategory",
  "type",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "parent",
  "children",
  "linked",
  "created",
  "updated",
  "url",
] as const satisfies readonly (keyof IssueFrontMatter)[];
