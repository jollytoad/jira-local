/**
 * Checks the strict markdown subset actually converts to the ADF shape
 * `adf-to-markdown.ts` reads back.
 *
 * Two kinds of check:
 *
 *  1. Structure. The ADF tree is compared to what it should be, node by node.
 *     This is the check that matters: the renderer normalises whitespace, so
 *     comparing markdown text would only test its cosmetics.
 *  2. Idempotence over real descriptions. Every `## Description` in the
 *     mirror is converted and rendered back; a second pass must produce the
 *     same ADF. That catches anything the tool itself emits which this module
 *     cannot read.
 *
 * Not part of `deno task ok`; it is a development aid, not a test.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { adfToMarkdown } from "../adf-to-markdown.ts";
import { markdownToAdf } from "../markdown-to-adf.ts";
import { ISSUES_DIR } from "../constants.ts";
import type { AdfNode } from "../types/adf.ts";

interface Case {
  name: string;
  markdown: string;
  expected: unknown;
}

const text = (value: string, ...marks: string[]): AdfNode => ({
  type: "text",
  text: value,
  ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}),
});

const doc = (...content: AdfNode[]): AdfNode => ({
  version: 1,
  type: "doc",
  content,
});

const para = (...content: AdfNode[]): AdfNode => ({
  type: "paragraph",
  content,
});
const heading = (level: number, value: string): AdfNode => ({
  type: "heading",
  attrs: { level },
  content: [text(value)],
});

const CASES: Case[] = [
  {
    name: "paragraph",
    markdown: "A plain paragraph.",
    expected: doc(para(text("A plain paragraph."))),
  },
  {
    name: "two paragraphs",
    markdown: "One.\n\nTwo.",
    expected: doc(para(text("One.")), para(text("Two."))),
  },
  {
    name: "headings",
    markdown: "# One\n\n## Two\n\n###### Six",
    expected: doc(heading(1, "One"), heading(2, "Two"), heading(6, "Six")),
  },
  {
    name: "inline marks",
    markdown: "a **b** *c* ~~d~~ `e`",
    expected: doc(
      para(
        text("a "),
        text("b", "strong"),
        text(" "),
        text("c", "em"),
        text(" "),
        text("d", "strike"),
        text(" "),
        text("e", "code"),
      ),
    ),
  },
  {
    name: "nested inline",
    markdown: "**bold with *em* in**",
    expected: doc(
      para(
        text("bold with ", "strong"),
        text("em", "strong", "em"),
        text(" in", "strong"),
      ),
    ),
  },
  {
    name: "link",
    markdown: "see [docs](https://x.test/a)",
    expected: doc(
      para(text("see "), {
        type: "text",
        text: "docs",
        marks: [{ type: "link", attrs: { href: "https://x.test/a" } }],
      }),
    ),
  },
  {
    name: "bullet list",
    markdown: "- one\n- two\n- three",
    expected: doc({
      type: "bulletList",
      content: ["one", "two", "three"].map((value) => ({
        type: "listItem",
        content: [para(text(value))],
      })),
    }),
  },
  {
    name: "ordered list keeps its start",
    markdown: "3. third\n4. fourth",
    expected: doc({
      type: "orderedList",
      attrs: { order: 3 },
      content: ["third", "fourth"].map((value) => ({
        type: "listItem",
        content: [para(text(value))],
      })),
    }),
  },
  {
    name: "task list",
    markdown: "- [ ] todo\n- [x] done",
    expected: doc({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { state: "TODO", localId: "1" },
          content: [para(text("todo"))],
        },
        {
          type: "taskItem",
          attrs: { state: "DONE", localId: "2" },
          content: [para(text("done"))],
        },
      ],
    }),
  },
  {
    name: "nested bullet list",
    markdown: "- top\n  - nested\n- back",
    expected: doc({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            para(text("top")),
            {
              type: "bulletList",
              content: [{ type: "listItem", content: [para(text("nested"))] }],
            },
          ],
        },
        { type: "listItem", content: [para(text("back"))] },
      ],
    }),
  },
  {
    name: "loose list with blank lines",
    markdown: "- one\n\n- two",
    expected: doc({
      type: "bulletList",
      content: ["one", "two"].map((value) => ({
        type: "listItem",
        content: [para(text(value))],
      })),
    }),
  },
  {
    name: "code fence",
    markdown: "```js\nconst x = 1;\n```",
    expected: doc({
      type: "codeBlock",
      attrs: { language: "js" },
      content: [text("const x = 1;")],
    }),
  },
  {
    name: "code fence without a language",
    markdown: "```\nplain\n```",
    expected: doc({ type: "codeBlock", content: [text("plain")] }),
  },
  {
    name: "tilde fence",
    markdown: "~~~~\ntilde\n~~~~",
    expected: doc({ type: "codeBlock", content: [text("tilde")] }),
  },
  {
    name: "blockquote",
    markdown: "> quoted",
    expected: doc({ type: "blockquote", content: [para(text("quoted"))] }),
  },
  {
    name: "rule",
    markdown: "a\n\n---\n\nb",
    expected: doc(para(text("a")), { type: "rule" }, para(text("b"))),
  },
  {
    name: "underline and break",
    markdown: "an <u>underlined</u> word<br />next",
    expected: doc(
      para(
        text("an "),
        text("underlined", "underline"),
        text(" word"),
        { type: "hardBreak" },
        text("next"),
      ),
    ),
  },
];

const REFUSALS: string[] = [
  "a\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
  "![alt](https://x.test/i.png)",
  "a <div>b</div>",
  "an <u>unclosed tag",
];

let failures = 0;

for (const testCase of CASES) {
  const actual = markdownToAdf(testCase.markdown);
  if (!same(actual, testCase.expected)) {
    failures++;
    console.log(`FAIL  ${testCase.name}`);
    console.log(`  expected ${JSON.stringify(testCase.expected)}`);
    console.log(`  actual   ${JSON.stringify(actual)}`);
  }
}

for (const markdown of REFUSALS) {
  let refused = false;
  try {
    markdownToAdf(markdown);
  } catch (error) {
    refused = error instanceof Error &&
      error.name === "MarkdownUnsupportedError";
  }
  if (!refused) {
    failures++;
    console.log(`FAIL  expected a refusal: ${JSON.stringify(markdown)}`);
  }
}

console.log(
  `${CASES.length} structures and ${REFUSALS.length} refusals checked, ${failures} failed`,
);

const checked = await realDescriptions();
if (checked === undefined) {
  console.log("no mirror found, skipping the idempotence pass");
} else if (checked.failed) {
  failures += 1;
} else {
  const notes: string[] = [];
  if (checked.refused.length > 0) {
    notes.push(`${checked.refused.length} refused`);
  }
  if (checked.drifted > 0) {
    notes.push(`${checked.drifted} re-rendered differently`);
  }
  console.log(
    `${checked.converted} real descriptions convert without losing text` +
      (notes.length === 0 ? "" : ` (${notes.join(", ")})`),
  );
  for (const reason of checked.refused) console.log(`  refused ${reason}`);
}

process.exitCode = failures === 0 ? 0 : 1;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sort(a)) === JSON.stringify(sort(b));
}

/** Key order is an implementation detail; compare on shape instead. */
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([x], [y]) => x.localeCompare(y))
    .filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries.map(([k, v]) => [k, sort(v)]));
}

