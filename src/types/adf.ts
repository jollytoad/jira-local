/**
 * Atlassian Document Format (ADF) types: the rich-text document shape used
 * by Jira for issue descriptions and comment bodies.
 */

/** A node in Atlassian Document Format (ADF). */
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}
