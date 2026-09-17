/**
 * Root export of jira-local: the type of the user configuration file
 * (`.jira/.config.ts`), so config authors can write:
 *
 * ```ts
 * import type { JiraLocalConfig } from "jsr:@jollytoad/jira-local";
 *
 * export const config: JiraLocalConfig = { ... };
 * ```
 *
 * The CLI itself is not part of this module.
 *
 * @module
 */

export type { JiraLocalConfig } from "./types/config.ts";
