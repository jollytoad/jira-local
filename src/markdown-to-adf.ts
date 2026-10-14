/**
 * Markdown -> Atlassian Document Format, the reverse of `adf-to-markdown.ts`.
 *
 * Strict on purpose. ADF is a documented tree, and this covers only the subset
 * that the forward direction emits, so a description this module can read is a
 * description it can write back without losing structure. Anything else throws
 * and names the construct: silently flattening a table inside someone's Jira
 * issue is worse than refusing.
 */

import type { AdfMark, AdfNode } from "./types/adf.ts";

export class MarkdownUnsupportedError extends Error {
  constructor(construct: string, detail?: string) {
    super(
      `cannot convert ${construct} to ADF${
        detail ? ` (${detail})` : ""
      }. Narrow the description to headings, paragraphs, lists, code blocks, ` +
        `quotes and rules, then try again.`,
    );
    this.name = "MarkdownUnsupportedError";
  }
}

export function markdownToAdf(markdown: string): AdfNode {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const { nodes } = parseBlocks(lines, 0);
  return { version: 1, type: "doc", content: nodes } as AdfNode;
}

interface Block {
  nodes: AdfNode[];
  index: number;
}

function parseBlocks(lines: readonly string[], start: number): Block {
  const nodes: AdfNode[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1] ?? "";
      const language = fence[2] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const current = lines[i] ?? "";
        if (
          new RegExp(`^\\s*${marker[0] ?? "`"}{${marker.length},}\\s*$`).test(
            current,
          )
        ) {
          i++;
          break;
        }
        body.push(current);
        i++;
      }
      // One trailing newline before the closing fence is dropped, which is what
      // `adf-to-markdown.ts` does on the way out. Keeping it would make the
      // next pull see the description as edited.
      nodes.push(codeBlock(body.join("\n").replace(/\n$/, ""), language));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      nodes.push({
        type: "heading",
        attrs: { level: heading[1]?.length ?? 1 },
        content: parseInline((heading[2] ?? "").trim()),
      });
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      nodes.push({ type: "rule" });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      nodes.push({ type: "blockquote", content: parseBlocks(quoted, 0).nodes });
      continue;
    }
    const list = parseList(lines, i);
    if (list) {
      nodes.push(list.node);
      i = list.index;
      continue;
    }
    // A table's rows would read as ordinary paragraphs, so the pipes would
    // land in Jira as literal text. ADF holds a real table node; there is no
    // honest conversion from the markdown shape.
    if (isTableRow(lines, i)) throw new MarkdownUnsupportedError("a table");
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.trim() === "") break;
      if (startsBlock(current)) break;
      paragraph.push(current.trim());
      i++;
    }
    // A soft-wrapped line joins with a space. ADF has no line break inside a
    // paragraph, and `adf-to-markdown.ts` emits one line per paragraph, so
    // joining with a newline here would show up as an edit on the next pull.
    nodes.push({
      type: "paragraph",
      content: parseInline(paragraph.join(" ")),
    });
  }
  return { nodes, index: i };
}

/**
 * A pipe-delimited row, which this converter does not support. The `|` is the
 * only signal that survives when the cells are unaligned, so one pipe on its
 * own line is enough to refuse.
 */
function isTableRow(lines: readonly string[], index: number): boolean {
  const line = (lines[index] ?? "").trim();
  if (!line.startsWith("|")) return false;
  return line.includes("|", 1);
}

