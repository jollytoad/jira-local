/**
 * End-to-end check of push against a fake Jira, over real HTTP.
 *
 * Stands up a local server that answers the endpoints a push needs with
 * payloads shaped the way Jira shapes them, then drives `runPush` over a
 * scratch project and asserts on what the server received and what landed on
 * disk.
 *
 * This is the only check that exercises the response-parsing layer, which the
 * plan and merge checks never touch.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
 *     src/tools/push-e2e.ts
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { runPush } from "../commands/push.ts";
import { fetchIssueStamp } from "../jira.ts";
import { jiraTimestamp } from "../util.ts";
import { BASE_DIR, ISSUES_DIR } from "../constants.ts";

const UPDATED = "2026-05-01T09:15:00.000+0100";
const CREATED = "2026-01-01T08:00:00.000+0000";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok   " : "FAIL "} ${name}${ok ? "" : `: ${detail}`}`);
  if (!ok) failures++;
};

interface Received {
  method: string;
  path: string;
  body: unknown;
}

/** The issue the fake Jira holds, mutable so a test can change it. */
const store = {
  key: "CCC-1",
  summary: "Original summary",
  issueType: "Story",
  status: "To Do",
  statusCategory: "To Do",
  labels: [] as string[],
  description: "Original description.",
  updated: UPDATED,
  comments: [] as unknown[],
  transitions: [
    { id: "11", name: "Start progress", to: { name: "In Progress" } },
    { id: "21", name: "Done", to: { name: "Done" } },
  ],
};

const types = [
  { id: "10000", name: "Epic", subtask: false },
  { id: "10004", name: "Story", subtask: false },
  { id: "10005", name: "Task", subtask: false },
  { id: "10006", name: "Sub-task", subtask: true },
];

const received: Received[] = [];

const server = Deno.serve(
  { port: 0, onListen: () => {} },
  async (request) => {
    const url = new URL(request.url);
    const body = await request.text();
    const parsed: unknown = body === "" ? undefined : JSON.parse(body);
    received.push({ method: request.method, path: url.pathname, body: parsed });

    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });

    if (url.pathname.endsWith("/transitions")) {
      if (request.method === "GET") {
        return json({ transitions: store.transitions });
      }
      const transition = (parsed as { transition?: { id?: string } })
        ?.transition;
      const match = store.transitions.find((t) => t.id === transition?.id);
      if (match === undefined) {
        return json({ errorMessages: ["no such transition"] });
      }
      store.status = match.to?.name ?? store.status;
      store.updated = nextStamp();
      return new Response(null, { status: 204 });
    }

    if (url.pathname.endsWith("/comment")) {
      return json({ comments: store.comments, isLast: true });
    }

    if (url.pathname.startsWith("/rest/api/3/issue/")) {
      const requested = url.searchParams.get("fields") ?? "";
      if (request.method === "PUT") {
        const fields =
          (parsed as { fields?: Record<string, unknown> })?.fields ?? {};
        if (typeof fields["summary"] === "string") {
          store.summary = fields["summary"];
        }
        const issued = fields["issuetype"] as { id?: string } | undefined;
        if (issued?.id !== undefined) {
          const found = types.find((t) => t.id === issued.id);
          if (found === undefined) {
            return json({ errorMessages: [`unknown type ${issued.id}`] });
          }
          store.issueType = found.name;
        }
        if (Array.isArray(fields["labels"])) {
          store.labels = fields["labels"] as string[];
        }
        if (fields["description"] !== undefined) {
          store.description = adfText(fields["description"]);
        }
        const operations = (parsed as { update?: Record<string, unknown> })
          ?.update;
        if (Array.isArray(operations?.["comment"])) {
          store.comments = [...store.comments, { id: "c1" }];
        }
        store.updated = nextStamp();
        // Jira answers a successful write with 204 and no body.
        return new Response(null, { status: 204 });
      }
      if (requested === "updated") {
        return json({ id: "10001", fields: { updated: store.updated } });
      }
      return json(renderIssue());
    }

    if (url.pathname === "/rest/api/3/myself") {
      return json({ accountId: "acc", timeZone: "Europe/London" });
    }
    if (url.pathname === "/rest/api/3/project/CCC") {
      return json({ id: "10005", key: "CCC", issueTypes: types });
    }
    return json({ errorMessages: ["not found"] });
  },
);

