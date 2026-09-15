/**
 * The cliffy command tree: `jira-local` with `pull` and `categorize`
 * subcommands. Each command lives in `commands/` with its orchestration.
 * Bare invocation shows help.
 */

import { Command } from "@cliffy/command";

import { categorizeCommand } from "./commands/categorize.ts";
import { pullCommand } from "./commands/pull.ts";

export function buildCommand() {
  return new Command()
    .name("jira-local")
    .description(
      "Pull Jira issues into a flat folder of <KEY>.md files and maintain\n" +
        "categorised views of symlinks.",
    )
    .command("pull", pullCommand())
    .command("categorize", categorizeCommand())
    .reset();
}
