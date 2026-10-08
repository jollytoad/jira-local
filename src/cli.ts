#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
import process from "node:process";

import { Command } from "@cliffy/command";

import { failAll, setVerbose } from "./progress.ts";
import { disableColour } from "./style.ts";
import {
  ConfigError,
  JiraApiError,
  JiraAuthError,
  JiraProjectError,
  JiraSearchMismatchError,
} from "./errors.ts";

async function main(): Promise<number> {
  const command = new Command()
    .name("jira-local")
    .description(
      "Pull Jira issues into a flat folder of <KEY>.md files and generate\n" +
        "categorised index pages.",
    )
    // Option actions fire during the parse, before the subcommand's action
    // runs, which is what progress() needs to see the right mode.
    .option(
      "--verbose",
      "Log one timestamped line per step instead of updating task lines in place.",
      { global: true, action: () => setVerbose(true) },
    )
    // Cliffy prints help before any option action fires, so no flag can
    // reach it; help follows NO_COLOR and the TTY check in style.ts instead.
    .option(
      "--no-color",
      "Disable colour in task lines.",
      { global: true, action: () => disableColour() },
    )
    // Lazy so a pull never loads the prompt library, or vice versa. Help
    // loads them all: their descriptions live in the modules.
    .command("pull", () => import("./commands/pull.ts"))
    .command("categorize", () => import("./commands/categorize.ts"))
    .command("init", () => import("./commands/init.ts"))
    .reset();
  try {
    await command.parse();
    return 0;
  } catch (error) {
    failAll();
    const denied = error instanceof Error &&
      (error.name === "NotCapable" ||
        (error as { code?: unknown }).code === "ERR_ACCESS_DENIED");
    if (denied) {
      console.error(
        `error: ${error.message}\n` +
          "Run with the required permissions, e.g.:\n" +
          "  deno run --allow-net --allow-read --allow-write --allow-env jsr:@jollytoad/jira-local/cli",
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
  process.exit(await main());
}
