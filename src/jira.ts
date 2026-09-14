/** Minimal Jira Cloud REST v3 client for the sync tool. */

import type { AdfNode } from "./adf-to-markdown.ts";
import { renderIssue } from "./render.ts";
import type { JiraComment, JiraIssue } from "./render.ts";
import { pool, progress } from "./util.ts";

const SEARCH_PAGE_SIZE = 100;
const COMMENT_PAGE_SIZE = 100;
const COMMENT_CONCURRENCY = 5;
const MAX_RETRIES = 3;

export class JiraApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`Jira API ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = "JiraApiError";
  }
}

/** Credentials rejected (401) or lacking permission (403) — detected via `/myself`. */
export class JiraAuthError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "Jira rejected the credentials (401). Check JIRA_EMAIL / JIRA_API_TOKEN — the token must be an Atlassian API token, not a password."
        : "Jira denied access (403). The account may be inactive or lack permission to use the REST API.",
    );
    this.name = "JiraAuthError";
  }
}

/** Project not found or not visible to the authenticated user (404). */
export class JiraProjectError extends Error {
  constructor(readonly project: string) {
    super(
      `Project ${project} not found — the key is wrong, or the account lacks Browse Projects permission.`,
    );
    this.name = "JiraProjectError";
  }
}

/** The paged search disagrees wildly with the independent count. */
export class JiraSearchMismatchError extends Error {
  constructor(
    readonly count: number,
    readonly searchResults: number,
  ) {
    super(
      `Search returned ${searchResults} issue(s) but approximate-count reports ${count} — ` +
        "the enhanced search result is incomplete or inconsistent. Aborting rather than syncing a partial state.",
    );
    this.name = "JiraSearchMismatchError";
  }
}

/**
 * Decide what a 0-issue fetch means. A non-zero count alongside an empty
 * search result is always a failure; a genuine empty project must opt in
 * via `allowEmpty` before the sync is allowed to prune.
 */
export function validateFetchResult(
  fetched: number,
  expectedCount: number,
  allowEmpty: boolean,
): "ok" | "refuse-empty" {
  if (fetched > 0) return "ok";
  if (expectedCount > 0) {
    throw new JiraSearchMismatchError(expectedCount, fetched);
  }
  return allowEmpty ? "ok" : "refuse-empty";
}

export interface Credentials {
  site: string;
  email: string;
  token: string;
}

/** An issue rendered into its final markdown form. */
export interface SyncIssue {
  key: string;
  markdown: string;
}

interface SearchResponse {
  issues?: Array<{
    key: string;
    fields: JiraIssue["fields"];
  }>;
  nextPageToken?: string;
  isLast?: boolean;
}

interface CommentPage {
  comments?: Array<{
    id: string;
    author?: JiraComment["author"];
    created?: string;
    updated?: string;
    body?: AdfNode | string | null;
  }>;
  isLast?: boolean;
  nextPageToken?: string;
}

const ISSUE_FIELDS = [
  "summary",
  "status",
  "description",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "created",
  "updated",
  "creator",
  "comment",
];

export class JiraClient {
  private readonly auth: string;

  constructor(private readonly creds: Credentials) {
    this.auth = `Basic ${btoa(`${creds.email}:${creds.token}`)}`;
  }

  /**
   * Fail fast on bad credentials. Crucially, the search endpoints do NOT
   * return 401 on auth failure — they degrade to an anonymous query and
   * silently return an empty (but well-formed) result. `/myself` is one of
   * the endpoints that does report auth errors honestly, so we probe it
   * before trusting any search result.
   */
  async preflightAuth(): Promise<{ timeZone?: string }> {
    try {
      const me = await this.requestJson<{
        accountId?: string;
        timeZone?: string;
      }>("GET", "/rest/api/3/myself");
      return { timeZone: me.timeZone };
    } catch (error) {
      if (
        error instanceof JiraApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        throw new JiraAuthError(error.status);
      }
      throw error;
    }
  }

  /**
   * Verify the project exists and is visible to the authenticated user.
   * 404 here means either a wrong key or missing Browse Projects permission.
   */
  async preflightProject(project: string): Promise<void> {
    try {
      await this.requestJson<{ key?: string }>(
        "GET",
        `/rest/api/3/project/${encodeURIComponent(project)}`,
      );
    } catch (error) {
      if (error instanceof JiraApiError && error.status === 404) {
        throw new JiraProjectError(project);
      }
      throw error;
    }
  }

  /**
   * Independent estimate of how many issues the JQL matches. The enhanced
   * search can legitimately lag recent updates, and both it and this count
   * endpoint share the silent-empty failure mode, so a large discrepancy is
   * treated as a failure rather than truth.
   */
  async countIssues(project: string): Promise<number> {
    const jql = `project = ${jqlQuote(project)}`;
    const result = await this.requestJson<{ count?: number }>(
      "POST",
      "/rest/api/3/search/approximate-count",
      { body: { jql } },
    );
    const count = result.count;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      throw new Error(
        `approximate-count returned an unexpected payload: ${
          JSON.stringify(result)
        }`,
      );
    }
    return count;
  }

  /**
   * Fetch every issue in `project` (all statuses, optionally limited to
   * issues updated after `updatedSince`) together with its comments, rendered
   * and ready for the sync step. Reports live progress to stderr.
   *
   * Streams: the next search page starts downloading while the current
   * page's issues are rendered (comment fetches in parallel) and yielded.
   *
   * `sawUpdated` (when provided) is called with the raw `updated` timestamp
   * of every fetched issue, including the newest per page — used by the
   * caller to advance the incremental watermark on clean completion.
   */
  async *streamIssues(
    project: string,
    options: {
      updatedSince?: string;
      sawUpdated?: (updated: string) => void;
    } = {},
  ): AsyncGenerator<SyncIssue> {
    const jql = `project = ${jqlQuote(project)}${
      options.updatedSince ? ` AND updated > "${options.updatedSince}"` : ""
    } ORDER BY key ASC`;

    let pageCount = 0;
    let renderedTotal = 0;
    let fallbackCount = 0;

    const fetchPage = (pageToken?: string): Promise<SearchResponse> =>
      this.requestJson<SearchResponse>(
        "POST",
        "/rest/api/3/search/jql",
        {
          body: {
            jql,
            fields: ISSUE_FIELDS,
            maxResults: SEARCH_PAGE_SIZE,
            ...(pageToken ? { nextPageToken: pageToken } : {}),
          },
        },
      );

    // Start the first fetch immediately.
    let pending: Promise<SearchResponse> | undefined = fetchPage();

    while (pending) {
      const page: SearchResponse = await pending;
      pageCount++;
      const issues: JiraIssue[] = page.issues ?? [];
      progress(`fetched ${issues.length} issues (${pageCount} page(s))`);
      // Begin the next page before rendering this one.
      const next: Promise<SearchResponse> | undefined = page.nextPageToken
        ? fetchPage(page.nextPageToken)
        : undefined;

      for (const issue of issues) {
        const updated = issue.fields.updated;
        if (typeof updated === "string" && updated) {
          options.sawUpdated?.(updated);
        }
      }

      const rendered: SyncIssue[] = await pool(
        issues,
        COMMENT_CONCURRENCY,
        async (issue: JiraIssue) => {
          let comments = this.completeInlineComments(issue);
          let fallbackFetched = false;
          if (!comments) {
            comments = await this.fetchAllComments(issue.key);
            fallbackFetched = true;
          }
          const result = renderIssue(issue, this.creds.site, { comments });
          renderedTotal++;
          if (fallbackFetched) fallbackCount++;
          if (renderedTotal % 25 === 0) {
            progress(
              `rendered ${renderedTotal} issues${
                fallbackCount > 0
                  ? ` (${fallbackCount} needed comment fallback fetches)`
                  : ""
              }`,
            );
          }
          return { key: issue.key, markdown: result.markdown };
        },
      );
      for (const issue of rendered) yield issue;
      pending = next;
    }
    if (fallbackCount > 0) {
      progress(
        `rendered ${renderedTotal} issues (done) — ${fallbackCount} used per-issue comment fallback`,
      );
    } else {
      progress(`rendered ${renderedTotal} issues (done, all inline)`);
    }
  }

  /**
   * Use the comments embedded in the search payload when the endpoint
   * returned the complete list (total matches count). Returns undefined when
   * comments are missing, truncated, or the total is unknown — the caller
   * then re-fetches them per issue.
   */
  private completeInlineComments(issue: JiraIssue): JiraComment[] | undefined {
    const comment = issue.fields.comment;
    const inline = comment?.comments;
    if (!inline) return undefined;
    const total = comment.total;
    if (typeof total !== "number") return inline.length > 0 ? undefined : [];
    return inline.length >= total ? inline : undefined;
  }

  private async fetchAllComments(issueKey: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        maxResults: String(COMMENT_PAGE_SIZE),
        orderBy: "created",
        startAt: String(comments.length),
      });
      if (pageToken) query.set("nextPageToken", pageToken);
      const page = await this.requestJson<CommentPage>(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
        { query },
      );
      comments.push(...(page.comments ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return comments;
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: URLSearchParams; body?: unknown } = {},
  ): Promise<T> {
    const url = `${this.creds.site}${path}${
      opts.query ? `?${opts.query}` : ""
    }`;
    const payload = method === "POST"
      ? JSON.stringify(opts.body ?? {})
      : undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const retryAfter = lastError instanceof RateLimitError
          ? lastError.retryAfterMs
          : undefined;
        await sleep(retryAfter ?? 2 ** (attempt - 1) * 500);
      }
      let response: globalThis.Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            authorization: this.auth,
            accept: "application/json",
            ...(payload !== undefined
              ? { "content-type": "application/json" }
              : {}),
          },
          body: payload,
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue; // network error: retry
      }

      if (response.status === 429) {
        const retryAfterHeader = Number(response.headers.get("retry-after"));
        const retryAfterMs =
          Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
            ? retryAfterHeader * 1000
            : undefined;
        await response.body?.cancel().catch(() => {});
        lastError = new RateLimitError(retryAfterMs);
        continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => {});
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new JiraApiError(response.status, url, text);
      }
      return (await response.json()) as T;
    }
    throw lastError ?? new Error(`Request to ${url} failed`);
  }
}

class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number | undefined) {
    super("Jira API rate limit hit (HTTP 429)");
    this.name = "RateLimitError";
  }
}

function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
