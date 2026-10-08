/**
 * Root export: the type of the user configuration file, so config authors can
 * write `export const config: JiraLocalConfig = { ... }` without importing
 * the rest of the tool. The CLI lives at `./cli`.
 *
 * @module
 */

export type { JiraLocalConfig } from "./types/config.ts";
