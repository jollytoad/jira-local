/**
 * New issues, declared as top-level headings in markdown.
 *
 * Three places hold one: a file in `issues/new/`, a file in `issues/all/`
 * whose name is not issue-key shaped, and an extra top-level heading in an
 * issue file that already exists. Every heading declares one issue, so a single
 * file can hold as many as you like.
 *
 * The first heading of an issue file is that issue's own title, so only the
 * ones after it declare. Anything written before a declaration is left alone —
 * notes at the top of a scratch file are the user's, not ours to tidy away.
 *
 * A heading inside a fenced block is not a heading, so a code sample with a
 * `# comment` in it declares nothing.
 */

import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { test } from "@std/front-matter/test";
import type { Dirent } from "node:fs";
import { issueKeyFromFileName, listIssueFiles } from "./mirror.ts";
import { NEW_DIR_NAME } from "./constants.ts";
import type { Declaration } from "./types/jira-local.ts";

/** `#`, then a space or the end of the line. `##` and `#tag` are not headings. */
const HEADING = /^#(?=[ \t]|$)[ \t]*(.*)$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})\s*(\S*)\s*$/;
/**
 * A `[Type]` marker, which people write at either end of a heading — `# [Bug]
 * the title` as readily as `# the title [Bug]` — so both are read. Either form
 * needs whitespace on its inner side, which is what keeps `# see [1]` and
 * `# array[0]` out of it.
 */
const LEADING_TYPE = /^[ \t]*\[([^\][]+)\][ \t]+/;
const TRAILING_TYPE = /\s+\[([^\][]+)\][ \t]*$/;

export interface ScanOptions {
  absPath: string;
  relPath: string;
  /** The issue this file belongs to, when it is a mirrored issue file. */
  hostKey?: string;
  /**
   * The type names the project really has. Without them no marker is stripped,
   * so a name that is not a type keeps its brackets and nothing is lost.
   */
  typeNames?: readonly string[];
}

export interface ScanResult {
  declarations: Declaration[];
  /** The text with every declaration cut out, which is what push then reads. */
  stripped: string;
}

/** A file that can hold a declaration. */
export interface DeclarationSource {
  absPath: string;
  relPath: string;
  /** The mirrored issue this file belongs to, or undefined for a loose file. */
  hostKey?: string;
  /** True for a file that is not an issue, which is deleted once emptied. */
  standalone: boolean;
}

/**
 * Every file that can hold a declaration: the mirrored issues, the loose files
 * beside them, and everything in `issues/new`.
 */
export async function declarationSources(
  allDir: string,
  projectKey: string,
): Promise<DeclarationSource[]> {
  const categoriesDir = dirname(allDir);
  const out: DeclarationSource[] = [];
  for (const ref of await listIssueFiles(allDir, projectKey)) {
    out.push({
      absPath: ref.absPath,
      relPath: ref.relPath,
      hostKey: ref.key,
      standalone: false,
    });
  }
  out.push(...await looseFiles(allDir, categoriesDir));
  out.push(
    ...await looseFiles(join(categoriesDir, NEW_DIR_NAME), categoriesDir),
  );
  return out;
}

async function looseFiles(
  dir: string,
  categoriesDir: string,
): Promise<DeclarationSource[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // no scratch folder yet, which is the common case
  }
  return entries
    .filter((entry) =>
      entry.isFile() && !entry.name.startsWith(".") &&
      entry.name.endsWith(".md") &&
      issueKeyFromFileName(entry.name) === undefined
    )
    .map((entry) => {
      const absPath = join(dir, entry.name);
      return {
        absPath,
        relPath: relative(categoriesDir, absPath).replaceAll("\\", "/"),
        standalone: true,
      };
    });
}

/** The declared chunks in a file, and the file with them taken out. */
export function scanDeclarations(
  text: string,
  options: ScanOptions,
): ScanResult {
  const lines = text.split("\n");
  const startLine = bodyStartLine(text, lines);
  const marks = headingsOf(lines, startLine);
  // An issue file's own title comes first; a loose file has no title to spare.
  const chunks = options.hostKey === undefined ? marks : marks.slice(1);
  const declarations = chunks.map((mark) =>
    declarationAt(lines, mark, mark.next, options)
  );
  return {
    declarations,
    // A file with no declarations must come back byte for byte: it is compared
    // against the base, and losing so much as a trailing newline would make
    // every untouched issue look edited.
    stripped: declarations.length === 0 ? text : cut(lines, startLine, chunks),
  };
}

