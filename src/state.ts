/**
 * Incremental-sync state: a small JSON file remembering the newest issue
 * `updated` timestamp observed by the previous clean run, so the next run
 * can query only what changed since. Lives next to the issues folder, not
 * inside it, so it never collides with issue files or pruning.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SyncState } from "./types.ts";

/** Path of the state file, sibling of the issues output dir. */
export function statePath(outDir: string): string {
  const grandParent = dirname(dirname(outDir));
  return join(grandParent, ".state.json");
}

/** Load the state file, or undefined when absent/corrupt (full sync). */
export async function loadState(
  path: string,
): Promise<SyncState | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    if (typeof parsed.maxUpdated !== "string" || !parsed.maxUpdated) {
      return undefined;
    }
    return parsed as SyncState;
  } catch {
    return undefined;
  }
}

/** Persist the state file (after a clean run). */
export async function saveState(
  path: string,
  state: SyncState,
): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2) + "\n");
}
