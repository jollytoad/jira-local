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
 *
 * Precedence: NO_COLOR (inside @std, which cannot be overridden) beats the
 * explicit `--no-color`, which beats FORCE_COLOR / TERM=dumb / the TTY check.
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

// Applied at import, so the gate is settled before anything paints — including
// cliffy's help output, which follows the same @std/fmt colour state. The CLI
// calls `disableColour` once `--no-color` has been parsed.
setColorEnabled(colourWanted());

/**
 * Honour an explicit `--no-color`, for the rest of the run. One-way by design:
 * there is no `--color`, so the flag can only ever take colour away, which is why
 * it needs no state of its own — `NO_COLOR` needs no handling either, since
 * @std/fmt already leaves colour off and refuses to turn it back on.
 *
 * Cliffy's help output is out of reach of any flag: it renders before option
 * actions fire. Help follows `NO_COLOR` and the TTY check instead.
 */
export function disableColour(): void {
  setColorEnabled(false);
}

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