/** The line shapes that interrupt a paragraph rather than continuing it. */
function startsBlock(line: string): boolean {
  return /^(#{1,6})\s/.test(line) ||
    /^\s*(`{3,}|~{3,})/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-*+])\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*([-*_])\s*(\1\s*){2,}$/.test(line) ||
    /^\s*\|.*\|/.test(line);
}

const TASK_MARKER = /^\[([ xX])\]\s+/;

/**
 * Each item owns the marker line plus every following line indented past the
 * marker's own column, so nested lists and wrapped text stay inside the item
 * they belong to rather than becoming siblings of it.
 */
function parseList(
  lines: readonly string[],
  start: number,
): { node: AdfNode; index: number } | undefined {
  const first = lines[start] ?? "";
  const kind = itemKind(first);
  if (kind === undefined) return undefined;

  const indent = indentOf(first);
  const markerWidth =
    /^([-*+]|\d+[.)])\s*/.exec(first.trimStart())?.[0].length ?? 0;

  const items: string[][] = [];
  let current: string[] | undefined;
  let pendingBlanks: string[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      pendingBlanks.push("");
      i++;
      continue;
    }

    const at = indentOf(line);
    const thisKind = itemKind(line);

    if (at === indent && thisKind === kind) {
      current = [];
      items.push(current);
      current.push(stripItemMarker(line));
      i++;
      pendingBlanks = [];
      continue;
    }
    // A list of the other kind at the same column ends this one.
    if (at === indent && thisKind !== undefined) break;
    if (at <= indent) break;

    // Deferred blanks belong inside the item only if the list carries on.
    if (current !== undefined && pendingBlanks.length > 0) {
      current.push(...pendingBlanks);
      pendingBlanks = [];
    }
    if (current === undefined) break;
    current.push(dedent(line, indent + markerWidth));
    i++;
  }

  // Trailing blanks after the final item belong to whatever follows the list.
  i -= pendingBlanks.length;
  const bodies = items.map((item) => dropTrailingBlanks(item).join("\n"));
  if (bodies.length === 0) return undefined;

  const isTask = TASK_MARKER.test(bodies[0] ?? "");
  const content = isTask
    ? bodies.map((item, index) => taskItem(item, index))
    : bodies.map((item) => listItem(item));

  const node: AdfNode = {
    type: isTask
      ? "taskList"
      : kind === "ordered"
      ? "orderedList"
      : "bulletList",
    content,
  };
  if (kind === "ordered") {
    const firstNumber = /^\s*(\d+)[.)]\s+/.exec(lines[start] ?? "")?.[1];
    node.attrs = { order: Number(firstNumber ?? 1) };
  }
  return { node, index: i };
}

type ItemKind = "bullet" | "ordered";

function itemKind(line: string): ItemKind | undefined {
  if (/^\s*[-*+]\s+/.test(line)) return "bullet";
  if (/^\s*\d+[.)]\s+/.test(line)) return "ordered";
  return undefined;
}

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

/** Removes up to `width` leading spaces, so short lines are never cut wrong. */
function dedent(line: string, width: number): string {
  let cut = 0;
  while (cut < width && (line[cut] === " " || line[cut] === "\t")) cut++;
  return line.slice(cut);
}

/**
 * The item's own marker, gone. A `- ` line must lose its dash or the list
 * inside `listItem` parses as another list of the same kind, forever.
 */
function stripItemMarker(line: string): string {
  return line.replace(/^\s*([-*+]|\d+[.)])\s+/, "").replace(/^\s+/, "");
}

function dropTrailingBlanks(items: readonly string[]): string[] {
  let end = items.length;
  while (end > 0 && (items[end - 1] ?? "").trim() === "") end--;
  return items.slice(0, end);
}

function listItem(markdown: string): AdfNode {
  const { nodes } = parseBlocks(markdown.split("\n"), 0);
  return {
    type: "listItem",
    content: nodes.length > 0 ? nodes : [paragraph("")],
  };
}

function taskItem(markdown: string, index: number): AdfNode {
  const marker = TASK_MARKER.exec(markdown);
  const state = marker?.[1]?.toLowerCase() === "x" ? "DONE" : "TODO";
  const rest = markdown.slice(marker?.[0].length ?? 0);
  const { nodes } = parseBlocks(rest.split("\n"), 0);
  return {
    type: "taskItem",
    attrs: { state, localId: String(index + 1) },
    content: nodes.length > 0 ? nodes : [paragraph("")],
  };
}

function codeBlock(text: string, language: string): AdfNode {
  return {
    type: "codeBlock",
    ...(language ? { attrs: { language } } : {}),
    content: [{ type: "text", text }],
  };
}

function paragraph(text: string): AdfNode {
  return { type: "paragraph", content: parseInline(text) };
}

// A single left-to-right pass: each delimiter is matched to its partner, so
// nesting costs nothing and an unclosed one degrades to literal text.

export function parseInline(text: string): AdfNode[] {
  if (text === "") return [];
  const nodes: AdfNode[] = [];
  let plain = "";
  let i = 0;

  const flush = () => {
    if (plain !== "") nodes.push({ type: "text", text: plain });
    plain = "";
  };

  while (i < text.length) {
    const rest = text.slice(i);

    if (rest.startsWith("<u>")) {
      flush();
      const end = rest.indexOf("</u>");
      if (end < 0) throw new MarkdownUnsupportedError("an unclosed <u> tag");
      for (const node of parseInline(rest.slice(3, end))) {
        nodes.push({
          ...node,
          marks: [{ type: "underline" }, ...(node.marks ?? [])],
        });
      }
      i += end + 4;
      continue;
    }
    const lineBreak = /^<br\s*\/?>/.exec(rest);
    if (lineBreak) {
      flush();
      nodes.push({ type: "hardBreak" });
      i += lineBreak[0].length;
      continue;
    }
    if (rest.startsWith("<")) {
      const tag = /^<\/?([a-zA-Z][\w-]*)/.exec(rest)?.[1] ?? "";
      throw new MarkdownUnsupportedError(
        `raw HTML (${tag ? `<${tag}>` : "a tag"})`,
        "only <u> and <br> round-trip",
      );
    }
    if (rest.startsWith("![")) throw new MarkdownUnsupportedError("an image");
    // The renderer stands an attachment in as a link because the file is only
    // reachable by its id. There is no markdown a file like that converts to.
    if (rest.startsWith("[attachment:")) {
      throw new MarkdownUnsupportedError("an attachment reference");
    }

    const code = /^(`+)([^`]+?)\1(?!`)/.exec(rest);
    if (code) {
      flush();
      nodes.push(marked(code[2] ?? "", { type: "code" }));
      i += code[0].length;
      continue;
    }

    const marks = wrapped(rest);
    if (marks) {
      flush();
      nodes.push(...marks.nodes);
      i += marks.length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      nodes.push(
        marked(link[1] ?? "", { type: "link", attrs: { href: link[2] ?? "" } }),
      );
      i += link[0].length;
      continue;
    }

    plain += rest[0] ?? "";
    i++;
  }
  flush();
  return nodes;
}

/** The inline marks that wrap their contents, longest delimiter first. */
const WRAPPERS = [
  { open: "***", marks: ["strong", "em"] },
  { open: "___", marks: ["strong", "em"] },
  { open: "**", marks: ["strong"] },
  { open: "__", marks: ["strong"] },
  { open: "~~", marks: ["strike"] },
  // A bare `*` may not open on whitespace, so `2 * 3` stays arithmetic.
  { open: "*", marks: ["em"] },
  // `_` may not open mid-word, so `snake_case_name` stays literal.
  { open: "_", marks: ["em"] },
] as const;

function wrapped(
  rest: string,
): { nodes: AdfNode[]; length: number } | undefined {
  for (const { open, marks } of WRAPPERS) {
    if (!rest.startsWith(open)) continue;
    if (open === "*" && /^\s/.test(rest.slice(1))) continue;
    if (open === "_" && /^[\w_]/.test(rest.slice(1))) continue;

    const body = rest.slice(open.length);
    const close = findClose(body, open);
    const inner = close < 0 ? "" : body.slice(0, close);
    if (inner.trim() === "") continue;

    return {
      nodes: parseInline(inner).map((node) => ({
        ...node,
        marks: [...marks.map((type) => ({ type })), ...(node.marks ?? [])],
      })),
      length: open.length + Math.max(close, 0) + open.length,
    };
  }
  return undefined;
}
/**
 * Where the closing delimiter sits, or -1 when there is none. A one-character
 * token skips a run of the same character, so the leading `*` of `**bold**`
 * cannot be mistaken for its own closer.
 */
function findClose(body: string, token: string): number {
  if (token === "_") {
    // Only a delimiter at a word boundary closes an underscore run.
    for (let at = 0; at < body.length; at++) {
      if (
        body[at] === "_" &&
        /[\s)\]}>.,;:!?]$|^$/.test(body.slice(at + 1, at + 2))
      ) {
        return at;
      }
    }
    return -1;
  }
  let from = 0;
  while (from < body.length) {
    const at = body.indexOf(token, from);
    if (at < 0) return -1;
    if (token === "*" && body[at + 1] === "*") {
      from = at + 1;
      continue;
    }
    return at;
  }
  return -1;
}

function marked(text: string, mark: AdfMark): AdfNode {
  return { type: "text", text, marks: [mark] };
}
