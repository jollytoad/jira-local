export type TaskStatus = "start" | "ok" | "fail" | "stop";

/**
 * With no `task`, this is a plain log line. With one, it advances that task's
 * lifecycle line, and anything omitted is inherited from the task's stored
 * state, so a resolve only needs its id. `ok`/`fail` on a task that was never
 * started is valid: a task that takes no time has nothing to spin.
 */
export interface ProgressProps {
  task?: string;
  msg?: string;
  status?: TaskStatus;
  /**
   * Counting is independent of the lifecycle, so this touches neither the
   * spinner nor the status. Ignored without a `task` (no row to count into).
   */
  inc?: number;
}
