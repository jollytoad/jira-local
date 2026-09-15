/**
 * Category index pages: for each leaf category folder the reconciler manages
 * (e.g. `.jira/issues/status/Backlog/`), a sibling markdown file
 * `status/Backlog.md` listing that category's issues as a markdown table.
 *
 * Which folders get an index page, and with which columns, is configured in
 * `.jira/config.ts` (see `config.ts`): a map from top-level category folder
 * to front-matter column names. `key` renders as a markdown link into the
 * flat `all/` store, any other column renders the raw front-matter value
 * (arrays joined with ", "). Rows are sorted by issue key. The columns here
 * default to `DEFAULT_INDEX_COLUMNS` when the config omits `categoryIndex`.
 */

import type { IndexColumn, IssueFrontMatter } from "./types.ts";

/** Front-matter fields shown as index table columns when unconfigured. */
export const DEFAULT_INDEX_COLUMNS: readonly IndexColumn[] = [
  "key",
  "summary",
];

/** One index table row: an issue plus how the index links back to it. */
export interface IndexRow {
  key: string;
  frontMatter: IssueFrontMatter;
  /** Posix-relative path from the index folder to `all/<KEY>.md`. */
  targetRel: string;
}

/** Render the index page markdown for one category ("status/Backlog"). */
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

/** Column header label: the column name with an initial capital. */
function titleOf(column: IndexColumn): string {
  return column.charAt(0).toUpperCase() + column.slice(1);
}

/** Render one table cell: linked for `key`, plain text otherwise. */
function cellOf(column: IndexColumn, row: IndexRow): string {
  const text = escapeCell(textOf(column, row));
  if (column === "key") return `[${text}](${row.targetRel})`;
  return text;
}

/** The raw text of a table cell: the front-matter field named `column`. */
function textOf(column: IndexColumn, row: IndexRow): string {
  if (column === "key") return row.key;
  const value = (row.frontMatter as unknown as Record<string, unknown>)[column];
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  return String(value);
}

/** Make a value safe inside a table cell (pipes escaped, newlines flattened). */
function escapeCell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|").trim();
}
