/**
 * End-to-end check of declaring and creating new issues, over real HTTP.
 *
 * A fake Jira stands in, shaped the way Jira shapes its answers, and `runPush`
 * is driven over a scratch project. What it sent and what landed on disk are
 * both asserted, so the whole path — parse, plan, create, link fallback, cut
 * the declaration out, re-read the host — is covered end to end.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-run \
 *     src/tools/create-e2e.ts
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

import { runPush } from "../src/commands/push.ts";
import {
  bodyText,
  removeDeclarations,
  scanDeclarations,
} from "../src/declarations.ts";
import { planCreate } from "../src/create.ts";
import { parseIssueFile } from "../src/issue-file.ts";
import { planPush } from "../src/push-plan.ts";
import {
  BASE_DIR,
  ISSUES_DIR,
  JIRA_DIR,
  NEW_DIR_NAME,
  setJiraDir,
} from "../src/constants.ts";

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

const types = [
  { id: "10000", name: "Epic", subtask: false },
  { id: "10004", name: "Story", subtask: false },
  { id: "10005", name: "Task", subtask: false },
  { id: "10006", name: "Sub-task", subtask: true },
  { id: "10007", name: "Bug", subtask: false },
];

interface Issue {
  key: string;
  summary: string;
  type: string;
  parent?: string;
  links: string[];
  labels: string[];
  description: string;
  updated: string;
}

const store = new Map<string, Issue>();
let nextKey = 0;
/** Set to make every create with a parent fail the way a classic project does. */
let refuseParent = false;
/** Set to make a Sub-task create fail the way Jira does with no parent. */
let refuseOrphanSubtask = false;

function seed(key: string, over: Partial<Issue> = {}): void {
  store.set(key, {
    key,
    summary: "An existing issue",
    type: "Story",
    links: [],
    labels: [],
    description: "The original description.",
    updated: UPDATED,
    ...over,
  });
}
seed("DDD-1");
// A root issue with no parent, for the re-parenting checks below.
seed("DDD-90", { summary: "A loose issue", type: "Story" });

const received: Received[] = [];

