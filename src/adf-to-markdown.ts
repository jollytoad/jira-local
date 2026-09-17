/**
 * Minimal Atlassian Document Format (ADF) -> Markdown converter.
 *
 * Covers the node/mark types that commonly appear in Jira Cloud issue
 * descriptions and comments. Anything unrecognised falls back to extracting
 * its inline text so content is never silently dropped.
 */

import type { AdfMark, AdfNode } from "./types/adf.ts";

interface InlineOptions {
  inListItem?: boolean;
  inTable?: boolean;
  inQuote?: boolean;
  /** Depth of nested task lists; used to indent sibling sub-lists. */
  taskDepth?: number;
}

/** Render an ADF document (or node) to markdown. */
export function adfToMarkdown(node: AdfNode | null | undefined): string {
  if (!node || node.type !== "doc") {
    return node ? renderBlock(node, {}, false).trim() : "";
  }
  return (node.content ?? [])
    .map((child) => renderBlock(child, {}, false))
    .filter((part) => part !== "")
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderBlock(
  node: AdfNode,
  opts: InlineOptions,
  tight: boolean,
): string {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks ?? []);
    case "paragraph":
      return renderInline(node.content ?? [], opts);
    case "heading": {
      const level = clampHeading(node);
      return `${"#".repeat(level)} ${
        renderInline(node.content ?? [], opts).trim()
      }`;
    }
    case "bulletList":
      return renderList(node, opts, "ul", tight);
    case "orderedList":
      return renderList(node, opts, "ol", tight);
    case "codeBlock":
      return renderCodeBlock(node);
    case "blockquote":
      return (node.content ?? [])
        .map((child) => renderBlock(child, { ...opts, inQuote: true }, false))
        .filter((part) => part !== "")
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "panel": {
      const icons: Record<string, string> = {
        info: "ℹ️",
        note: "📝",
        tip: "💡",
        warning: "⚠️",
        error: "❌",
        success: "✅",
      };
      const type = typeof node.attrs?.["panelType"] === "string"
        ? node.attrs["panelType"]
        : "";
      const icon = icons[type] ?? "ℹ️";
      const body = (node.content ?? [])
        .map((child) => renderBlock(child, { ...opts, inQuote: true }, false))
        .filter((part) => part !== "")
        .join("\n\n")
        .split("\n")
        .map((line) => (line.startsWith("> ") ? line : `> ${line}`))
        .join("\n");
      // body lines are already quote-prefixed; the icon joins the first line.
      return body.replace(/^> /, `> ${icon} `);
    }
    case "expand":
    case "nestedExpand": {
      const title = typeof node.attrs?.["title"] === "string"
        ? node.attrs["title"]
        : "";
      const body = (node.content ?? [])
        .map((child) => renderBlock(child, opts, false))
        .filter((part) => part !== "")
        .join("\n\n");
      return title ? `**${title}**\n\n${body}` : body;
    }
    case "rule":
      return "---";
    case "mediaSingle":
    case "media":
    case "mediaGroup":
      return renderMediaBlock(node);
    case "table":
      return renderTable(node, opts);
    case "taskList":
    case "decisionList": {
      // A taskList may directly contain nested taskLists (sibling of the
      // items, per the ADF schema). A nested list renders with every line
      // indented by its depth; plain lists stay flush.
      const depth = opts.taskDepth ?? 0;
      const body = (node.content ?? [])
        .map((child) =>
          renderBlock(
            child,
            child.type === "taskList"
              ? { ...opts, taskDepth: depth + 1 }
              : opts,
            tight,
          )
        )
        .filter((part) => part !== "")
        .join("\n");
      if (depth === 0) return body;
      return body
        .split("\n")
        .map((line) => (line ? `  ${line}` : line))
        .join("\n");
    }
    case "taskItem": {
      const done = node.attrs?.["state"] === "DONE";
      const label = (node.content ?? [])
        .filter((child) => child.type !== "taskList")
        .map((child) => renderBlock(child, { ...opts, inListItem: true }, true))
        .join(" ")
        .trim();
      // Nested task lists render as tail lines under the item, indented.
      const nested = (node.content ?? [])
        .filter((child) => child.type === "taskList")
        .map((child) => renderNestedBlock(child, opts))
        .filter((part) => part !== "")
        .join("\n\n");
      const nestedIndent = nested
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      return `- [${done ? "x" : " "}]${label ? ` ${label}` : ""}${
        nested ? `\n${nestedIndent}` : ""
      }`;
    }
    case "decisionItem": {
      const done = node.attrs?.["state"] === "DECIDED";
      const text = (node.content ?? [])
        .map((child) => renderBlock(child, { ...opts, inListItem: true }, true))
        .join(" ")
        .trim();
      return `- [${done ? "x" : " "}]${text ? ` ${text}` : ""}`;
    }
    case "emoji": {
      const text = typeof node.attrs?.["text"] === "string"
        ? node.attrs["text"]
        : "";
      const short = typeof node.attrs?.["shortName"] === "string"
        ? node.attrs["shortName"]
        : "";
      return text || short || ":emoji:";
    }
    case "mention":
      return typeof node.attrs?.["text"] === "string"
        ? node.attrs["text"]
        : `@${node.attrs?.["id"] ?? "user"}`;
    case "date": {
      const timestamp = node.attrs?.["timestamp"];
      const d = typeof timestamp === "string" || typeof timestamp === "number"
        ? new Date(Number(timestamp))
        : undefined;
      return d && !Number.isNaN(d.getTime())
        ? d.toISOString().slice(0, 10)
        : "";
    }
    case "status": {
      const text = typeof node.attrs?.["text"] === "string"
        ? node.attrs["text"]
        : "";
      return text ? `\`${text}\`` : "";
    }
    case "hardBreak":
      return "<br />";
    case "inlineCard":
    case "blockCard":
    case "embedCard": {
      const url = typeof node.attrs?.["url"] === "string"
        ? node.attrs["url"]
        : "";
      if (!url) {
        const data = typeof node.attrs?.["data"] === "string"
          ? node.attrs["data"]
          : "";
        return data ? `[${data}]` : "";
      }
      return `[${url}](${url})`;
    }
    default:
      return (node.content ?? [])
        .map((child) => renderBlock(child, opts, tight))
        .filter((part) => part !== "")
        .join("\n\n");
  }
}

