/**
 * On a terminal, each task gets one live line (spinner, then tick or cross).
 * Anywhere else — a pipe, or `--verbose` — every call prints one timestamped
 * plain line instead. Progress goes to stdout along with everything else: this
 * tool's real output is the files it writes, so there is nothing here worth
 * holding back.
 */

import process from "node:process";
import { busy, done, failed, muted, strong } from "./style.ts";
import type { ProgressProps, TaskStatus } from "./types/progress.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SPINNER_INTERVAL_MS = 80;

// U+FE0E, the text-presentation selector. `✔` and `✘` have emoji variants, so a
// terminal lacking the dingbat substitutes an emoji font and paints the glyph in
// its own colours, ignoring ours. This pins text presentation; it is zero-width,
// so `bareGlyph` strips it again before anything measures a row.
const TEXT_PRESENTATION = "\uFE0E";

const STATUS_GLYPHS: Record<Exclude<TaskStatus, "start">, string> = {
  ok: `✔${TEXT_PRESENTATION}`,
  fail: `✘${TEXT_PRESENTATION}`,
  stop: `✔${TEXT_PRESENTATION}`,
};

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

const tasks = new Map<string, TaskState>();

let frame = 0;
let spinner: ReturnType<typeof setInterval> | undefined;
let verbose = false;
// Task rows on screen, so the block can be redrawn in place.
let rendered = 0;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function progress({ task: id, msg, status, inc }: ProgressProps): void {
  if (id === undefined) {
    plainLine(msg ?? "");
    return;
  }

  const task = advance(id, msg, status, inc);
  // A `stop` reports work that happened, so a task that never counted has
  // nothing to report: drop the row rather than print a bare "stopped".
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

/** Anything omitted is inherited from the task's stored state. */
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

// The ellipsis only appears in plain mode: a terminal already spins, and the
// line persists once resolved. The tally is bracketed here for the same reason
// there are no dots to set it apart.
function describe(task: TaskState): string | undefined {
  if (task.status === "stop") return;
  const base = task.status === "start"
    ? `${task.msg}...`
    : `${task.msg} ${task.status}`;
  return task.count === undefined ? base : `${base} (${task.count})`;
}

function plainLine(text: string | undefined): void {
  if (text !== undefined) {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    emit(`[${time}] ${text}`);
  }
}

function plain(): boolean {
  return verbose || process.stdout.isTTY !== true;
}

function columns(): number {
  const width = process.stdout.columns;
  return typeof width === "number" && width > 0 ? width : FALLBACK_COLUMNS;
}

function glyph(status: TaskStatus): string {
  if (status === "start") return SPINNER_FRAMES[frame] ?? " ";
  return STATUS_GLYPHS[status];
}

/**
 * A glyph without its text-presentation selector: the columns it actually
 * costs. Widths are always measured from these, never from the painted string.
 */
function bareGlyph(glyphText: string): string {
  return glyphText.replaceAll(TEXT_PRESENTATION, "");
}

/**
 * Redraw the task block, reusing the rows already on screen. A plain line
 * arriving mid-block would land on top of it, so `emit` steps over the block
 * first and redraws it underneath.
 */
function redraw(): void {
  const rows = renderTasks();
  let out = rendered > 0 ? UP(rendered) : "";
  for (const row of rows) out += `${CLEAR_LINE}${row}\n`;
  rendered = rows.length;
  write(out);
}

/**
 * The task block as display rows. A counted task pins its tally to the right
 * edge with dots filling the gap, so the numbers align as they grow; when
 * both will not fit the message gives way, because the count is the part that
 * cannot be read off the line.
 *
 * Rows stop one column short of the terminal width, since a row that exactly
 * fills the last column still wraps on some terminals. The dot budget is
 * measured on the plain text only: escape bytes are invisible but count
 * toward a string's length, so they would push the tally off the edge.
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
      // The painted mark renders the same columns as the bare glyph, but neither
      // its escape bytes nor the zero-width selector may count as width.
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

// If the trim cut the glyph off there is nothing to colour; keeping the row
// plain is better than corrupting the escape bytes.
function paintMark(row: string, bare: string, mark: string): string {
  return row.startsWith(bare) ? mark + row.slice(bare.length) : row;
}

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