const server = Deno.serve(
  { port: 0, onListen: () => {} },
  async (request) => {
    const url = new URL(request.url);
    const raw = await request.text();
    const parsed: unknown = raw === "" ? undefined : JSON.parse(raw);
    received.push({ method: request.method, path: url.pathname, body: parsed });

    const json = (
      value: unknown,
      init: { status?: number } = {},
    ) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
        ...init,
      });

    if (url.pathname.endsWith("/issuelink")) {
      const body = parsed as {
        type?: { name?: string };
        inwardIssue?: { key?: string };
        outwardIssue?: { key?: string };
      };
      const inward = store.get(body.inwardIssue?.key ?? "");
      const outward = store.get(body.outwardIssue?.key ?? "");
      if (inward === undefined || outward === undefined) {
        return json({ errorMessages: ["no such issue"] });
      }
      if (!inward.links.includes(outward.key)) inward.links.push(outward.key);
      if (!outward.links.includes(inward.key)) outward.links.push(inward.key);
      return new Response(null, { status: 201 });
    }

    if (url.pathname === "/rest/api/3/issue") {
      const fields = (parsed as { fields?: Record<string, unknown> })?.fields ??
        {};
      const type = types.find((t) =>
        t.id === (fields["issuetype"] as { id?: string } | undefined)?.id
      );
      if (type === undefined) {
        return json({ errors: { issuetype: "unknown type" } }, { status: 400 });
      }
      const parentKey = (fields["parent"] as { key?: string } | undefined)?.key;
      const summary = String(fields["summary"] ?? "");
      // Jira refuses a parent for a type that cannot hold children, and refuses
      // a subtask that has none at all. Both come back as 4xx.
      if (parentKey !== undefined && refuseParent) {
        return json({
          errorMessages: [
            "Field 'parent' cannot be set. It is not on the appropriate screen.",
          ],
        }, { status: 400 });
      }
      if (parentKey === undefined && type.subtask && refuseOrphanSubtask) {
        return json({
          errorMessages: ["Field 'parent' is required for a sub-task."],
        }, { status: 400 });
      }
      if (parentKey !== undefined && !store.has(parentKey)) {
        return json({
          errorMessages: [
            `Issue does not exist or you do not have permission to see it: ${parentKey}`,
          ],
        }, { status: 400 });
      }
      nextKey += 1;
      const key = `DDD-${100 + nextKey}`;
      const created: Issue = {
        key,
        summary,
        type: type.name,
        ...(parentKey === undefined ? {} : { parent: parentKey }),
        links: [],
        labels: [],
        description: adfText(fields["description"]),
        updated: "2026-05-02T10:00:00.000+0100",
      };
      store.set(key, created);
      return json({ id: `${1000 + nextKey}`, key }, { status: 201 });
    }

    if (url.pathname === "/rest/api/3/search/jql") {
      // The Parent field, which is the only complete answer for an Epic's
      // children: `subtasks` holds Sub-tasks only.
      const jql = url.searchParams.get("jql") ?? "";
      if (!/parent is not EMPTY/.test(jql)) {
        return json({ issues: [], isLast: true });
      }
      return json({
        issues: [...store.values()]
          .filter((issue) => issue.parent !== undefined)
          .map((issue) => ({
            key: issue.key,
            fields: { parent: { key: issue.parent } },
          })),
        isLast: true,
      });
    }

    if (url.pathname.startsWith("/rest/api/3/issue/")) {
      const key = decodeURIComponent(
        url.pathname.slice("/rest/api/3/issue/".length),
      );
      const issue = store.get(key);
      if (issue === undefined) {
        return json({ errorMessages: ["not found"] }, { status: 404 });
      }
      if (request.method === "PUT") {
        const fields =
          (parsed as { fields?: Record<string, unknown> })?.fields ?? {};
        if (typeof fields["summary"] === "string") {
          issue.summary = fields["summary"];
        }
        if (Array.isArray(fields["labels"])) {
          issue.labels = fields["labels"] as string[];
        }
        if (fields["parent"] === null) {
          return json({ errorMessages: ["parent cannot be removed"] }, {
            status: 400,
          });
        }
        if (fields["description"] !== undefined) {
          issue.description = adfText(fields["description"]);
        }
        issue.updated = nextStamp();
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get("fields") === "updated") {
        return json({ id: "1", fields: { updated: issue.updated } });
      }
      return json(render(issue));
    }

    if (url.pathname === "/rest/api/3/project/DDD") {
      return json({ id: "10001", key: "DDD", issueTypes: types });
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

function render(issue: Issue) {
  const children = [...store.values()].filter((i) => i.parent === issue.key);
  return {
    id: "1",
    key: issue.key,
    fields: {
      summary: issue.summary,
      status: {
        name: "To Do",
        statusCategory: { name: "To Do" },
      },
      issuetype: { name: issue.type },
      parent: issue.parent === undefined
        ? null
        : { key: issue.parent, fields: { summary: "" } },
      // Jira really does report only Sub-task children here, which is what left
      // an Epic's children invisible.
      subtasks: children
        .filter((child) => child.type === "Sub-task")
        .map((child) => ({ key: child.key, fields: {} })),
      issuelinks: issue.links.map((key) => ({
        type: { name: "Relates To" },
        outwardIssue: { key, fields: {} },
      })),
      priority: { name: "Medium" },
      assignee: null,
      reporter: null,
      labels: [],
      created: CREATED,
      updated: issue.updated,
      description: {
        version: 1,
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: issue.description }],
          },
        ],
      },
      comment: { total: 0, comments: [] },
    },
  };
}

function adfText(node: unknown): string {
  if (Array.isArray(node)) return node.map(adfText).join("\n\n");
  const item = node as { type?: string; text?: string; content?: unknown };
  if (item?.type === "text") return item.text ?? "";
  if (item?.content === undefined) return "";
  return adfText(item.content);
}

/** The raw issue as Jira holds it, so a test can see a field the render drops. */
async function fetchIssueRaw(
  site: string,
  key: string,
): Promise<{ fields: { subtasks?: unknown[] } }> {
  return await (await fetch(
    `${site}/rest/api/3/issue/${key}?fields=subtasks,parent,issuetype`,
    {
      headers: {
        authorization: `Basic ${btoa("a@b.test:t")}`,
        accept: "application/json",
      },
    },
  )).json() as { fields: { subtasks?: unknown[] } };
}

// The renderer writes top-level arrays inline (`flowLevel: 1`), so a front
// matter list reads `children: [A, B]` and never a block.
function childrenOf_(file: string): string[] {
  const line = /^children: \[(.*)\]$/m.exec(file)?.[1] ?? "";
  return line.split(",").map((key) => key.trim()).filter((key) => key !== "");
}

function withChildren(file: string, keys: readonly string[]): string {
  const line = keys.length === 0
    ? "children: []"
    : `children: [${keys.join(", ")}]`;
  return file.replace(/^children: .*$/m, line);
}

// ---------------------------------------------------------------------------
// The scanner, on its own, before anything touches the network.
// ---------------------------------------------------------------------------

