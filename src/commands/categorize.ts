/**
 * The `categorize` command: regenerate the category index pages from the
 * files already present in the output folder. Contains its orchestration
 * (`runCategorize`) alongside the cliffy command definition.
 */

import { Command } from "@cliffy/command";

import { reconcileCategories } from "../categories.ts";
import { scanLocal } from "../pull.ts";
import { elapsed } from "../util.ts";

/**
 * The command itself, default-exported so `cli.ts` can lazy import the module
 * and hand it straight to `.command()`.
 */
export default new Command()
  .description(
    "Re-categorise only (no Jira fetch, no credentials needed):\n" +
      "regenerate the category index pages from the files in the output\n" +
      "folder.",
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

/**
 * Standalone re-categorisation: regenerate the category index pages from
 * the files already present in `all/`. No network, no credentials, no
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
  await reconcileCategories(local, outDir, dryRun);
  // As in `pull`: the index rows above carry the counts, so this keeps only
  // the timing and the dry-run warning.
  console.log(
    `Categorised in ${elapsed(started)}${
      dryRun ? " — dry run: no changes written" : ""
    }.`,
  );
}
