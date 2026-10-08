import { Command } from "@cliffy/command";
import process from "node:process";
import { resolve } from "node:path";

import { reconcileCategories } from "../categories.ts";
import { ISSUES_DIR } from "../constants.ts";
import { elapsed } from "../util.ts";

export default new Command()
  .description(
    "Re-categorise only (no Jira fetch, no credentials needed):\n" +
      "regenerate the category index pages from the files in the output\n" +
      "folder.",
  )
  .option("--dry-run", "Print the plan without writing anything.")
  .action((options) => {
    return runCategorize(options.dryRun ?? false);
  });

export async function runCategorize(dryRun: boolean): Promise<void> {
  const started = Date.now();
  const outDir = resolve(process.cwd(), ISSUES_DIR);
  console.log(
    `Re-categorising issues in ${outDir}${dryRun ? " (dry-run)" : ""}...`,
  );
  await reconcileCategories(outDir, "*", dryRun);
  console.log(
    `Categorised in ${elapsed(started)}${
      dryRun ? " — dry run: no changes written" : ""
    }.`,
  );
}
