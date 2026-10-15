/**
 * What each declared issue asks Jira to make, and which of them cannot be sent.
 *
 * Pure, like `push-plan.ts`, so a dry run can exercise every refusal without a
 * request. The issue type is resolved here, once, and the same type is sent
 * whether the issue ends up a child or a link — the fallback changes the
 * relationship and nothing else.
 */

import { markdownToAdf, MarkdownUnsupportedError } from "./markdown-to-adf.ts";
import type { AdfNode } from "./types/adf.ts";
import type { Declaration } from "./types/jira-local.ts";

export interface CreateContext {
  /** The type names the project really has. */
  typeNames: readonly string[];
  /** Used when the heading names no type. */
  defaultType: string;
}

export interface CreatePlan {
  summary: string;
  /** The type name; resolved to an id by the caller, which owns the I/O. */
  typeName: string;
  /** The host issue, or undefined for a root declaration. */
  parentKey?: string;
  /** Absent for a declaration with no body, so Jira's own default stands. */
  description?: AdfNode;
  source: Declaration;
  /** Fatal for this declaration. Nothing is sent for it, and it stays put. */
  refusal?: string;
}

export function planCreate(
  declaration: Declaration,
  context: CreateContext,
): CreatePlan {
  const refuse = (reason: string): CreatePlan => ({
    summary: declaration.summary,
    typeName: context.defaultType,
    ...(declaration.hostKey === undefined
      ? {}
      : { parentKey: declaration.hostKey }),
    source: declaration,
    refusal: reason,
  });

  if (declaration.summary.trim() === "") {
    return refuse("the heading has no summary text");
  }
  if (declaration.marker !== undefined && declaration.typeHint === undefined) {
    return refuse(
      `no issue type named "${declaration.marker}" in this project — write one ` +
        `of: ${
          context.typeNames.join(", ") || "none"
        }, or drop the brackets to use the default`,
    );
  }

  let description: AdfNode | undefined;
  if (declaration.body.trim() !== "") {
    try {
      description = markdownToAdf(declaration.body);
    } catch (error) {
      if (error instanceof MarkdownUnsupportedError) {
        return refuse(`description: ${error.message}`);
      }
      throw error;
    }
  }

  return {
    summary: declaration.summary,
    typeName: declaration.typeHint ?? context.defaultType,
    ...(declaration.hostKey === undefined
      ? {}
      : { parentKey: declaration.hostKey }),
    ...(description === undefined ? {} : { description }),
    source: declaration,
  };
}

/** One aligned line per declaration. */
export interface DeclarationRow {
  summary: string;
  /** `path:line`, so the declaration can be found again. */
  where: string;
  parent: string;
  type: string;
}

/** A row for a planned create, where the type has been resolved for real. */
export function rowForPlan(plan: CreatePlan): DeclarationRow {
  return {
    summary: plan.summary,
    where: `${plan.source.relPath}:${plan.source.line}`,
    parent: `parent: ${plan.parentKey ?? "none"}`,
    type: `type: ${plan.typeName}`,
  };
}

/**
 * A row for what `status` can see offline. The project's own type list is not
 * available without a connection, so a bracketed name is shown as the marker it
 * still is rather than as a type nobody has confirmed.
 */
export function rowForDeclaration(
  declaration: Declaration,
  defaultType: string,
): DeclarationRow {
  return {
    summary: declaration.summary,
    where: `${declaration.relPath}:${declaration.line}`,
    parent: `parent: ${declaration.hostKey ?? "none"}`,
    type: `type: ${
      declaration.typeHint ??
        (declaration.marker !== undefined
          ? `[${declaration.marker}] unverified`
          : defaultType)
    }`,
  };
}

/**
 * One line per declaration, in aligned columns. `status` and `push` both show
 * it, so a plan reads the same in either place.
 */
export function declarationRows(rows: readonly DeclarationRow[]): string[] {
  const widths = rows.reduce<number[]>(
    (all, row) => {
      for (const [i, cell] of Object.values(row).entries()) {
        all[i] = Math.max(all[i] ?? 0, cell.length);
      }
      return all;
    },
    [0, 0, 0],
  );
  return rows.map((row) =>
    `  ${
      Object.values(row)
        .map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
        .join("  ").trimEnd()
    }`
  );
}
