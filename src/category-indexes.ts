import type { IndexColumn, IssueFrontMatter } from "./types/jira-local.ts";

export const DEFAULT_INDEX_COLUMNS: readonly IndexColumn[] = [
  "key",
  "summary",
];

export interface IndexRow {
  key: string;
  frontMatter: IssueFrontMatter;
  /** Posix-relative path from the index page to `all/<KEY>.md`. */
  targetRel: string;
}

export function renderIndex(
  category: string,
  rows: readonly IndexRow[],
  columns: readonly IndexColumn[] = DEFAULT_INDEX_COLUMNS,
): string {
  const segments = category.split("/");
  const leaf = segments[segments.length - 1] ?? category;
  const headers = columns.map(titleOf);
  const lines = [
    `# ${leaf}`,
    "",
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(
      `| ${columns.map((column) => cellOf(column, row)).join(" | ")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function titleOf(column: IndexColumn): string {
  return column.charAt(0).toUpperCase() + column.slice(1);
}

function cellOf(column: IndexColumn, row: IndexRow): string {
  const text = escapeCell(textOf(column, row));
  if (column === "key") return `[${text}](${row.targetRel})`;
  return text;
}

function textOf(column: IndexColumn, row: IndexRow): string {
  if (column === "key") return row.key;
  const value = (row.frontMatter as unknown as Record<string, unknown>)[column];
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  return String(value);
}

function escapeCell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|").trim();
}