let stampCounter = 0;
function nextStamp(): string {
  stampCounter += 1;
  return `2026-05-01T09:${
    String(15 + stampCounter).padStart(2, "0")
  }:00.000+0100`;
}

function renderIssue() {
  return {
    id: "10001",
    key: store.key,
    fields: {
      summary: store.summary,
      status: {
        name: store.status,
        statusCategory: { name: store.statusCategory },
      },
      issuetype: { name: store.issueType },
      parent: null,
      subtasks: [],
      issuelinks: [],
      priority: { name: "Medium" },
      assignee: null,
      reporter: null,
      labels: store.labels,
      created: CREATED,
      updated: store.updated,
      description: {
        version: 1,
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: store.description }],
          },
        ],
      },
      comment: { total: store.comments.length, comments: store.comments },
    },
  };
}

const cwd = process.cwd();
const dir = await mkdtemp(join(cwd, ".tmp", "push-e2e-"));
await mkdir(join(dir, ".jira", "issues", "all"), { recursive: true });
await mkdir(join(dir, BASE_DIR), { recursive: true });
process.chdir(dir);
const outDir = join(process.cwd(), ISSUES_DIR);

await writeFile(
  join(dir, ".jira", ".config.ts"),
  `export const config = {
  site: "http://127.0.0.1:${server.addr.port}",
  project: "CCC",
  email: "a@b.test",
  token: "t",
};
`,
);

function baseMarkdown(): string {
  const head = `---
key: ${store.key}
summary: ${store.summary}
status: ${store.status}
statusCategory: ${store.statusCategory}
type: ${store.issueType}
priority: Medium
assignee: ''
reporter: ''
labels: []
parent: ''
children: []
linked: []
created: '${CREATED}'
updated: '${store.updated}'
url: 'http://127.0.0.1/browse/${store.key}'
---

# ${store.key} ${store.summary}`;
  // The renderer omits an empty description, so the heading goes too.
  return store.description === ""
    ? head
    : `${head}\n\n## Description\n\n${store.description}\n`;
}

/** Flattens a description to text, so the fake can store what it was sent. */
function adfText(node: unknown): string {
  if (Array.isArray(node)) return node.map(adfText).join("\n\n");
  const item = node as { type?: string; text?: string; content?: unknown };
  if (item?.type === "text") return item.text ?? "";
  if (item?.type === "hardBreak") return "\n";
  return item?.content === undefined ? "" : adfText(item.content);
}

const baseFile = baseMarkdown();
await writeFile(join(outDir, `${store.key}.md`), baseFile);
await writeFile(join(dir, BASE_DIR, `${store.key}.md`), baseFile);