function renderInline(nodes: AdfNode[], opts: InlineOptions): string {
  const parts = nodes.map((node) => renderInlineNode(node, opts));
  return mergeAdjacent(parts);
}

function renderInlineNode(node: AdfNode, opts: InlineOptions): string {
  if (node.type === "text") {
    return applyMarks(node.text ?? "", node.marks ?? []);
  }
  const inline = renderBlock(node, opts, false);
  return inline.trim();
}

function applyMarks(text: string, marks: AdfMark[]): string {
  // Emphasis markers must hug non-space characters; keep edge padding outside.
  const lead = /^\s+/.exec(text)?.[0] ?? "";
  const trail = /\s+$/.exec(text)?.[0] ?? "";
  const core = text.slice(lead.length, text.length - trail.length);
  if (!core) return text;

  let out = core;
  const marksInOrder = [...marks].reverse();
  for (const mark of marksInOrder) {
    switch (mark.type) {
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "code":
        return `${lead}\`${core}\`${trail}`;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "underline":
        out = `<u>${out}</u>`;
        break;
      case "subsup": {
        const sub = mark.attrs?.["subsupType"] === "sub";
        out = sub ? `~${out}~` : `^${out}^`;
        break;
      }
      case "link": {
        const href = typeof mark.attrs?.["href"] === "string"
          ? mark.attrs["href"]
          : "";
        out = href ? `[${out}](${href})` : out;
        break;
      }
      case "color":
      case "backgroundColor":
      case "textColor":
      case "alignment":
      case "indentation":
      case "breakout":
      case "annotation":
        break;
      default:
        break;
    }
  }
  return out;
}

function renderMediaBlock(node: AdfNode): string {
  switch (node.type) {
    case "media": {
      const alt = typeof node.attrs?.["alt"] === "string"
        ? node.attrs["alt"]
        : "";
      // External media carries a URL; Atlassian-hosted media carries an id.
      const url = typeof node.attrs?.["url"] === "string"
        ? node.attrs["url"]
        : "";
      if (url) return alt ? `![${alt}](${url})` : `![media](${url})`;
      const id = typeof node.attrs?.["id"] === "string" ? node.attrs["id"] : "";
      return id ? `[attachment: ${alt || id}]` : "";
    }
    case "caption": {
      const text = (node.content ?? [])
        .map((child) => renderBlock(child, { inTable: false }, true))
        .filter((part) => part !== "")
        .join(" ")
        .trim();
      return text ? `_${text}_` : "";
    }
    case "mediaGroup": {
      const parts = (node.content ?? [])
        .map((child) => renderMediaBlock(child))
        .filter((part) => part !== "");
      return parts.join("\n\n");
    }
    case "mediaSingle": {
      // mediaSingle carries [media] or [media, caption?]; join the caption
      // to its media on one line.
      const parts = (node.content ?? [])
        .map((child) =>
          child.type === "caption"
            ? renderCaption(child)
            : renderMediaBlock(child)
        )
        .filter((part) => part !== "");
      if (parts.length > 1) {
        const [media, ...captions] = parts;
        return [media, ...captions].join(" ");
      }
      return parts.join("\n\n");
    }
    default:
      return "";
  }
}

