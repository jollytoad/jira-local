/**
 * The test type every step file gets, with the fixtures a scenario shares.
 * Named in the `steps` pattern of playwright.config.ts rather than imported by
 * each step file, which is what lets a step say `createBdd()` with no
 * argument and still see `shell`. It registers no steps of its own.
 */
// deno-lint-ignore-file no-empty-pattern
import { test as bdd } from "playwright-bdd";

import { Shell } from "./shell.ts";

export const test = bdd.extend<{ shell: Shell }>({
  shell: async ({}, use) => {
    await use(new Shell());
  },
});
