/**
 * Progress reporting for the jira-local CLI.
 *
 * Two modes, chosen automatically:
 *
 * - On a terminal, task lines (see `ProgressProps`) render in place: a spinner
 *   while the task runs, a tick once it succeeds, a cross if it fails.
 *   Resolved lines stay on screen as a record of what happened.
 * - Everywhere else (output redirected, or `--verbose`), every call prints one
 *   plain timestamped line, so logs stay readable and free of control codes.
 *
 * A call with no `task` is always a plain line: the per-file create/update
 * events that make up most of a pull's output are events, not lifecycle steps.
 *
 * Everything goes to stdout, progress included: the tool's real output is the
 * files it writes, so there is nothing here worth holding off stdout.
 */

import process from "node:process";
import type { ProgressProps, TaskStatus } from "./types/progress.ts";

/** Braille spinner frames. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SPINNER_INTERVAL_MS = 80;

/** Glyph for a task that has resolved. */
const STATUS_GLYPHS: Record<Exclude<TaskStatus, "start">, string> = {
  ok: "✔",
  fail: "✘",
};

/** Used when the terminal reports no usable width (piped, or a pty giving 0). */
const FALLBACK_COLUMNS = 80;

const ESC = "\u001b";
/** Erase the current line and return the cursor to column one. */
const CLEAR_LINE = `${ESC}[2K`;
/** Move the cursor up `n` rows. */
const UP = (n: number) => `${ESC}[${n}A`;

interface Task {
  msg: string;
  status: TaskStatus;
}

/** Live tasks by id, in insertion order. */
const tasks = new Map<string, Task>();

let frame = 0;
/** Deno's Node-compat layer types this as a `Timeout`, not a number. */
let spinner: ReturnType<typeof setInterval> | undefined;
let verbose = false;
/** Task rows currently on screen, so the block can be redrawn in place. */
let rendered = 0;

/** Force plain-line mode regardless of whether stdout is a terminal. */
export function setVerbose(value: boolean): void {
  verbose = value;
}

/**
 * Report a step. With no `task` this is a plain log line; with one it advances
 * that task's lifecycle line.
 *
 * Anything omitted is inherited from the task's stored state, so a resolve
 * passes only its id. Nothing here throws: a task id with no prior call, a
 * status with no label, or an empty `progress({})` all render rather than
 * fail. That keeps call sites free of error handling.
 */
export function progress({ task: id, msg, status }: ProgressProps): void {
  if (id === undefined) {
    plainLine(msg ?? "");
    return;
  }

  const task = advance(id, msg, status);
  if (plain()) {
    plainLine(describe(task));
    return;
  }
  if (task.status === "start") startSpinner();
  else stopSpinner();
  redraw();
}

/** Resolve every still-running task as failed. */
export function failAll(): void {
  const failures = [...tasks.values()].filter((task) =>
    task.status === "start"
  );
  for (const task of failures) task.status = "fail";
  if (failures.length === 0) return;
  if (plain()) {
    for (const task of failures) plainLine(describe(task));
  } else {
    redraw();
  }
  stopSpinner();
}

/** Merge a call into a task's stored state, returning the resulting task. */
function advance(
  id: string,
  msg: string | undefined,
  status: TaskStatus | undefined,
): Task {
  const existing = tasks.get(id);
  const task: Task = {
    msg: msg ?? existing?.msg ?? "",
    status: status ?? existing?.status ?? "start",
  };
  tasks.set(id, task);
  return task;
}

/**
 * The text of a task line. A running task is marked with a trailing ellipsis,
 * which only shows in plain mode: on a terminal the spinner already says the
 * task is in progress, and the line persists once it resolves.
 */
function describe(task: Task): string {
  if (task.status === "start") return `${task.msg}...`;
  return `${task.msg} ${task.status}`;
}

/** A timestamped line: the format for every non-task report. */
function plainLine(text: string): void {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  emit(`[${time}] ${text}`);
}

/** Whether to use plain lines: forced by `--verbose`, or no terminal. */
function plain(): boolean {
  return verbose || process.stdout.isTTY !== true;
}

/** Terminal width, defaulting when unknown. */
function columns(): number {
  const width = process.stdout.columns;
  return typeof width === "number" && width > 0 ? width : FALLBACK_COLUMNS;
}

/** The leading glyph for a task: a spinner frame, or the resolved mark. */
function glyph(status: TaskStatus): string {
  if (status === "start") return SPINNER_FRAMES[frame] ?? " ";
  return STATUS_GLYPHS[status];
}

/**
 * Redraw the task block, reusing the rows already on screen.
 *
 * A plain line arriving mid-block would land on top of it, so `emit` steps
 * over the block first and redraws it underneath.
 */
function redraw(): void {
  const rows = renderTasks();
  let out = rendered > 0 ? UP(rendered) : "";
  for (const row of rows) out += `${CLEAR_LINE}${row}\n`;
  rendered = rows.length;
  write(out);
}

/** The current task block as display rows, trimmed to the terminal width. */
function renderTasks(): string[] {
  const width = columns() - 1;
  return [...tasks.values()].map((task) =>
    `${glyph(task.status)} ${task.msg}`.slice(0, width)
  );
}

/**
 * Write one permanent line, keeping any rendered task block above it and
 * restoring it below.
 */
function emit(text: string): void {
  const line = `${text}\n`;
  if (rendered === 0) {
    write(line);
    return;
  }
  let out = UP(rendered);
  out += `${CLEAR_LINE}${text}\n`;
  for (const row of renderTasks()) out += `${CLEAR_LINE}${row}\n`;
  write(out);
}

function startSpinner(): void {
  if (spinner !== undefined) return;
  spinner = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    if (!plain()) redraw();
  }, SPINNER_INTERVAL_MS);
}

function stopSpinner(): void {
  if (spinner === undefined) return;
  clearInterval(spinner);
  spinner = undefined;
}

function write(text: string): void {
  process.stdout.write(text);
}
