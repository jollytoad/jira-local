import type { IssueFrontMatter } from "./types/jira-local.ts";

export const JIRA_DIR = ".jira";

export const ISSUES_DIR = `${JIRA_DIR}/issues/all`;

/**
 * The merge base per issue. It sits outside `issues/` because
 * `scanManagedCategories` manages every directory below that.
 */
export const BASE_DIR = `${JIRA_DIR}/.base`;

/** Scratch space for the `git merge-file` inputs. Gitignored alongside `.jira`. */
export const TEMP_DIR = ".tmp";

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
