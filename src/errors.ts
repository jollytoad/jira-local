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

/** Only `/myself` reports auth failures honestly; the search endpoints do not. */
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

export class JiraSearchMismatchError extends Error {
  count: number;
  searchResults: number;

  constructor(count: number, searchResults: number) {
    super(
      `Search returned ${searchResults} issue(s) but approximate-count reports ${count} — ` +
        "the enhanced search result is incomplete or inconsistent. Aborting rather than pulling a partial state.",
    );
    this.name = "JiraSearchMismatchError";
    this.count = count;
    this.searchResults = searchResults;
  }
}

/** Internal to the fetch retry loop, never surfaced. */
export class RateLimitError extends Error {
  retryAfterMs: number | undefined;

  constructor(retryAfterMs: number | undefined) {
    super("Jira API rate limit hit (HTTP 429)");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
  }
}
