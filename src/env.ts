/**
 * Read an env var, treating empty/whitespace-only as unset. Includes the
 * `.jira/.env` loader used to give compiled binaries the same credential
 * convenience the `--env-file` flag gives `deno run` invocations.
 */

import { parse as parseDotEnv } from "@std/dotenv/parse";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Path of the optional dotenv file, sibling of the issues folder (like the
 * state file and config file).
 */
export function envFilePath(outDir: string): string {
  const grandParent = dirname(dirname(outDir)); // .jira, sibling of issues/
  return join(grandParent, ".env");
}
export function env(name: string): string | undefined {
  const value = Deno.env.get(name);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Load `KEY=VALUE` pairs from a dotenv file into the process environment
 * without overwriting variables that are already set, mirroring `--env-file`
 * precedence (the real environment wins). A missing file is not an error.
 */
export async function loadDotEnv(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return; // missing (or unreadable): nothing to load
  }
  for (const [key, value] of Object.entries(parseDotEnv(raw))) {
    const current = Deno.env.get(key);
    if (current === undefined || current.trim() === "") {
      Deno.env.set(key, value);
    }
  }
}
