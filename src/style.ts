/**
 * Colour gate for the task block. `NO_COLOR` is handled inside `@std/fmt`
 * (which refuses to re-enable colour once Deno's noColor is set), so this
 * only covers FORCE_COLOR, TERM=dumb and the TTY check. Wrappers return the
 * input untouched when colour is off, so escape bytes can never reach a pipe.
 *
 * Precedence: NO_COLOR > `--no-color` > FORCE_COLOR / TERM=dumb / TTY.
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

// At import, so the gate is settled before anything paints — including
// cliffy's help, which reads the same @std/fmt colour state.
setColorEnabled(colourWanted());

// One-way: there is no `--color`, so the flag can only take colour away.
export function disableColour(): void {
  setColorEnabled(false);
}

/** Bright yellow because plain yellow reads dull on a dark background. */
export function busy(text: string): string {
  return brightYellow(text);
}

export function done(text: string): string {
  return brightGreen(text);
}

export function failed(text: string): string {
  return brightRed(text);
}

export function muted(text: string): string {
  return gray(text);
}

export function strong(text: string): string {
  return bold(text);
}