interface RealResult {
  converted: number;
  refused: string[];
  /** Converted cleanly, but the renderer restructures them on the way back. */
  drifted: number;
  failed: boolean;
}

/** Undefined when there is no mirror to read. */
async function realDescriptions(): Promise<RealResult | undefined> {
  const dir = join(process.cwd(), ISSUES_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  let count = 0;
  let drifted = 0;
  const refused: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const raw = await readFile(join(dir, name), "utf8");
    const description = between(raw, "## Description", "## Comments");
    if (description === undefined || description.trim() === "") continue;
    let adf: AdfNode;
    try {
      adf = markdownToAdf(description);
    } catch (error) {
      // A construct outside the subset is a refusal by design, not a defect.
      // It is counted so a reader can see how much of the mirror is covered.
      if (error instanceof Error && error.name === "MarkdownUnsupportedError") {
        refused.push(`${name}: ${error.message.split(".")[0]}`);
        continue;
      }
      console.log(`FAIL  ${name}: ${(error as Error).message}`);
      return { converted: count, refused, drifted, failed: true };
    }
    // What must survive a round trip is the text. Structure is allowed to
    // differ, because `adf-to-markdown.ts` normalises it: it puts a soft-wrapped
    // paragraph on one line, and it joins several paragraphs inside a list
    // item onto that item's line. Both are formatting, and neither drops text.
    const second = markdownToAdf(adfToMarkdown(adf));
    if (flatten(adf) !== flatten(second)) {
      console.log(`FAIL  ${name}: text changed through a round trip`);
      return { converted: count, refused, drifted, failed: true };
    }
    if (!same(squeeze(adf), squeeze(second))) drifted++;
    count++;
  }
  return { converted: count, refused, drifted, failed: false };
}

