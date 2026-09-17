/**
 * Shared runtime constants for the jira-local tool (types live in types.ts).
 */

import type { IssueFrontMatter } from "./types/jira-local.ts";

/** All front-matter field names (runtime list for config validation). */
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
