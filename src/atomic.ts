/**
 * Whole-file replacement, done so an interrupted write cannot leave a
 * half-written issue file. `rename` is atomic, but only within a filesystem, so
 * the temp file has to be a sibling of the target.
 */

import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";

let counter = 0;

export async function writeAtomic(path: string, text: string): Promise<void> {
  counter += 1;
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${counter}.tmp`,
  );
  try {
    await writeFile(temp, text);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