const loose =
  "Ideas worth keeping.\n\n# Fix the login redirect [Bug]\n\nUsers land on the dashboard.\n\n# Add a changelog\n\nNobody can tell what changed.\n";
const looseScan = scanDeclarations(loose, {
  absPath: "/x/ideas.md",
  relPath: "all/ideas.md",
  typeNames: types.map((t) => t.name),
});

check(
  "a loose file declares every heading",
  looseScan.declarations.length === 2,
  `${looseScan.declarations.length}`,
);
check(
  "the first heading is the summary",
  looseScan.declarations[0]?.summary === "Fix the login redirect",
  looseScan.declarations[0]?.summary,
);
check(
  "a real type is stripped from the summary",
  looseScan.declarations[0]?.typeHint === "Bug",
  String(looseScan.declarations[0]?.typeHint),
);
check(
  "the body under the heading is the description",
  looseScan.declarations[0]?.body === "Users land on the dashboard.",
  JSON.stringify(looseScan.declarations[0]?.body),
);
check(
  "notes before a declaration are kept",
  looseScan.stripped.startsWith("Ideas worth keeping."),
  JSON.stringify(looseScan.stripped),
);
check(
  "nothing is left but the notes",
  bodyText(looseScan.stripped) === "Ideas worth keeping.",
  JSON.stringify(looseScan.stripped),
);
check(
  "a loose file has no parent",
  looseScan.declarations[0]?.hostKey === undefined,
);

const brackets = scanDeclarations("# Cache the homepage [urgent]\n\nBody.\n", {
  absPath: "/x/ideas.md",
  relPath: "all/ideas.md",
  typeNames: types.map((t) => t.name),
});
check(
  "a name that is not a type keeps its brackets",
  brackets.declarations[0]?.summary === "Cache the homepage [urgent]",
  brackets.declarations[0]?.summary,
);
check(
  "and it is reported unverified",
  brackets.declarations[0]?.marker === "urgent" &&
    brackets.declarations[0]?.typeHint === undefined,
  JSON.stringify(brackets.declarations[0]),
);

// A marker is read at either end, because both are written in practice.
for (const heading of ["[Bug] Fix the redirect", "Fix the redirect [Bug]"]) {
  const scan = scanDeclarations(`# ${heading}\n\nBody.\n`, {
    absPath: "/x/ideas.md",
    relPath: "all/ideas.md",
    typeNames: types.map((t) => t.name),
  });
  check(
    `a leading marker is read: ${heading}`,
    scan.declarations[0]?.typeHint === "Bug" &&
      scan.declarations[0]?.summary === "Fix the redirect",
    JSON.stringify(scan.declarations[0]),
  );
}
const exact = scanDeclarations("# [task] lowercase marker\n\nBody.\n", {
  absPath: "/x/ideas.md",
  relPath: "all/ideas.md",
  typeNames: types.map((t) => t.name),
});
check(
  "a marker matches a type whatever its case",
  exact.declarations[0]?.typeHint === "Task" &&
    exact.declarations[0]?.summary === "lowercase marker",
  JSON.stringify(exact.declarations[0]),
);
check(
  "a bracketed word mid-heading is not a marker",
  scanDeclarations("# see [1] for details\n\nBody.\n", {
    absPath: "/x/ideas.md",
    relPath: "all/ideas.md",
    typeNames: ["1"],
  }).declarations[0]?.summary === "see [1] for details",
);

const issueFile = `---
key: DDD-1
summary: An existing issue
---

# DDD-1 An existing issue

## Description

The original description.

# A child of it [Task]

Something to do later.
`;
const issueScan = scanDeclarations(issueFile, {
  absPath: "/x/DDD-1.md",
  relPath: "all/DDD-1.md",
  hostKey: "DDD-1",
  typeNames: types.map((t) => t.name),
});
check(
  "an issue file's own title is not a declaration",
  issueScan.declarations.length === 1,
  `${issueScan.declarations.length}`,
);
check(
  "the declaration takes the host as its parent",
  issueScan.declarations[0]?.hostKey === "DDD-1",
  String(issueScan.declarations[0]?.hostKey),
);
check(
  "cutting a declaration leaves the host intact",
  issueScan.stripped.includes("The original description.") &&
    !issueScan.stripped.includes("Something to do later.") &&
    issueScan.stripped.includes("# DDD-1 An existing issue"),
  JSON.stringify(issueScan.stripped),
);

const fenced =
  "```bash\n# not a heading\nnpm i\n```\n\n# A real one\n\nBody.\n";
