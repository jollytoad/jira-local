import { resolve } from "node:path";
import process from "node:process";
import type { IssueFrontMatter } from "./types/jira-local.ts";

/**
 * The mirror directory, absolute. `--dir` replaces it during the parse; without
 * it this is `.jira` beside the working directory. Absolute so the three
 * helpers that `join` it — config, state, base — behave for a path given from
 * anywhere, and so the paths in messages and the config cache key mean one thing
 * regardless of how they were spelled on the command line.
 */
export let JIRA_DIR = resolve(process.cwd(), ".jira");

export let ISSUES_DIR = `${JIRA_DIR}/issues/all`;

/**
 * The merge base per issue. It sits outside `issues/` because
 * `scanManagedCategories` manages every directory below that.
 */
export let BASE_DIR = `${JIRA_DIR}/.base`;

/**
 * Points the mirror somewhere other than `.jira`. Called from the `--dir`
 * option's action, which cliffy runs during the parse, so every later read of
 * these three sees the new value through the module's live bindings. The two
 * derived paths are recomputed here rather than being derived at each read
 * because they are what the commands and tools import.
 */
export function setJiraDir(dir: string): void {
  JIRA_DIR = resolve(process.cwd(), dir);
  ISSUES_DIR = `${JIRA_DIR}/issues/all`;
  BASE_DIR = `${JIRA_DIR}/.base`;
}

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
