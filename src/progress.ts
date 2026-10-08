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
 * A terminal also gets colour (yellow spinner, green tick, red cross, muted dot
 * leader, bold tally — all at bright intensity; see style.ts). Piped output,
 * `--verbose`, and plain lines stay colour-free, so logs never carry escape
 * codes. The gate is NO_COLOR / --no-color / FORCE_COLOR / TERM=dumb / TTY.
 *
 * A call with no `task` is always a plain line: the per-file create/update
 * events that make up most of a pull's output are events, not lifecycle steps.
 *
 * Everything goes to stdout, progress included: the tool's real output is the
 * files it writes, so there is nothing here worth holding off stdout.
 */

import process from "node:process";
import { busy, done, failed, muted, strong } from "./style.ts";
import type { ProgressProps, TaskStatus } from "./types/progress.ts";

/** Braille spinner frames. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SPINNER_INTERVAL_MS = 80;

/**
 * U+FE0E, the text-presentation selector.
 *
 * `✔` and `✘` have emoji variants, so a terminal whose primary font lacks the
 * dingbat falls back to a colour emoji font and draws the glyph in its own
 * colours, ignoring whatever foreground colour it was given. Pinning text
 * presentation forbids the substitution. The selector is zero-width, so it is
 * stripped again before anything measures a row (see `bareGlyph`).
 */
const TEXT_PRESENTATION = "\uFE0E";

/** Glyph for a task that has resolved. */
const STATUS_GLYPHS: Record<Exclude<TaskStatus, "start">, string> = {
  ok: `✔${TEXT_PRESENTATION}`,
  fail: `✘${TEXT_PRESENTATION}`,
  stop: `✔${TEXT_PRESENTATION}`,
};

/** Used when the terminal reports no usable width (piped, or a pty giving 0). */
const FALLBACK_COLUMNS = 80;

const ESC = "\u001b";
/** Erase the current line and return the cursor to column one. */
const CLEAR_LINE = `${ESC}[2K`;
/** Move the cursor up `n` rows. */
const UP = (n: number) => `${ESC}[${n}A`;

interface TaskState {
  msg: string;
  status: TaskStatus;
  count?: number;
}

/** Live tasks by id, in insertion order. */
const tasks = new Map<string, TaskState>();

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
export function progress({ task: id, msg, status, inc }: ProgressProps): void {
  if (id === undefined) {
    plainLine(msg ?? "");
    return;
  }

  const task = advance(id, msg, status, inc);
  // A `stop` reports work that actually happened, so a task that never counted
  // has nothing to report: drop the row rather than print a bare "stopped".
  const dropped = task.status === "stop" && task.count === undefined;
  if (dropped) tasks.delete(id);
  if (plain()) {
    if (!dropped) plainLine(describe(task));
    return;
  }
  switch (task.status) {
    case "start":
      startSpinner();
      break;
    case "ok":
    case "fail":
    case "stop":
      stopSpinner();
      break;
  }
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
  inc: number | undefined,
): TaskState {
  const existing = tasks.get(id);
  const task: TaskState = {
    msg: msg ?? existing?.msg ?? "",
    status: status ?? existing?.status ?? "start",
    count: typeof inc === "number" && Number.isFinite(inc)
      ? (existing?.count ?? 0) + inc
      : existing?.count,
  };
  tasks.set(id, task);
  return task;
}

/**
 * The text of a task line. A running task is marked with a trailing ellipsis,
 * which only shows in plain mode: on a terminal the spinner already says the
 * task is in progress, and the line persists once it resolves. A counted task
 * carries its tally, plain-mode style: there is no width to align against.
 */
function describe(task: TaskState): string | undefined {
  if (task.status === "stop") return;
  const base = task.status === "start"
    ? `${task.msg}...`
    : `${task.msg} ${task.status}`;
  return task.count === undefined ? base : `${base} (${task.count})`;
}

/** A timestamped line: the format for every non-task report. */
function plainLine(text: string | undefined): void {
  if (text !== undefined) {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    emit(`[${time}] ${text}`);
  }
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
 * A glyph without its text-presentation selector: the columns it actually
 * costs. Every width in a row is measured from these, never from the painted
 * string or the selector-laden glyph.
 */
function bareGlyph(glyphText: string): string {
  return glyphText.replaceAll(TEXT_PRESENTATION, "");
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

/**
 * The current task block as display rows, trimmed to the terminal width.
 *
 * A counted task pins its tally to the right edge with dots filling the gap, so
 * the numbers line up as they grow. Unbracketed here: on a terminal the dots
 * already set the tally apart, and brackets only clutter the aligned edge. Plain
 * mode, with no dots to do that work, keeps them. If both will not fit, the
 * message gives way rather than the tally — the count is the part that cannot be
 * read off the line.
 *
 * Rows are held to one column short of the terminal width: a row that exactly
 * fills the last column still wraps on some terminals.
 *
 * Colour is layered on at assembly, and the dot/column budget is measured on
 * the plain text only: escape bytes are invisible but count toward a string's
 * length, so they would otherwise push the tally off the right edge.
 */
function renderTasks(): string[] {
  const width = columns() - 1;
  return [
    ...tasks.values().map((task) => {
      const tick = glyph(task.status);
      const mark = task.status === "start"
        ? busy(tick)
        : task.status === "fail"
        ? failed(tick)
        : done(tick);
      // Measured from the bare glyph: the painted mark renders the same
      // columns, but neither its escape bytes nor the zero-width selector in
      // `tick` may count against the budget.
      const bare = bareGlyph(tick);
      const left = `${bare} ${task.msg}`;
      if (task.count === undefined) {
        return paintMark(left.slice(0, width), bare, mark);
      }
      const right = String(task.count);
      // Two of the budget go on the spaces flanking the dots.
      const dots = width - left.length - right.length - 2;
      if (dots < 1) {
        return paintMark(`${left} ${right}`.slice(-width), bare, mark);
      }
      return `${mark} ${task.msg} ${muted(".".repeat(dots))} ${strong(right)}`;
    }),
  ];
}

/**
 * Swap the leading glyph of a trimmed row for its coloured mark. If the trim
 * cut the glyph off entirely there is nothing to colour — keep the row plain
 * rather than corrupting escape bytes.
 */
function paintMark(row: string, bare: string, mark: string): string {
  return row.startsWith(bare) ? mark + row.slice(bare.length) : row;
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