const fencedScan = scanDeclarations(fenced, {
  absPath: "/x/ideas.md",
  relPath: "all/ideas.md",
  typeNames: [],
});
check(
  "a heading inside a fence declares nothing",
  fencedScan.declarations.length === 1,
  `${fencedScan.declarations.length}`,
);
check(
  "and the real one is found",
  fencedScan.declarations[0]?.summary === "A real one",
  fencedScan.declarations[0]?.summary,
);

const front = "---\nkey: DDD-1\n---\n\n# From the body\n\nText.\n";
const frontScan = scanDeclarations(front, {
  absPath: "/x/ideas.md",
  relPath: "all/ideas.md",
  typeNames: [],
});
check(
  "front matter is left alone",
  frontScan.stripped.startsWith("---\nkey: DDD-1\n---"),
  JSON.stringify(frontScan.stripped),
);
check(
  "a loose file with no title declares its first heading",
  frontScan.declarations.length === 1,
  `${frontScan.declarations.length}`,
);

const context = { typeNames: types.map((t) => t.name), defaultType: "Task" };
check(
  "an empty heading is refused",
  planCreate(
    scanDeclarations("#\n\nBody.\n", {
      absPath: "/x/ideas.md",
      relPath: "all/ideas.md",
      typeNames: [],
    }).declarations[0]!,
    context,
  ).refusal !== undefined,
);
check(
  "an unknown type is refused",
  planCreate(brackets.declarations[0]!, context).refusal?.includes(
    "no issue type named",
  ) === true,
  planCreate(brackets.declarations[0]!, context).refusal,
);
check(
  "a refused type lists what there is",
  (planCreate(brackets.declarations[0]!, context).refusal ?? "").includes(
    "Sub-task",
  ),
  planCreate(brackets.declarations[0]!, context).refusal,
);
check(
  "a table in a body is refused",
  planCreate(
    scanDeclarations("# One\n\n| a | b |\n| - | - |\n", {
      absPath: "/x/ideas.md",
      relPath: "all/ideas.md",
      typeNames: [],
    }).declarations[0]!,
    context,
  ).refusal?.includes("description:") === true,
);
check(
  "a heading with no body creates an empty description",
  planCreate(
    scanDeclarations("# Bare\n\n# Next one\n\nBody.\n", {
      absPath: "/x/ideas.md",
      relPath: "all/ideas.md",
      typeNames: [],
    }).declarations[0]!,
    context,
  ).description === undefined,
);
check(
  "the default type is used when the heading names none",
  planCreate(issueScan.declarations[0]!, context).typeName === "Task",
);

// ---------------------------------------------------------------------------
// The whole push path.
// ---------------------------------------------------------------------------

const cwd = process.cwd();
const dir = await mkdtemp(join(cwd, ".tmp", "create-e2e-"));
process.chdir(dir);
setJiraDir(".jira");
await mkdir(ISSUES_DIR, { recursive: true });
await mkdir(BASE_DIR, { recursive: true });
await mkdir(join(JIRA_DIR, "issues", NEW_DIR_NAME), { recursive: true });
const outDir = ISSUES_DIR;

await writeFile(
  join(dir, ".jira", ".config.ts"),
  `export const config = {
  site: "http://127.0.0.1:${server.addr.port}",
  project: "DDD",
  email: "a@b.test",
  token: "t",
  defaultIssueType: "Task",
  newIssueLinkType: "Relates To",
};
`,
);

// The base is Jira's own render of the seed issue.
function baseFor(key: string, summary: string, type: string): string {
  return `---
key: ${key}
summary: ${summary}
status: To Do
statusCategory: To Do
type: ${type}
priority: Medium
assignee: ''
reporter: ''
labels: []
parent: ''
children: []
linked: []
created: '${CREATED}'
updated: '${UPDATED}'
url: 'http://127.0.0.1/browse/${key}'
---

# ${key} ${summary}

## Description

The original description.
`;
}

const hostBase = baseFor("DDD-1", "An existing issue", "Story");
await writeFile(join(outDir, "DDD-1.md"), hostBase);
await writeFile(join(BASE_DIR, "DDD-1.md"), hostBase);

// An Epic, whose children are real issues rather than subtasks — the case that
// `fields.subtasks` cannot see.
seed("DDD-2", { summary: "An epic", type: "Epic" });
const epicBase = baseFor("DDD-2", "An epic", "Epic");
await writeFile(join(outDir, "DDD-2.md"), epicBase);
await writeFile(join(BASE_DIR, "DDD-2.md"), epicBase);

