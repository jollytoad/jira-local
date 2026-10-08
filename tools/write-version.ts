import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const VERSION_FILE = new URL("src/version.ts", ROOT);

const deno = JSON.parse(
  await readFile(new URL("deno.json", ROOT), "utf8"),
) as { version: string };

const contents =
  `/** Generated from deno.json by \`deno task version\` — do not hand-edit. */

export const VERSION = ${JSON.stringify(deno.version)};
`;

// Skipping an identical write keeps `git diff --exit-code` in CI meaningful.
const current = await readFile(VERSION_FILE, "utf8").catch(() => "");
if (current !== contents) await writeFile(VERSION_FILE, contents);
