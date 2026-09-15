/**
 * The `categorize` command: refresh the category folders of symlinks from
 * the files already present in the output folder. Contains its orchestration
 * (`runCategorize`) alongside the cliffy command definition.
 */

import { Command } from "@cliffy/command";

import { reconcileCategories } from "../categories.ts";
import { scanLocal } from "../pull.ts";
import { elapsed, pluralise } from "../util.ts";

export function categorizeCommand() {
  return new Command()
    .description(
      "Re-categorise only (no Jira fetch, no credentials needed):\n" +
        "refresh the category folders of symlinks from the files in the\n" +
        "output folder.",
    )
    .option(
      "--out <dir:string>",
      "Output directory, relative to the project root.",
      { default: ".jira/issues/all" },
    )
    .option("--dry-run", "Print the plan without writing anything.")
    .action((options) => {
      return runCategorize(options.out, options.dryRun ?? false);
    });
}

/**
 * Standalone re-categorisation: refresh the category folders of symlinks
 * from the files already present in `all/`. No network, no credentials, no
 * state file — a purely local reconcile.
 */
export async function runCategorize(
  outDir: string,
  dryRun: boolean,
): Promise<void> {
  const started = Date.now();
  console.log(
    `Re-categorising issues in ${outDir}${dryRun ? " (dry-run)" : ""}...`,
  );
  const local = await scanLocal(outDir, "*");
  const counters = await reconcileCategories(local, outDir, dryRun);
  const parts = [
    `${counters.linksCreated} created`,
    `${counters.linksRetargeted} retargeted`,
    `${counters.linksRemoved} removed`,
    `${counters.linksUnchanged} unchanged`,
    `${counters.dirsCreated} folders created`,
    `${counters.dirsRemoved} folders removed`,
    `${counters.indexesCreated + counters.indexesUpdated} indexes changed`,
    `${counters.indexesRemoved} indexes removed`,
  ];
  console.log(
    `Categorised ${pluralise(local.size, "issue", "issues")} — ${
      parts.join(", ")
    } in ${elapsed(started)}${dryRun ? " — dry run: no changes written" : ""}.`,
  );
}