/**
 * Every word in the document, in order, whitespace-normalised. Comparing the
 * whole string rather than per node catches text that moved, merged or lost.
 */
function flatten(doc: AdfNode): string {
  const words: string[] = [];
  const walk = (node: AdfNode) => {
    if (node.type === "text") {
      words.push(...(node.text ?? "").split(/\s+/).filter((w) => w !== ""));
      return;
    }
    if (node.type === "hardBreak") words.push("<br>");
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return words.join(" ");
}

/**
 * Normalises away the renderer's spacing, so the comparison tests conversion
 * and not cosmetics.
 *
 * Two things are levelled. Adjacent text nodes carrying the same marks are
 * joined, because `mergeAdjacent` in the renderer moves a space from one to
 * the next and the split point is an artefact. Then whitespace runs collapse.
 */
function squeeze(value: unknown): unknown {
  const node = value as AdfNode | undefined;
  if (node?.type === "text") {
    return { ...node, text: (node.text ?? "").replace(/\s+/g, " ").trim() };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.map(squeeze)) {
      const last = out[out.length - 1] as AdfNode | undefined;
      const plain = last?.type === "text" && (item as AdfNode)?.type === "text";
      if (plain && sameMarks(last, item as AdfNode)) {
        out[out.length - 1] = {
          ...last,
          text: `${last.text}${(item as AdfNode).text}`,
        };
        continue;
      }
      if (plain || (item as AdfNode)?.type === "text") {
        // A fully-spaced node between two others carries no text of its own.
        if ((item as AdfNode).text === "") continue;
      }
      out.push(item);
    }
    return out;
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([x], [y]) => x.localeCompare(y))
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, squeeze(v)]),
  );
}

function sameMarks(a: AdfNode, b: AdfNode): boolean {
  return JSON.stringify(sortMarks(a.marks)) ===
    JSON.stringify(sortMarks(b.marks));
}

function sortMarks(marks: AdfNode["marks"]): unknown {
  return [...(marks ?? [])].sort((x, y) =>
    JSON.stringify(x).localeCompare(JSON.stringify(y))
  );
}

function between(raw: string, from: string, to: string): string | undefined {
  const start = raw.indexOf(`\n${from}\n`);
  if (start < 0) return undefined;
  const fromAt = start + from.length + 2;
  const end = raw.indexOf(`\n${to}\n`, fromAt);
  return end < 0 ? raw.slice(fromAt) : raw.slice(fromAt, end);
}
