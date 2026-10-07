/** Options for a single progress report. */

/** Where a task is in its lifecycle. */
export type TaskStatus = "start" | "ok" | "fail" | "stop";

/**
 * A progress report.
 *
 * With no `task`, this is a plain log line and `msg` is the text to print.
 *
 * With a `task`, it is a lifecycle line rendered in place on a terminal (a
 * spinner while `start`, a tick on `ok`, a cross on `fail`). Any subset of
 * props may be passed: whatever is omitted is inherited from the task's
 * stored state, so a resolve never has to repeat the label. `ok`/`fail` on a
 * task that was never started is valid — for a task that takes no time, there
 * is nothing to spin and the line simply resolves.
 */
export interface ProgressProps {
  /** Task id. Omit for a plain log line. */
  task?: string;
  /** Label text. Updates the stored label when provided. */
  msg?: string;
  /** Lifecycle position. Updates the stored status when provided. */
  status?: TaskStatus;
  /**
   * Add this much to the task's internal counter. Not rendered yet; counting is
   * independent of the lifecycle, so `inc` leaves the spinner and the displayed
   * status alone. Ignored without a `task` (there is no row to count into).
   */
  inc?: number;
}
