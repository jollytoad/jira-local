/**
 * End-to-end check of pull's merge, without a network.
 *
 * Drives `pullIssue` over a scratch project so the whole write path runs: base
 * creation, the merge, the conflict shape, the dry run and `--no-merge`. The
 * scratch directory becomes the cwd first, because `base.ts` anchors itself to
 * `process.cwd()` exactly as it does in a real repository.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-run \
 *     src/tools/pull-e2e.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { pullIssue, scanLocal } from "../mirror.ts";
import { contentToPulledIssue, jiraIssueToContent } from "../render.ts";
import { mergeIssueFile } from "../merge.ts";
import { readBase } from "../base.ts";
import { BASE_DIR, ISSUES_DIR } from "../constants.ts";
import type { JiraIssue } from "../types/jira-raw.ts";

const SITE = "https://fake.atlassian.net";

const cwd = process.cwd();
const dir = await mkdtemp(join(cwd, ".tmp", "pull-e2e-"));
await mkdir(join(dir, ".jira", "issues", "all"), { recursive: true });
process.chdir(dir);

const outDir = join(process.cwd(), ISSUES_DIR);
const opts = { merge: true, dryRun: false };

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok   " : "FAIL "} ${name}${ok ? "" : `: ${detail}`}`);
  if (!ok) failures++;
};

const doc = (paragraphs: string[]) => ({
  version: 1,
  type: "doc",
  content: paragraphs.map((line) => ({
    type: "paragraph",
    content: [{ type: "text", text: line }],
  })),
});

function issue(
  key: string,
  summary: string,
  body: string[],
  updated: string,
): JiraIssue {
  return {
    key,
    fields: {
      summary,
      status: { name: "To Do", statusCategory: { name: "To Do" } },
      issuetype: { name: "Task" },
      parent: null,
      subtasks: [],
      issuelinks: [],
      priority: { name: "Medium" },
      assignee: null,
      reporter: null,
      labels: [],
      created: "2025-01-01T00:00:00.000+0000",
      updated,
      description: doc(body),
      comment: { total: 0, comments: [] },
    },
  };
}

const render = (
  key: string,
  summary: string,
  body: string[],
  updated: string,
) =>
  contentToPulledIssue(
    jiraIssueToContent(issue(key, summary, body, updated), SITE),
  );

try {
  // A first pull writes two issues and a base for each.
  const first = render(
    "AAA-1",
    "First issue",
    ["Original text."],
    "2025-01-01T10:00:00.000+0000",
  );
  const second = render(
    "AAA-2",
    "Second issue",
    ["Another body."],
    "2025-01-01T10:00:00.000+0000",
  );
  check(
    "first pull creates",
    (await pullIssue(first, await scanLocal(outDir, "AAA"), outDir, opts)) ===
      "create",
  );
  check(
    "second pull creates",
    (await pullIssue(second, await scanLocal(outDir, "AAA"), outDir, opts)) ===
      "create",
  );

  check("a base exists", (await readBase("AAA-1")) !== undefined);
  check(
    "the base is the rendered file",
    (await readBase("AAA-1")) === first.markdown,
  );

  // Jira grows the description, and a pull brings that in.
  const three = render("AAA-1", "First issue", [
    "Original text.",
    "Middle.",
    "Last.",
  ], "2025-01-01T12:00:00.000+0000");
  await pullIssue(three, await scanLocal(outDir, "AAA"), outDir, opts);
  const path = join(outDir, "AAA-1.md");

  // Edit a file locally, the way an editor would.
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "Original text.",
      "Text I edited locally.",
    ),
  );

  // Jira edits a different paragraph. Line-granularity merging keeps both.
  const changed = render("AAA-1", "First issue", [
    "Original text.",
    "Middle.",
    "Last, from Jira.",
  ], "2025-01-02T10:00:00.000+0000");
  const action = await pullIssue(
    changed,
    await scanLocal(outDir, "AAA"),
    outDir,
    opts,
  );
  const after = await readFile(path, "utf8");

  check(
    "the local edit survived",
    after.includes("Text I edited locally."),
    "lost",
  );
  check(
    "the Jira change arrived",
    after.includes("Last, from Jira."),
    "missing",
  );
  check("no conflict markers", !after.includes("<<<<<<<"), "present");
  check("the action was an update", action === "update", `got ${action}`);
  check(
    "the base is Jira's version",
    (await readBase("AAA-1")) === changed.markdown,
  );
  check(
    "the base holds no local edit",
    !(await readBase("AAA-1"))?.includes("Text I edited locally."),
  );

  // A conflict: both sides rewrite the same paragraph.
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "Text I edited locally.",
      "My version.",
    ),
  );
  const clashing = render("AAA-1", "First issue", [
    "Their version.",
    "Middle.",
    "Last, from Jira.",
  ], "2025-01-03T10:00:00.000+0000");
  const conflicted = await pullIssue(
    clashing,
    await scanLocal(outDir, "AAA"),
    outDir,
    opts,
  );
  const marked = await readFile(path, "utf8");

  check(
    "a clash reports a conflict",
    conflicted === "conflict",
    `got ${conflicted}`,
  );
  check("markers are present", marked.includes("<<<<<<< local"), "absent");
  check(
    "the diff3 base section is kept",
    marked.includes("||||||| base"),
    "absent",
  );
  check("both sides are labelled", marked.includes(">>>>>>> jira"), "absent");
  check(
    "the base still became Jira's version",
    (await readBase("AAA-1")) === clashing.markdown,
  );

  // Resolving the conflict is a file edit: drop the markers, keep one version.
  const resolvedText = marked
    .replace(
      /^<<<<<<< local\n[\s\S]*?^\|\|\|\|\|\|\| base\n[\s\S]*?^=======\n[\s\S]*?^>>>>>>> jira$/m,
      "My version.\n",
    )
    .trimEnd() + "\n";
  await writeFile(path, resolvedText);
  const settled = await readFile(path, "utf8");
  check(
    "no markers survive the manual resolve",
    !/^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/m.test(settled),
    JSON.stringify(settled),
  );

  // Jira has not moved, so the pull must keep the resolved text. Only the
  // `updated` stamp in the front matter differs, which is not a conflict.
  const resolved = render("AAA-1", "First issue", [
    "Their version.",
    "Middle.",
    "Last, from Jira.",
  ], "2025-01-04T10:00:00.000+0000");
  await pullIssue(resolved, await scanLocal(outDir, "AAA"), outDir, opts);
  const settledAgain = await readFile(path, "utf8");
  check(
    "the resolved edit survived the next pull",
    settledAgain.includes("My version."),
    "lost",
  );
  check(
    "no markers after the next pull",
    !/^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/m.test(settledAgain),
    "present",
  );
  check(
    "Jira's untouched paragraph survived",
    settledAgain.includes("Middle."),
    "lost",
  );

  // `--dry-run` must not touch disk.
  await writeFile(join(outDir, "AAA-2.md"), "local change\n");
  const planned = render(
    "AAA-2",
    "Second issue",
    ["Another body."],
    "2025-01-05T10:00:00.000+0000",
  );
  await pullIssue(planned, await scanLocal(outDir, "AAA"), outDir, {
    merge: true,
    dryRun: true,
  });
  check(
    "--dry-run writes nothing",
    (await readFile(join(outDir, "AAA-2.md"), "utf8")) === "local change\n",
  );

  // `--no-merge` overwrites, which is the documented escape hatch.
  await pullIssue(planned, await scanLocal(outDir, "AAA"), outDir, {
    merge: false,
    dryRun: false,
  });
  check(
    "--no-merge overwrites",
    (await readFile(join(outDir, "AAA-2.md"), "utf8")) !== "local change\n",
  );

  // A missing base means Jira wins: there is no ancestor to merge against.
  await rm(join(dir, BASE_DIR, "AAA-2.md"));
  await writeFile(join(outDir, "AAA-2.md"), "orphan edit\n");
  await pullIssue(planned, await scanLocal(outDir, "AAA"), outDir, opts);
  check(
    "no base means Jira wins",
    !(await readFile(join(outDir, "AAA-2.md"), "utf8")).includes("orphan edit"),
  );

  // The merge itself, isolated from the write path.
  const scratch = join(dir, "scratch.md");
  await writeFile(scratch, "a\nb\n");
  const isolated = await mergeIssueFile({
    localText: "a\nb\n",
    baseText: "a\nb\n",
    jiraText: "a\nb\n",
    localPath: scratch,
    basePath: join(dir, "no-such-base.md"),
  });
  check(
    "a no-op merge never needs the base on disk",
    isolated.changed === false,
  );
} finally {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "pull end-to-end checks pass"
    : `${failures} pull checks fail`,
);
process.exitCode = failures === 0 ? 0 : 1;