try {
  // A dry run must plan the create and write nothing.
  await writeFile(
    join(dir, ".jira", "issues", NEW_DIR_NAME, "ideas.md"),
    loose,
  );
  received.length = 0;
  const plan = await captureLog(() =>
    runPush({ dryRun: true, yes: true, keys: [] })
  );
  check(
    "a dry run creates nothing",
    !received.some((r) => r.method === "POST"),
    JSON.stringify(received.map((r) => r.method)),
  );
  check(
    "a dry run leaves the declaration file alone",
    (await readFile(
      join(dir, ".jira", "issues", NEW_DIR_NAME, "ideas.md"),
      "utf8",
    )) === loose,
    "rewritten",
  );
  check(
    "a dry run names the new issues",
    plan.includes("new issues (2)") &&
      plan.includes("Fix the login redirect") &&
      plan.includes("Add a changelog"),
    plan.slice(0, 600),
  );
  check(
    "a dry run shows the type it resolved",
    plan.includes("type: Bug") && plan.includes("type: Task"),
    plan.slice(0, 600),
  );

  // The real thing: a child of the host, and a root issue.
  await writeFile(
    join(outDir, "DDD-1.md"),
    `${hostBase}\n# A child of DDD-1\n\nSomething to do later.\n`,
  );
  received.length = 0;
  process.exitCode = 0;
  await runPush({ dryRun: false, yes: true, keys: [] });

  const creates = received.filter((r) =>
    r.method === "POST" && r.path === "/rest/api/3/issue"
  );
  check("three issues were created", creates.length === 3, `${creates.length}`);

  const bySummary = new Map(
    creates.map((r) => {
      const fields = (r.body as { fields?: Record<string, unknown> })?.fields ??
        {};
      return [String(fields["summary"]), fields];
    }),
  );
  check(
    "the child carries its host as parent",
    (bySummary.get("A child of DDD-1")?.["parent"] as { key?: string })?.key ===
      "DDD-1",
    JSON.stringify(bySummary.get("A child of DDD-1")?.["parent"]),
  );
  check(
    "the type reaches Jira as an id",
    (bySummary.get("Fix the login redirect")?.["issuetype"] as { id?: string })
      ?.id === "10007",
    JSON.stringify(bySummary.get("Fix the login redirect")?.["issuetype"]),
  );
  check(
    "a root declaration carries no parent",
    bySummary.get("Add a changelog")?.["parent"] === undefined,
    JSON.stringify(bySummary.get("Add a changelog")),
  );
  check(
    "the body becomes the description",
    JSON.stringify(bySummary.get("Fix the login redirect")?.["description"])
      .includes(
        "Users land on the dashboard",
      ),
    JSON.stringify(bySummary.get("Fix the login redirect")?.["description"]),
  );
  check(
    "nothing was refused",
    process.exitCode === 0,
    `exit ${process.exitCode}`,
  );

  // The new issues are on disk, keyed and based like any other issue.
  const names = (await readdir(outDir)).filter((n) => n.endsWith(".md")).sort();
  check(
    "the host file is still there",
    names.includes("DDD-1.md"),
    names.join(", "),
  );
  check(
    "three issues were written",
    names.filter((n) => /^DDD-1\d\d\.md$/.test(n)).length === 3,
    names.join(", "),
  );
  const childKey = [...store.values()].find((i) =>
    i.summary === "A child of DDD-1"
  )?.key ?? "";
  const childFile = await readFile(join(outDir, `${childKey}.md`), "utf8");
  check(
    "a new issue is rendered like any other",
    childFile.includes(`key: ${childKey}`) &&
      childFile.includes("parent: DDD-1"),
    childFile.slice(0, 300),
  );
  check(
    "a new issue gets a base",
    await readFile(join(BASE_DIR, `${childKey}.md`), "utf8").then(
      (text) => text === childFile,
      () => false,
    ),
    "no base",
  );

  // The declarations are gone, and the notes that were not one are still there.
  const hostAfter = await readFile(join(outDir, "DDD-1.md"), "utf8");
  check(
    "the host declaration is cut out",
    !hostAfter.includes("Something to do later."),
    hostAfter.slice(0, 400),
  );
  check(
    "the host's own text survived",
    hostAfter.includes("The original description."),
    hostAfter.slice(0, 400),
  );
  check(
    "the host now lists its child",
    hostAfter.includes(`children:\n  - ${childKey}`) ||
      hostAfter.includes(childKey),
    hostAfter.slice(0, 400),
  );
  const looseAfter = await readFile(
    join(dir, ".jira", "issues", NEW_DIR_NAME, "ideas.md"),
    "utf8",
  );
  check(
    "the notes at the top of a loose file stay",
    looseAfter.includes("Ideas worth keeping."),
    JSON.stringify(looseAfter),
  );
  check(
    "its declarations are cut out",
    !looseAfter.includes("Fix the login redirect") &&
      !looseAfter.includes("Add a changelog"),
    JSON.stringify(looseAfter),
  );

  // A loose file holding nothing but declarations goes away.
  await writeFile(
    join(dir, ".jira", "issues", NEW_DIR_NAME, "throwaway.md"),
    "# Nothing but this\n",
  );
  await runPush({ dryRun: false, yes: true, keys: [] });
  check(
    "a loose file with only declarations is deleted",
    !(await readdir(join(dir, ".jira", "issues", NEW_DIR_NAME))).includes(
      "throwaway.md",
    ),
    (await readdir(join(dir, ".jira", "issues", NEW_DIR_NAME))).join(", "),
  );

  // A parent the host cannot hold: the fallback links instead, same type.
  refuseParent = true;
  received.length = 0;
  await writeFile(
    join(outDir, "DDD-1.md"),
    `${await readFile(
      join(outDir, "DDD-1.md"),
      "utf8",
    )}\n# Cannot be a child\n\nBody.\n`,
  );
  process.exitCode = 0;
  await runPush({ dryRun: false, yes: true, keys: [] });
  const fallback = [...store.values()].find((i) =>
    i.summary === "Cannot be a child"
  );
  check(
    "the fallback still created the issue",
    fallback !== undefined,
    "not created",
  );
  check(
    "it kept the requested type",
    fallback?.type === "Task",
    fallback?.type,
  );
  check(
    "it is not a child",
    fallback?.parent === undefined,
    String(fallback?.parent),
  );
  check(
    "it is linked to the host",
    fallback?.links.includes("DDD-1") === true,
    JSON.stringify(fallback?.links),
  );
  check(
    "the link names its type",
    JSON.stringify(received.find((r) => r.path.endsWith("/issuelink"))?.body)
      .includes("Relates To"),
    JSON.stringify(received.find((r) => r.path.endsWith("/issuelink"))?.body),
  );
  check(
    "the declaration is cut out either way",
    !(await readFile(join(outDir, "DDD-1.md"), "utf8")).includes(
      "Cannot be a child",
    ),
    "still there",
  );
  check(
    "the fallback is not a failure",
    process.exitCode === 0,
    `exit ${process.exitCode}`,
  );
  refuseParent = false;

  // A Sub-task is the one case neither path can satisfy.
  refuseParent = true;
  refuseOrphanSubtask = true;
  received.length = 0;
  await writeFile(
    join(outDir, "DDD-1.md"),
    `${await readFile(
      join(outDir, "DDD-1.md"),
      "utf8",
    )}\n# A subtask [Sub-task]\n\nBody.\n`,
  );
  process.exitCode = 0;
  await runPush({ dryRun: false, yes: true, keys: [] });
  const subtaskAttempt = received.filter((r) =>
    r.method === "POST" && r.path === "/rest/api/3/issue"
  ).length;
  check(
    "a subtask is created once, not twice",
    subtaskAttempt === 1,
    `${subtaskAttempt}`,
  );
  check(
    "nothing was created for it",
    [...store.values()].every((i) =>
      i.summary !== "A subtask"
    ),
    "created",
  );
  check(
    "the declaration stays put",
    (await readFile(join(outDir, "DDD-1.md"), "utf8")).includes("A subtask"),
    "removed",
  );
  check(
    "the subtask fails",
    process.exitCode === 1,
    `exit ${process.exitCode}`,
  );
  refuseParent = false;
  refuseOrphanSubtask = false;

  // A file named like a key that Jira does not have is reported, not created.
  await writeFile(
    join(outDir, "DDD-999.md"),
    hostBase.replace("DDD-1", "DDD-999"),
  );
  received.length = 0;
  process.exitCode = 0;
  await captureLog(() => runPush({ dryRun: false, yes: true, keys: [] }));
  check(
    "an unknown key is refused",
    !received.some((r) =>
      r.path === "/rest/api/3/issue/DDD-999" && r.method === "PUT"
    ),
    "wrote anyway",
  );
  check(
    "an unknown key exits non-zero",
    process.exitCode === 1,
    `exit ${process.exitCode}`,
  );
  process.exitCode = 0;
  await rm(join(outDir, "DDD-999.md"));

  // A conflicted host declares nothing that may be created.
  await writeFile(
    join(outDir, "DDD-1.md"),
    (await readFile(join(outDir, "DDD-1.md"), "utf8")) +
      "\n# Declared in a conflicted file\n\nBody.\n<<<<<<< local\nmine\n=======\n\n>>>>>>> jira\n",
  );
  received.length = 0;
  process.exitCode = 0;
  await captureLog(() => runPush({ dryRun: false, yes: true, keys: [] }));
  check(
    "a conflicted host creates nothing",
    !received.some((r) => r.method === "POST"),
    JSON.stringify(received.map((r) => r.method)),
  );
  check(
    "its declarations stay put",
    (await readFile(join(outDir, "DDD-1.md"), "utf8")).includes(
      "Declared in a conflicted file",
    ),
    "removed",
  );
  check(
    "a conflicted host exits non-zero",
    process.exitCode === 1,
    `exit ${process.exitCode}`,
  );

  // Cutting by hand, the way push does when only some chunks become issues.
  const partial = "Notes.\n\n# One\n\nA.\n\n# Two\n\nB.\n";
  const partialScan = scanDeclarations(partial, {
    absPath: "/x/ideas.md",
    relPath: "all/ideas.md",
  });
  const oneLine = partialScan.declarations[0]!.line;
  const trimmed = removeDeclarations(partial, {
    absPath: "/x/ideas.md",
    relPath: "all/ideas.md",
  }, [oneLine]);
  check(
    "cutting one chunk leaves the other",
    !trimmed.includes("# One") && trimmed.includes("# Two") &&
      trimmed.includes("Notes."),
    JSON.stringify(trimmed),
  );

  // An Epic's children are not subtasks, so `fields.subtasks` never reports
  // them. This is the reported bug: the Epic's `children` stayed empty after
  // three of its children had been created.
  // The conflicted host from the check above is put back first, so this run's
  // exit code is about what is being tested here.
  await writeFile(
    join(outDir, "DDD-1.md"),
    await readFile(join(BASE_DIR, "DDD-1.md"), "utf8"),
  );
  received.length = 0;
  await writeFile(
    join(outDir, "DDD-2.md"),
    `${epicBase}\n# [Bug] A thing in the epic\n\nBody one.\n\n# An epic task [Task]\n\nBody two.\n`,
  );
  process.exitCode = 0;
  await runPush({ dryRun: false, yes: true, keys: [] });

  const epicChildren = [...store.values()].filter((i) => i.parent === "DDD-2");
  check(
    "two issues were made under the epic",
    epicChildren.length === 2,
    `${epicChildren.length}`,
  );
  check(
    "a leading marker picks the type",
    epicChildren.some((i) =>
      i.type === "Bug" && i.summary === "A thing in the epic"
    ),
    epicChildren.map((i) => `${i.summary}=${i.type}`).join(", "),
  );
  check(
    "a trailing marker picks the type",
    epicChildren.some((i) => i.type === "Task" && i.summary === "An epic task"),
    epicChildren.map((i) => `${i.summary}=${i.type}`).join(", "),
  );
  const epicRaw = await fetchIssueRaw(
    `http://127.0.0.1:${server.addr.port}`,
    "DDD-2",
  );
  check(
    "the Epic itself really reports no subtasks",
    (epicRaw.fields.subtasks ?? []).length === 0,
    JSON.stringify(epicRaw.fields.subtasks),
  );
  const epicFile = await readFile(join(outDir, "DDD-2.md"), "utf8");
  check(
    "children comes from the Parent field, not subtasks",
    epicChildren.every((c) => childrenOf_(epicFile).includes(c.key)) &&
      childrenOf_(epicFile).length === epicChildren.length,
    `${JSON.stringify(childrenOf_(epicFile))} vs ${
      epicChildren.map((c) => c.key).join(",")
    }`,
  );
  check(
    "the epic's declarations were cut out",
    !epicFile.includes("A thing in the epic") &&
      !epicFile.includes("An epic task"),
    epicFile.slice(-400),
  );

  // Editing `children` by hand: a real child is attached by writing Parent on
  // the child itself, because the subtask operation only accepts a Sub-task.
  const stray = [...store.values()].find((i) => i.key === "DDD-90");
  if (stray === undefined) {
    check("the stray child fixture exists", false, "not found");
  } else {
    stray.parent = undefined;
    // Inserted, not swapped: a removal is refused, which is the next check.
    await writeFile(
      join(outDir, "DDD-2.md"),
      withChildren(epicFile, [stray.key, ...childrenOf_(epicFile)]),
    );
    received.length = 0;
    process.exitCode = 0;
    await runPush({ dryRun: false, yes: true, keys: [] });
    const parentWrite = received.find((r) =>
      r.method === "PUT" && r.path.endsWith(stray.key)
    );
    check(
      "a real child is attached by writing its own parent",
      (parentWrite?.body as { fields?: { parent?: { key?: string } } })
        ?.fields?.parent?.key === "DDD-2",
      JSON.stringify(parentWrite?.body),
    );
    check(
      "attaching a child succeeds",
      process.exitCode === 0,
      `exit ${process.exitCode}`,
    );
    check(
      "and it is not sent as a subtask operation",
      !JSON.stringify(
        received.find((r) => r.method === "PUT" && r.path.endsWith("DDD-2"))
          ?.body ?? {},
      ).includes("subtasks"),
      "sent a subtasks op",
    );

    // Taking a real child off is not something the API can do.
    const kept = childrenOf_(await readFile(join(outDir, "DDD-2.md"), "utf8"));
    await writeFile(
      join(outDir, "DDD-2.md"),
      withChildren(
        await readFile(join(outDir, "DDD-2.md"), "utf8"),
        kept.slice(1),
      ),
    );
    received.length = 0;
    process.exitCode = 0;
    await captureLog(() => runPush({ dryRun: false, yes: true, keys: [] }));
    check(
      "removing a real child is refused",
      process.exitCode === 1,
      `exit ${process.exitCode}`,
    );
    check(
      "and nothing was written for it",
      !received.some((r) => r.method === "PUT"),
      "wrote anyway",
    );
  }

  // The title line and the front matter both carry the summary. Editing either
  // one alone has to work, because a file is not worth two edits.
  const fm = (summary: string) =>
    `---
key: T-1
summary: '${summary}'
status: To Do
statusCategory: To Do
type: Task
priority: Medium
assignee: ''
reporter: ''
labels: []
parent: ''
children: []
linked: []
created: '${CREATED}'
updated: '${UPDATED}'
url: ''
---

# ${""}`;
  const base_ = fm("Original title").replace("# ", "# T-1 Original title");
  const fileWith = (summary: string, title: string) =>
    fm(summary).replace(/# $/, `# ${title}`);
  const planWith = (summary: string, title: string) =>
    planPush(
      parseIssueFile(base_)!,
      parseIssueFile(fileWith(summary, title))!,
    );

  check(
    "editing the summary alone is enough",
    planWith("New summary", "T-1 Original title").update.fields?.["summary"] ===
      "New summary",
    JSON.stringify(planWith("New summary", "T-1 Original title").update.fields),
  );
  check(
    "editing the title alone is enough",
    planWith("Original title", "T-1 New title").update.fields?.["summary"] ===
      "New title",
    JSON.stringify(planWith("Original title", "T-1 New title").update.fields),
  );
  check(
    "editing both to the same text is fine",
    planWith("Same text", "T-1 Same text").update.fields?.["summary"] ===
        "Same text" &&
      planWith("Same text", "T-1 Same text").refusal === undefined,
    JSON.stringify(planWith("Same text", "T-1 Same text")),
  );
  check(
    "editing both to different texts is refused",
    planWith("One thing", "T-1 Another thing").refusal?.includes("not both") ===
      true,
    planWith("One thing", "T-1 Another thing").refusal,
  );
  check(
    "a title with no key still reads as the summary",
    planWith("Original title", "No key here").update.fields?.["summary"] ===
      "No key here",
    JSON.stringify(planWith("Original title", "No key here").update.fields),
  );
  check(
    "an empty title is refused rather than sending a blank summary",
    planPush(
      parseIssueFile(base_)!,
      parseIssueFile(fm("").replace(/# $/, "# T-1"))!,
    ).refusal === "the title line carries no summary text",
    "not refused",
  );
  check(
    "leaving both alone sends no summary",
    planWith("Original title", "T-1 Original title").update.fields ===
      undefined,
    JSON.stringify(planWith("Original title", "T-1 Original title").update),
  );
  check(
    "neither one-sided edit warns about the other",
    planWith("New summary", "T-1 Original title").warnings.length === 0 &&
      planWith("Original title", "T-1 New title").warnings.length === 0,
    JSON.stringify([
      planWith("New summary", "T-1 Original title").warnings,
      planWith("Original title", "T-1 New title").warnings,
    ]),
  );
} finally {
  process.chdir(cwd);
  await server.shutdown();
  await rm(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "create end-to-end checks pass"
    : `${failures} create checks fail`,
);
process.exitCode = failures === 0 ? 0 : 1;

/** Runs a command with `console.log` captured, so its output can be asserted on. */
async function captureLog(run: () => Promise<void>): Promise<string> {
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
