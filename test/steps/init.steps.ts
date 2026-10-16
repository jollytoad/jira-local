/**
 * Steps for init.feature.
 *
 * Everything a scenario shares comes from the `shell` fixture: a directory of
 * its own, and the last run in it.
 */
// deno-lint-ignore-file require-await
import { expect } from "@playwright/test";
import { createBdd, type DataTable } from "playwright-bdd";

import { test } from "../support/fixtures.ts";

const { Given, When, Then } = createBdd(test);

Given("a directory with no config", async ({ shell }) => {
  await shell.enterEmptyDir();
});

When("I run {string}", async ({ shell }, command: string) => {
  await shell.run(command);
});

Then("the exit code is {int}", async ({ shell }, code: number) => {
  expect(shell.lastRun.code).toBe(code);
});

Then("the config is", async ({ shell }, table: DataTable) => {
  const fields = await shell.readConfig();
  for (const [name = "", value = ""] of table.raw()) {
    expect(fields.get(name.trim()), name.trim()).toBe(value.trim());
  }
});
