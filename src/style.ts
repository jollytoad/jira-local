/**
 * Colour for the interactive task block.
 *
 * Thin wrappers over `@std/fmt/colors` with one job of our own: deciding when
 * colour is wanted. `NO_COLOR` is handled inside `@std/fmt` itself —
 * `setColorEnabled()` refuses to re-enable colour once Deno sets noColor — so
 * the gate here only covers FORCE_COLOR, TERM, and the TTY check.
 *
 * The wrappers return the input unchanged when colour is off, so a stray call
 * can never leak escape bytes into piped output or a redirected file.
 */
import process from "node:process";
import {
  bold,
  brightGreen,
  brightRed,
  brightYellow,
  gray,
  setColorEnabled,
} from "@std/fmt/colors";

function colourWanted(): boolean {
  const force = process.env.FORCE_COLOR;
  if (
    force !== undefined && force !== "" && force !== "0" && force !== "false"
  ) {
    return true;
  }
  if (process.env.TERM === "dumb") return false;
  return process.stdout.isTTY === true;
}

// Applied once at import: every call site paints through these wrappers.
setColorEnabled(colourWanted());

/**
 * Spinner frame while a task is in progress.
 *
 * Bright yellow rather than yellow: the normal intensity reads dull against a
 * dark background, and the bright shade is the closest thing to the orange the
 * spinner was after in the basic palette.
 */
export function busy(text: string): string {
  return brightYellow(text);
}

/** Resolved tick, on both `ok` and `stop`. */
export function done(text: string): string {
  return brightGreen(text);
}

/** Failure cross. */
export function failed(text: string): string {
  return brightRed(text);
}

/** De-emphasised dot leader between a label and its tally. */
export function muted(text: string): string {
  return gray(text);
}

/** The tally itself, so the numbers read off the dots. */
export function strong(text: string): string {
  return bold(text);
}
