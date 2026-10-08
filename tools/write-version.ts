import { readFile, writeFile } from "node:fs/promises";

import deno from "../deno.json" with { type: "json" };

const VERSION_FILE = new URL("../src/version.ts", import.meta.url);

const version = JSON.stringify(deno.version);
const contents = [
  "/** Generated from deno.json by `deno task version` — do not hand-edit. */",
  "",
  `export const VERSION = ${version};`,
  "",
].join("\n");

// Skipping an identical write keeps `git diff --exit-code` in CI meaningful.
const current = await readFile(VERSION_FILE, "utf8").catch(() => "");
if (current !== contents) await writeFile(VERSION_FILE, contents);
