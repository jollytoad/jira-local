import {
  JiraApiError,
  JiraAuthError,
  JiraProjectError,
  JiraSearchMismatchError,
  RateLimitError,
} from "./errors.ts";
import type { AdfNode } from "./types/adf.ts";
import type { Credentials, JiraComment, JiraIssue } from "./types/jira-raw.ts";
import { pool } from "./util.ts";
import { progress } from "./progress.ts";

const SEARCH_PAGE_SIZE = 100;
const COMMENT_PAGE_SIZE = 100;
const COMMENT_CONCURRENCY = 5;
const MAX_RETRIES = 3;

/**
 * An empty search result is ambiguous: a non-zero count means auth or
 * visibility failed, so a genuinely empty project must opt in via `allowEmpty`
 * before a pull may prune.
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
  "parent",
  "subtasks",
  "issuelinks",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "created",
  "updated",
  "creator",
  "comment",
];

/**
 * The search endpoints do NOT return 401 on auth failure — they degrade to an
 * anonymous query and return an empty but well-formed result. `/myself` is
 * honest about auth, so probe it before trusting any search result.
 */
export async function preflightAuth(
  creds: Credentials,
): Promise<{ timeZone?: string }> {
  try {
    const me = await requestJson<{
      accountId?: string;
      timeZone?: string;
    }>(creds, "GET", "/rest/api/3/myself");
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

/** A 404 here means a wrong key or missing Browse Projects permission. */
export async function preflightProject(
  creds: Credentials,
  project: string,
): Promise<void> {
  try {
    await requestJson<{ key?: string }>(
      creds,
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
 * A second opinion on the result size: the paged search can lag recent
 * updates, and this endpoint shares the silent-empty failure mode, so a large
 * discrepancy is a failure rather than truth.
 */
export async function countIssues(
  creds: Credentials,
  project: string,
): Promise<number> {
  const jql = `project = ${jqlQuote(project)}`;
  const result = await requestJson<{ count?: number }>(
    creds,
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
 * Streams: the next search page downloads while the current page's issues are
 * completed (comment fetches in parallel) and yielded.
 *
 * `sawUpdated` gets the raw `updated` of every fetched issue, including the
 * newest per page, so the caller can advance the watermark only on a clean
 * completion.
 */
export async function* fetchJiraIssues(
  creds: Credentials,
  project: string,
  options: {
    updatedSince?: string;
    sawUpdated?: (updated: string) => void;
  } = {},
): AsyncGenerator<JiraIssue> {
  const jql = `project = ${jqlQuote(project)}${
    options.updatedSince ? ` AND updated > "${options.updatedSince}"` : ""
  } ORDER BY key ASC`;

  let fallbackCount = 0;

  const fetchPage = (pageToken?: string): Promise<SearchResponse> =>
    requestJson<SearchResponse>(
      creds,
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

  progress({ task: "fetch", msg: "issues fetched", status: "start" });

  let pending: Promise<SearchResponse> | undefined = fetchPage();

  while (pending) {
    const page: SearchResponse = await pending;
    const issues: JiraIssue[] = page.issues ?? [];
    progress({ task: "fetch", msg: "issues fetched", inc: issues.length });
    const next: Promise<SearchResponse> | undefined = page.nextPageToken
      ? fetchPage(page.nextPageToken)
      : undefined;

    for (const issue of issues) {
      const updated = issue.fields.updated;
      if (typeof updated === "string" && updated) {
        options.sawUpdated?.(updated);
      }
    }

    const complete: JiraIssue[] = await pool(
      issues,
      COMMENT_CONCURRENCY,
      async (issue: JiraIssue) => {
        if (!hasAllComments(issue)) {
          const comments = await fetchAllComments(creds, issue.key);
          issue.fields.comment = { total: comments.length, comments };
          fallbackCount++;
        }
        return issue;
      },
    );
    for (const issue of complete) yield issue;
    pending = next;
  }
  progress({ task: "fetch", status: "ok" });
  if (fallbackCount > 0) {
    progress({
      msg: `${fallbackCount} issues used per-issue comment fallback`,
    });
  }
}

/** Search may inline a truncated comment list; fall back when it did. */
function hasAllComments(
  issue: JiraIssue,
): issue is JiraIssue & { fields: { comment: { comments: JiraComment[] } } } {
  const inline = issue.fields.comment?.comments?.length;
  const total = issue.fields.comment?.total;
  return inline !== undefined &&
    (typeof total !== "number" ? inline === 0 : inline >= total);
}

async function fetchAllComments(
  creds: Credentials,
  issueKey: string,
): Promise<JiraComment[]> {
  const comments: JiraComment[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      maxResults: String(COMMENT_PAGE_SIZE),
      orderBy: "created",
      startAt: String(comments.length),
    });
    if (pageToken) query.set("nextPageToken", pageToken);
    const page = await requestJson<CommentPage>(
      creds,
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      { query },
    );
    comments.push(...(page.comments ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return comments;
}

async function requestJson<T>(
  creds: Credentials,
  method: "GET" | "POST",
  path: string,
  opts: { query?: URLSearchParams; body?: unknown } = {},
): Promise<T> {
  const url = `${creds.site}${path}${opts.query ? `?${opts.query}` : ""}`;
  const payload = method === "POST"
    ? JSON.stringify(opts.body ?? {})
    : undefined;
  const auth = `Basic ${btoa(`${creds.email}:${creds.token}`)}`;
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
          authorization: auth,
          accept: "application/json",
          ...(payload !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        body: payload,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
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

function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
