#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
/**
 * Jira issue pull tool.
 *
 * Fetches all issues for a project from Jira Cloud and lays them out on disk
 * as `.jira/issues/all/<KEY>.md`, pruning files so the local folder mirrors
 * Jira. Streams: pages are fetched while earlier pages render and write.
 *
 * Run via `deno task pull` (from the project root). The command definition
 * lives in `cli.ts`; each command in `commands/`.
 */

import { buildCommand } from "./cli.ts";
import {
  ConfigError,
  JiraApiError,
  JiraAuthError,
  JiraProjectError,
  JiraSearchMismatchError,
} from "./errors.ts";

async function main(): Promise<number> {
  const command = buildCommand();
  try {
    await command.parse();
    return 0;
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) {
      console.error(
        `error: ${error.message}\n` +
          "Run with the permissions shown in the header of this file, e.g.:\n" +
          "  deno run --allow-net --allow-read --allow-write --allow-env src/main.ts",
      );
      return 1;
    }
    if (
      error instanceof JiraAuthError || error instanceof JiraProjectError ||
      error instanceof ConfigError || error instanceof JiraSearchMismatchError
    ) {
      console.error(`error: ${error.message}`);
      if (error instanceof JiraSearchMismatchError) {
        console.error(
          "This is usually the search endpoint silently returning an empty result " +
            "(auth/visibility failure) — check the credentials and project key.",
        );
      }
      return 1;
    }
    if (
      error instanceof JiraApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
