/**
 * Incremental-pull watermark: the newest `updated` seen by the previous clean
 * run. It sits outside the issues folder so pruning cannot delete it.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { PullState } from "./types/jira-local.ts";
import { JIRA_DIR } from "./constants.ts";

export function statePath(): string {
  return join(process.cwd(), JIRA_DIR, ".state.json");
}

/** A corrupt or watermark-less file reads as absent, forcing a full pull. */
export async function loadState(
  path: string,
): Promise<PullState | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PullState>;
    if (typeof parsed.maxUpdated !== "string" || !parsed.maxUpdated) {
      return undefined;
    }
    return parsed as PullState;
  } catch {
    return undefined;
  }
}

export async function saveState(
  path: string,
  state: PullState,
): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2) + "\n");
}
