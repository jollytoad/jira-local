import {
  JiraApiError,
  JiraAuthError,
  JiraProjectError,
  JiraSearchMismatchError,
  RateLimitError,
} from "./errors.ts";
import type { AdfNode } from "./types/adf.ts";
import type {
  Credentials,
  JiraComment,
  JiraIssue,
  JiraIssueType,
} from "./types/jira-raw.ts";
import { pool } from "./util.ts";
import { progress } from "./progress.ts";

const SEARCH_PAGE_SIZE = 100;
const CHILD_PAGE_SIZE = 500;
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

export interface JiraUpdate {
  fields?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

/** `PUT /issue/{key}`, answered with 204 No Content. */
export async function updateIssue(
  creds: Credentials,
  key: string,
  payload: JiraUpdate,
): Promise<void> {
  await request(creds, "PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, {
    body: payload,
  });
}

export interface JiraTransition {
  id: string;
  name: string;
  to?: { name?: string };
}

/**
 * Transitions are the only way to change a status, so the caller needs the
 * full list to resolve a target name.
 */
export async function fetchTransitions(
  creds: Credentials,
  key: string,
): Promise<JiraTransition[]> {
  const result = await requestJson<{
    transitions?: Array<{ id?: string; name?: string; to?: { name?: string } }>;
  }>(creds, "GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  return (result.transitions ?? [])
    .filter((t): t is { id: string; name: string; to?: { name?: string } } =>
      typeof t.id === "string" && typeof t.name === "string"
    )
    .map((t) => ({ id: t.id, name: t.name, to: t.to }));
}

export async function transitionIssue(
  creds: Credentials,
  key: string,
  transitionId: string,
): Promise<void> {
  await request(
    creds,
    "POST",
    `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    { body: { transition: { id: transitionId } } },
  );
}

/**
 * The push lease: the issue's exact `updated` and its numeric id, which
 * subtask operations need because they are keyed by id rather than key.
 *
 * `updated` arrives under `fields`, so it is unwrapped here rather than at
 * every call site. The type comes along because deciding how to re-parent an
 * issue means knowing whether it is a Sub-task, which is the only kind Jira
 * accepts as one.
 */
export async function fetchIssueStamp(
  creds: Credentials,
  key: string,
): Promise<
  { updated?: string; id?: string; typeName?: string; subtask?: boolean }
> {
  const issue = await requestJson<
    {
      id?: string;
      fields?: {
        updated?: string;
        issuetype?: { name?: string; subtask?: boolean };
      };
    }
  >(
    creds,
    "GET",
    `/rest/api/3/issue/${encodeURIComponent(key)}`,
    {
      query: new URLSearchParams({ fields: "updated,issuetype" }),
    },
  );
  return {
    updated: issue.fields?.updated,
    id: issue.id,
    typeName: issue.fields?.issuetype?.name,
    subtask: issue.fields?.issuetype?.subtask === true,
  };
}

/**
 * The issue types a project offers, with the ids the write path needs. A name
 * alone is not enough, because a type name is only unique within a project.
 * The answer is the same for every issue in a push, so callers fetch it once.
 */
export async function fetchIssueTypes(
  creds: Credentials,
  project: string,
): Promise<JiraIssueType[]> {
  const result = await requestJson<{
    issueTypes?: Array<{ id?: string; name?: string; subtask?: boolean }>;
  }>(creds, "GET", `/rest/api/3/project/${encodeURIComponent(project)}`);
  return (result.issueTypes ?? [])
    .filter((t): t is { id: string; name: string; subtask?: boolean } =>
      typeof t.id === "string" && typeof t.name === "string"
    )
    .map((t) => ({ id: t.id, name: t.name, subtask: t.subtask === true }));
}

/**
 * `POST /issue`, answered with 201 and `{id, key}` rather than the 204 the
 * update path returns. The key is the whole point of the call, so a reply
 * without one is a failure rather than an empty success.
 */
export async function createIssue(
  creds: Credentials,
  fields: Record<string, unknown>,
): Promise<{ id: string; key: string }> {
  const result = await requestJson<{ id?: string; key?: string }>(
    creds,
    "POST",
    "/rest/api/3/issue",
    { body: { fields } },
  );
  const key = result?.key;
  if (typeof key !== "string" || key === "") {
    throw new Error(
      `Jira accepted the create but sent no key back: ${
        JSON.stringify(result)
      }`,
    );
  }
  return { id: result?.id ?? "", key };
}

/**
 * Links two issues, with the new one as the inward end. Direction matters for
 * a one-way link type, so it is never left to the instance's default.
 */
export async function linkIssues(
  creds: Credentials,
  inwardKey: string,
  outwardKey: string,
  linkType: string,
): Promise<void> {
  await request(
    creds,
    "POST",
    `/rest/api/3/issue/${encodeURIComponent(inwardKey)}/issuelink`,
    {
      body: {
        type: { name: linkType },
        inwardIssue: { key: inwardKey },
        outwardIssue: { key: outwardKey },
      },
    },
  );
}

/**
 * Whether a create was refused over its parent, the one refusal worth retrying
 * as a link. Jira says it in prose and offers no field for it, so this reads
 * the message: if the wording ever changes the fallback simply stops firing,
 * and the declaration stays in the file rather than being created wrongly.
 */
export function isParentRefusal(error: unknown): boolean {
  return error instanceof JiraApiError &&
    error.status >= 400 && error.status < 500 &&
    /\bparent\b/i.test(error.body);
}

/**
 * Every issue's parent, grouped by that parent.
 *
 * `fields.subtasks` only ever lists Sub-task children, so an Epic's real
 * children never appear there: on the TEST project, `subtasks` on the Epic is
 * empty while four issues name it as their parent. The Parent field is the only
 * complete answer, and one narrow query gets it for the whole project at once.
 * Fetched before the render, so every file in a pull agrees.
 */
export async function fetchChildMap(
  creds: Credentials,
  project: string,
): Promise<Map<string, string[]>> {
  const children = new Map<string, string[]>();
  const jql = `project = ${
    jqlQuote(project)
  } AND parent is not EMPTY ORDER BY key ASC`;
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      jql,
      fields: "parent",
      maxResults: String(CHILD_PAGE_SIZE),
    });
    if (pageToken !== undefined) query.set("nextPageToken", pageToken);
    const page = await requestJson<{
      issues?: Array<{ key?: string; fields?: { parent?: { key?: string } } }>;
      nextPageToken?: string;
    }>(creds, "GET", "/rest/api/3/search/jql", { query });
    for (const issue of page.issues ?? []) {
      const parent = issue.fields?.parent?.key;
      if (issue.key === undefined || parent === undefined) continue;
      const keys = children.get(parent) ?? [];
      keys.push(issue.key);
      children.set(parent, keys);
    }
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return children;
}

/** One whole issue with its comments, for re-rendering after a write. */
export async function fetchIssue(
  creds: Credentials,
  key: string,
): Promise<JiraIssue> {
  const issue = await requestJson<JiraIssue>(
    creds,
    "GET",
    `/rest/api/3/issue/${encodeURIComponent(key)}`,
    { query: new URLSearchParams({ fields: ISSUE_FIELDS.join(",") }) },
  );
  if (!hasAllComments(issue)) {
    const comments = await fetchAllComments(creds, key);
    issue.fields.comment = { total: comments.length, comments };
  }
  return issue;
}

async function requestJson<T>(
  creds: Credentials,
  method: HttpMethod,
  path: string,
  opts: { query?: URLSearchParams; body?: unknown } = {},
): Promise<T> {
  return (await request(creds, method, path, opts)) as T;
}

type HttpMethod = "GET" | "POST" | "PUT";

/**
 * A successful write answers 204 with no body, so the body is only parsed when
 * there is one. `requestJson` callers all expect JSON and all get it.
 */
async function request(
  creds: Credentials,
  method: HttpMethod,
  path: string,
  opts: { query?: URLSearchParams; body?: unknown } = {},
): Promise<unknown> {
  const url = `${creds.site}${path}${opts.query ? `?${opts.query}` : ""}`;
  const payload = method === "GET"
    ? undefined
    : JSON.stringify(opts.body ?? {});
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
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text === "" ? undefined : JSON.parse(text);
  }
  throw lastError ?? new Error(`Request to ${url} failed`);
}

function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
