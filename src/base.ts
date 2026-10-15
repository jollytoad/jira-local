/**
 * The merge base for each issue: the version that was last in sync with Jira.
 *
 * After a pull the base becomes the *rendered* Jira version, never the merged
 * file. Otherwise `base -> local` would carry your own edits as well as
 * `base -> jira`, and every later Jira change would conflict with itself.
 *
 * It lives outside the issues folder because `scanManagedCategories` manages
 * every directory below `.jira/issues/`.
 */

import {
  constants,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./atomic.ts";
import { BASE_DIR } from "./constants.ts";

export function basePath(key: string): string {
  return join(BASE_DIR, `${key}.md`);
}

export async function readBase(key: string): Promise<string | undefined> {
  return await readText(basePath(key));
}

export async function removeBase(key: string): Promise<void> {
  await rm(basePath(key), { force: true });
}

/**
 * A new base is a clone of a file already holding exactly this text, which
 * shares blocks on APFS and btrfs and falls back to a plain copy anywhere else.
 * Never a hard link: an editor that writes in place would rewrite the base and
 * the next merge would silently lose its ancestor.
 */
export async function writeBase(
  key: string,
  text: string,
  cloneFrom?: string,
): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true });
  const path = basePath(key);
  if (cloneFrom !== undefined && await exists(cloneFrom)) {
    try {
      await copyFile(cloneFrom, path, constants.COPYFILE_FICLONE);
      return;
    } catch {
      // A clone is an optimisation; the plain write below is the real path.
    }
  }
  await writeAtomic(path, text);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