/**
 * The same file with the declarations at `lines` taken out. Used to clear a
 * declaration once its issue exists, and never to touch anything else.
 */
export function removeDeclarations(
  text: string,
  options: ScanOptions,
  drop: readonly number[],
): string {
  if (drop.length === 0) return text;
  const all = text.split("\n");
  const startLine = bodyStartLine(text, all);
  const marks = headingsOf(all, startLine);
  const first = options.hostKey === undefined ? 0 : 1;
  const keep = new Set(drop);
  return cut(
    all,
    startLine,
    marks.filter((m, i) => i >= first && keep.has(m.line + 1)),
  );
}

/** The text after any front matter, trimmed. */
export function bodyText(text: string): string {
  const lines = text.split("\n");
  return lines.slice(bodyStartLine(text, lines)).join("\n").trim();
}

interface Mark {
  /** 0-based line of the heading. */
  line: number;
  /** 0-based line of the next heading, or the end of the file. */
  next: number;
  /** The heading's text, trimmed. */
  text: string;
}

/** Every top-level heading outside a fenced block. */
function headingsOf(
  lines: readonly string[],
  startLine: number,
): Mark[] {
  const found: Array<{ line: number; text: string }> = [];
  let fence: string | undefined;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const block = FENCE.exec(line);
    if (block !== null) {
      const marker = block[1] ?? "";
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      found.push({ line: i, text: (heading[1] ?? "").trim() });
    }
  }
  return found.map((mark, index) => ({
    ...mark,
    next: found[index + 1]?.line ?? lines.length,
  }));
}

function declarationAt(
  lines: readonly string[],
  mark: Mark,
  next: number,
  options: ScanOptions,
): Declaration {
  const body = lines.slice(mark.line + 1, next).join("\n").trim();
  const chunk = lines.slice(mark.line, next).join("\n").trim();
  const marked = markerOf(mark.text);
  // Only a name the project really has is a marker. Anything else stays in the
  // summary, so `# Cache it [urgent]` loses nothing to a guess.
  const typeHint = marked === undefined
    ? undefined
    : options.typeNames?.find((name) =>
      name.toLowerCase() === marked.name.toLowerCase()
    );
  return {
    summary: typeHint === undefined || marked === undefined
      ? mark.text
      : marked.rest,
    ...(marked === undefined ? {} : { marker: marked.name }),
    ...(typeHint === undefined ? {} : { typeHint }),
    body,
    chunk,
    line: mark.line + 1,
    ...(options.hostKey === undefined ? {} : { hostKey: options.hostKey }),
    absPath: options.absPath,
    relPath: options.relPath,
  };
}

/** The `[Type]` in a heading and the heading without it, whichever end it is on. */
function markerOf(
  text: string,
): { name: string; rest: string } | undefined {
  const leading = LEADING_TYPE.exec(text);
  if (leading !== null) {
    return {
      name: (leading[1] ?? "").trim(),
      rest: text.slice(leading[0].length),
    };
  }
  const trailing = TRAILING_TYPE.exec(text);
  if (trailing !== null) {
    return {
      name: (trailing[1] ?? "").trim(),
      rest: text.replace(TRAILING_TYPE, "").trim(),
    };
  }
  return undefined;
}

/**
 * The lines left after `dropped` are cut, front matter included. A cut also
 * takes the blank line in front of it, so what joins up is one blank line
 * rather than three, and the text on either side is untouched.
 */
function cut(
  lines: readonly string[],
  startLine: number,
  dropped: readonly Mark[],
): string {
  if (dropped.length === 0) return lines.join("\n");
  const kept: string[] = [];
  // From line 0, not from the body: the front matter is not part of any
  // declaration and must come back out unchanged.
  let cursor = 0;
  for (const mark of [...dropped].sort((a, b) => a.line - b.line)) {
    let from = Math.max(mark.line, startLine);
    while (from > cursor && (lines[from - 1] ?? "").trim() === "") from--;
    kept.push(...lines.slice(cursor, from));
    cursor = mark.next;
  }
  kept.push(...lines.slice(cursor));
  const text = kept.join("\n").replace(/\s+$/, "");
  // A file that ended with a newline still does, so cutting a declaration does
  // not also reformat the file around it.
  return lines[lines.length - 1] === "" ? `${text}\n` : text;
}

/** 0-based line of the first body line: past any front matter. */
function bodyStartLine(text: string, lines: readonly string[]): number {
  if (!test(text)) return 0;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") return i + 1;
  }
  return 0;
}