try {
  // The lease read must find `updated`, which Jira nests under `fields`.
  const creds = {
    site: `http://127.0.0.1:${server.addr.port}`,
    email: "a@b.test",
    token: "t",
  };
  const seen = await fetchIssueStamp(creds, store.key);
  check(
    "the lease read finds `updated`",
    seen.updated === UPDATED,
    JSON.stringify(seen),
  );
  check("the lease read finds `id`", seen.id === "10001", JSON.stringify(seen));

  // A dry run must report without writing.
  await writeFile(
    join(outDir, `${store.key}.md`),
    baseFile.replace("summary: Original summary", "summary: Edited summary"),
  );
  received.length = 0;
  const output = await captureLog(() =>
    runPush({ dryRun: true, yes: true, keys: [] })
  );
  const put = received.find((r) => r.method === "PUT");
  check("a dry run sends no write", put === undefined, JSON.stringify(put));
  check(
    "a dry run leaves the file alone",
    (await readFile(join(outDir, `${store.key}.md`), "utf8")).includes(
      "summary: Edited summary",
    ),
    "rewritten",
  );
  check(
    "a dry run shows a real diff",
    output.includes("+++") && output.includes("---"),
    output.slice(0, 300),
  );
  check(
    "the diff names the changed line",
    output.includes("+summary: Edited summary"),
    output.slice(0, 300),
  );

  // The real thing.
  received.length = 0;
  await runPush({ dryRun: false, yes: true, keys: [] });

  const written = received.find((r) => r.method === "PUT");
  const sent =
    (written?.body as { fields?: Record<string, unknown> } | undefined)
      ?.fields ?? {};
  check("a PUT was sent", written !== undefined, "none");
  check(
    "only the summary was sent",
    Object.keys(sent).join(",") === "summary",
    JSON.stringify(sent),
  );
  check(
    "the new summary reached Jira",
    sent["summary"] === "Edited summary",
    String(sent["summary"]),
  );
  check(
    "no transition was attempted",
    !received.some((r) => r.path.endsWith("/transitions")),
    "attempted",
  );

  const after = await readFile(join(outDir, `${store.key}.md`), "utf8");
  check(
    "the file now matches Jira",
    after.includes("summary: Edited summary"),
    "stale",
  );
  check(
    "the file carries Jira's new stamp",
    after.includes(store.updated.slice(0, 10)),
    "stale",
  );

  const newBase = await readFile(
    join(dir, BASE_DIR, `${store.key}.md`),
    "utf8",
  );
  check("the base was refreshed", newBase === after, "differs from the file");
  check(
    "the base carries Jira's full timestamp",
    newBase.includes(`updated: '${store.updated}'`),
    newBase.slice(0, 400),
  );
  check(
    "created keeps Jira's full timestamp too",
    newBase.includes(`created: '${CREATED}'`),
    newBase.slice(0, 400),
  );
  check(
    "a date-only source stays a date",
    jiraTimestamp("2026-03-14") === "2026-03-14",
    "it was widened",
  );
  check(
    "a full timestamp is not narrowed",
    jiraTimestamp("2026-03-14T15:09:26.535+0000") ===
      "2026-03-14T15:09:26.535+0000",
    "it was truncated",
  );
  check(
    "a missing timestamp is empty",
    jiraTimestamp(undefined) === "" && jiraTimestamp("") === "",
    "not empty",
  );
  check(
    "the lease needs no separate file",
    !(await readdir(join(dir, BASE_DIR))).includes("leases.json"),
    `the base dir holds ${(await readdir(join(dir, BASE_DIR))).join(", ")}`,
  );

  // A stale lease must refuse before anything is sent. Rewriting the stamp in
  // the base is all it takes now, since the lease lives in the front matter.
  await writeFile(
    join(dir, BASE_DIR, `${store.key}.md`),
    (await readFile(join(dir, BASE_DIR, `${store.key}.md`), "utf8")).replace(
      `updated: '${store.updated}'`,
      "updated: '2020-01-01T00:00:00.000+0000'",
    ),
  );
  await writeFile(
    join(outDir, `${store.key}.md`),
    after.replace("summary: Edited summary", "summary: A different summary"),
  );
  received.length = 0;
  process.exitCode = 0;
  await runPush({ dryRun: false, yes: true, keys: [] });
  check(
    "a stale lease sends nothing",
    !received.some((r) => r.method === "PUT"),
    "wrote anyway",
  );
  check(
    "a stale lease exits non-zero",
    process.exitCode === 1,
    `exit ${process.exitCode}`,
  );
  process.exitCode = 0;

  // Conflict markers must refuse too.
  await writeFile(
    join(dir, BASE_DIR, `${store.key}.md`),
    await readFile(join(outDir, `${store.key}.md`), "utf8"),
  );
  await writeFile(
    join(outDir, `${store.key}.md`),
    after + "\n<<<<<<< local\nmine\n=======\n\n>>>>>>> jira\n",
  );
  received.length = 0;
  await runPush({ dryRun: false, yes: true, keys: [] });
  check(
    "conflict markers refuse the push",
    !received.some((r) => r.method === "PUT"),
    "wrote anyway",
  );

  // An issue with an empty description has no `## Description` heading, so the
  // first description anyone writes is loose text below the title.
  store.description = "";
  store.comments = [];
  store.summary = "No description yet";
  const bare = baseMarkdown();
  check(
    "an issue with no description has no heading",
    !bare.includes("## Description"),
    bare,
  );
  await writeFile(join(outDir, `${store.key}.md`), bare);
  await writeFile(join(dir, BASE_DIR, `${store.key}.md`), bare);

  await writeFile(
    join(outDir, `${store.key}.md`),
    `${bare}\nChange the description\n`,
  );
  received.length = 0;
  await runPush({ dryRun: false, yes: true, keys: [] });
  const barePut = received.find((r) => r.method === "PUT");
  const bareFields =
    (barePut?.body as { fields?: Record<string, unknown> } | undefined)
      ?.fields ?? {};
  check(
    "text below the title is sent as the description",
    bareFields["description"] !== undefined,
    JSON.stringify(barePut?.body),
  );
  check(
    "that description keeps the written text",
    JSON.stringify(bareFields["description"]).includes(
      "Change the description",
    ),
    JSON.stringify(bareFields["description"]),
  );
  check(
    "the file gains a description section after the push",
    (await readFile(join(outDir, `${store.key}.md`), "utf8")).includes(
      "## Description",
    ),
    "missing",
  );

  // An issue type is sent as an id, resolved from the project's own list.
  const typeBase = baseMarkdown();
  await writeFile(join(dir, BASE_DIR, `${store.key}.md`), typeBase);
  await writeFile(
    join(outDir, `${store.key}.md`),
    typeBase.replace(`type: ${store.issueType}`, "type: Task"),
  );
  received.length = 0;
  await runPush({ dryRun: false, yes: true, keys: [] });
  const typePut = received.find((r) => r.method === "PUT");
  const typeFields =
    (typePut?.body as { fields?: Record<string, unknown> } | undefined)
      ?.fields ?? {};
  check(
    "a type change is sent",
    typeFields["issuetype"] !== undefined,
    JSON.stringify(typePut?.body),
  );
  check(
    "a type is sent as an id, not a name",
    (typeFields["issuetype"] as { id?: unknown })?.id === "10005",
    JSON.stringify(typeFields["issuetype"]),
  );
  check(
    "the project was consulted for the type list",
    received.some((r) => r.path === "/rest/api/3/project/CCC"),
    "never asked",
  );
  check(
    "the file now shows the new type",
    (await readFile(join(outDir, `${store.key}.md`), "utf8")).includes(
      "type: Task",
    ),
    "stale",
  );
  check(
    "the fake Jira stored the new type",
    store.issueType === "Task",
    store.issueType,
  );

  // A name the project does not offer must be refused, not guessed at.
  const badBase = baseMarkdown();
  await writeFile(join(dir, BASE_DIR, `${store.key}.md`), badBase);
  await writeFile(
    join(outDir, `${store.key}.md`),
    badBase.replace(`type: ${store.issueType}`, "type: Nonexistent Type"),
  );
  received.length = 0;
  process.exitCode = 0;
  await runPush({ dryRun: false, yes: true, keys: [] });
  check(
    "an unknown type name sends nothing",
    !received.some((r) => r.method === "PUT"),
    "wrote anyway",
  );
  check(
    "an unknown type name exits non-zero",
    process.exitCode === 1,
    `exit ${process.exitCode}`,
  );
  process.exitCode = 0;
} finally {
  process.chdir(cwd);
  await server.shutdown();
  await rm(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "push end-to-end checks pass"
    : `${failures} push checks fail`,
);
process.exitCode = failures === 0 ? 0 : 1;

/** Runs a command with `console.log` captured, so its output can be asserted on. */ async function captureLog(
  run: () => Promise<void>,
): Promise<string> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = real;
  }
  return lines.join("\n");
}
