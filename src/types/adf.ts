/** Atlassian Document Format: Jira's rich-text document shape. */
export interface AdfNode {
  type: string;
  /** Required on a document root, which is the only node Jira is given. */
  version?: number;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}
