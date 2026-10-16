import { defineBddConfig } from "playwright-bdd";
import { defineConfig } from "@playwright/test";

const testDir = defineBddConfig({
  features: ["test/features/*.feature"],
  steps: ["test/steps/*.ts", "test/support/fixtures.ts"],
  outputDir: "playwright-bdd-gen",
  missingSteps: "fail-on-gen",
  arityCheck: true,
});

export default defineConfig({
  testDir,
  timeout: 30_000,
  reporter: "html",
  // init reads nothing off disk but its own output, so the world is the only
  // state a scenario has and there is no browser to launch.
  use: {},
});