/** Caption content renders as an italic continuation of its media line. */
function renderCaption(node: AdfNode): string {
  const text = (node.content ?? [])
    .map((child) => renderBlock(child, { inTable: false }, true))
    .filter((part) => part !== "")
    .join(" ")
    .trim();
  return text ? `_${text}_` : "";
}

function renderList(
  list: AdfNode,
  opts: InlineOptions,
  kind: "ul" | "ol",
  tight: boolean,
): string {
  const itemSep = tight ? "\n" : "\n\n";
  let index = 0;
  return (list.content ?? [])
    .map((item) => {
      if (item.type !== "listItem") return "";
      const marker = kind === "ul" ? "-" : `${++index}.`;
      const [first, ...rest] = item.content ?? [];
      if (!first) return `${marker} `;
      const head = renderBlock(first, { ...opts, inListItem: true }, true)
        .trim();
      const tail = rest
        .map((child) => renderNestedBlock(child, opts))
        .filter((part) => part !== "")
        .join("\n\n");
      const tailIndent = tail
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      return `${marker} ${head}${tail ? `\n${tailIndent}` : ""}`;
    })
    .filter((part) => part !== "")
    .join(itemSep);
}

function renderNestedBlock(node: AdfNode, opts: InlineOptions): string {
  if (node.type === "paragraph") {
    return renderInline(node.content ?? [], { ...opts, inListItem: true });
  }
  return renderBlock(node, { ...opts, inListItem: true }, false);
}

function renderCodeBlock(node: AdfNode): string {
  const lang = typeof node.attrs?.["language"] === "string"
    ? node.attrs["language"]
    : "";
  const text = (node.content ?? [])
    .map((child) => (child.type === "text" ? (child.text ?? "") : ""))
    .join("")
    .replace(/\n$/, "");
  const fence = text.includes("```") ? "~~~~" : "```";
  return `${fence}${lang}\n${text}\n${fence}`;
}

function renderTable(table: AdfNode, opts: InlineOptions): string {
  const tableRows = (table.content ?? []).filter((row) =>
    row.type === "tableRow"
  );
  if (tableRows.length === 0) return "";
  // ADF tables do not require a header row; without one, emit an empty
  // header so the first data row is not swallowed by the separator.
  const hasHeader = (tableRows[0]?.content ?? []).some((cell) =>
    cell.type === "tableHeader"
  );
  const bodyRows = hasHeader ? tableRows : [undefined, ...tableRows];
  const rows = bodyRows.map((row) =>
    (row?.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((child) => renderBlock(child, { ...opts, inTable: true }, true))
        .filter((part) => part !== "")
        .join("\n")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, "<br>")
        .trim()
    )
  );
  const width = Math.max(...rows.map((cells) => cells.length));
  const normalised = rows.map((cells) => {
    const copy = [...cells];
    while (copy.length < width) copy.push("");
    return copy;
  });
  const [head, ...body] = normalised;
  if (!head) return "";
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...body.map((cells) => `| ${cells.join(" | ")} |`),
  ];
  return lines.join("\n");
}

function mergeAdjacent(parts: string[]): string {
  let out = "";
  let trailingBackticks = 0;
  for (const part of parts) {
    if (part === "") continue;
    const leading = /^`+/.exec(part)?.[0].length ?? 0;
    if (leading > 0 && trailingBackticks > 0) {
      const total = leading + trailingBackticks;
      if (total % 2 === 1) {
        out += " ";
        trailingBackticks = 0;
      } else {
        trailingBackticks = leading;
      }
      out += part;
      continue;
    }
    if (part.startsWith(" ")) {
      out += part;
      trailingBackticks = 0;
      continue;
    }
    if (out !== "") out += " ";
    out += part;
    const codeMatch = /(`+)$/.exec(part);
    trailingBackticks = codeMatch?.[1]?.length ?? 0;
  }
  return out;
}

function clampHeading(node: AdfNode): number {
  const raw = node.attrs?.["level"];
  const level = typeof raw === "number" ? Math.round(raw) : 1;
  return Math.min(6, Math.max(1, level));
}
