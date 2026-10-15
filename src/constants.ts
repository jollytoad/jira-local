import type { IssueFrontMatter } from "./types/jira-local.ts";

export const JIRA_DIR = ".jira";

export const ISSUES_DIR = `${JIRA_DIR}/issues/all`;

/**
 * The merge base per issue. It sits outside `issues/` because
 * `scanManagedCategories` manages every directory below that.
 */
export const BASE_DIR = `${JIRA_DIR}/.base`;

/**
 * Where new issues are declared. A sibling of `all`, and excluded from
 * `scanManagedCategories` so it is never treated as a category.
 */
export const NEW_DIR_NAME = "new";

/** Used when the config names no type of its own. */
export const DEFAULT_ISSUE_TYPE = "Task";

/** Used when the config names no link type of its own. */
export const DEFAULT_LINK_TYPE = "Relates To";

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
