/** Error types shared by the Jira client and the CLI. */

export class JiraApiError extends Error {
  status: number;
  url: string;
  body: string;

  constructor(status: number, url: string, body: string) {
    super(`Jira API ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = "JiraApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Credentials rejected (401) or lacking permission (403) — detected via `/myself`. */
export class JiraAuthError extends Error {
  status: number;

  constructor(status: number) {
    super(
      status === 401
        ? "Jira rejected the credentials (401). Check JIRA_EMAIL / JIRA_API_TOKEN — the token must be an Atlassian API token, not a password."
        : "Jira denied access (403). The account may be inactive or lack permission to use the REST API.",
    );
    this.name = "JiraAuthError";
    this.status = status;
  }
}

/** Project not found or not visible to the authenticated user (404). */
export class JiraProjectError extends Error {
  project: string;

  constructor(project: string) {
    super(
      `Project ${project} not found — the key is wrong, or the account lacks Browse Projects permission.`,
    );
    this.name = "JiraProjectError";
    this.project = project;
  }
}

/** The paged search disagrees wildly with the independent count. */
export class JiraSearchMismatchError extends Error {
  count: number;
  searchResults: number;

  constructor(count: number, searchResults: number) {
    super(
      `Search returned ${searchResults} issue(s) but approximate-count reports ${count} — ` +
        "the enhanced search result is incomplete or inconsistent. Aborting rather than syncing a partial state.",
    );
    this.name = "JiraSearchMismatchError";
    this.count = count;
    this.searchResults = searchResults;
  }
}

/** HTTP 429 with an optional Retry-After hint (internal to the fetch retry loop). */
export class RateLimitError extends Error {
  retryAfterMs: number | undefined;

  constructor(retryAfterMs: number | undefined) {
    super("Jira API rate limit hit (HTTP 429)");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}
