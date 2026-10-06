/** Progress reporting for the jira-local CLI. */

import type { ProgressProps } from "./types/progress.ts";

/** Report a progress step to stderr with a local timestamp. */
export function progress({ msg }: ProgressProps): void {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.error(`[${time}] ${msg}`);
}
