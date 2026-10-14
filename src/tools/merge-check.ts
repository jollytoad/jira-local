/**
 * Exercises the merge engine against synthetic copies of real issue files.
 *
 * Runs entirely inside a scratch directory under `.tmp/`, so the real mirror is
 * never touched. Run it with:
 *
 *   deno run --allow-read --allow-write --allow-run --allow-env \
 *     src/tools/merge-check.ts
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { hasConflictMarkers, mergeIssueFile } from "../merge.ts";
import { TEMP_DIR } from "../constants.ts";

// Under the project's own scratch dir, not the OS temp, so the check needs no
// extra permission and leaves nothing behind on a clean run.
const dir = await mkdtemp(join(process.cwd(), TEMP_DIR, "merge-check-"));
let failures = 0;

interface Case {
  name: string;
  base: string | undefined;
  local: string | undefined;
  jira: string;
  /** The merged text, or a pattern when the outcome varies. */
  expect?: string | RegExp;
  conflicted?: boolean;
}

const CASES: Case[] = [
  {
    name: "no base: Jira wins",
    base: undefined,
    local: "ours\n",
    jira: "theirs\n",
    expect: "theirs\n",
  },
  {
    name: "no local file: Jira wins",
    base: "base\n",
    local: undefined,
    jira: "theirs\n",
    expect: "theirs\n",
  },
  {
    name: "unchanged locally: Jira wins",
    base: "a\nb\n",
    local: "a\nb\n",
    jira: "a\nb\nc\n",
    expect: "a\nb\nc\n",
  },
  {
    name: "Jira unchanged: local edit kept",
    base: "a\nb\n",
    local: "a\nB\n",
    jira: "a\nb\n",
    expect: "a\nB\n",
  },
  {
    name: "identical on both sides",
    base: "a\n",
    local: "b\n",
    jira: "b\n",
    expect: "b\n",
  },
  {
    name: "disjoint edits merge cleanly",
    base: "one\ntwo\nthree\n",
    local: "ONE\ntwo\nthree\n",
    jira: "one\ntwo\nTHREE\n",
    expect: "ONE\ntwo\nTHREE\n",
  },
  {
    name: "overlapping edits conflict with diff3",
    base: "one\ntwo\nthree\n",
    local: "one\nTWO(local)\nthree\n",
    jira: "one\nTWO(jira)\nthree\n",
    expect:
      "one\n<<<<<<< local\nTWO(local)\n||||||| base\ntwo\n=======\nTWO(jira)\n>>>>>>> jira\nthree\n",
    conflicted: true,
  },
  {
    name: "both append at the same spot",
    base: "a\n",
    local: "a\nb\n",
    jira: "a\nc\n",
    conflicted: true,
    expect: /<<<<<<< local/,
  },
  {
    name: "file is empty on both sides",
    base: "",
    local: "",
    jira: "new\n",
    expect: "new\n",
  },
];

for (const testCase of CASES) {
  const localPath = join(dir, `${slug(testCase.name)}.local.md`);
  const basePath = join(dir, `${slug(testCase.name)}.base.md`);
  await writeFile(localPath, testCase.local ?? "");
  await writeFile(basePath, testCase.base ?? "");

  const result = await mergeIssueFile({
    localText: testCase.local,
    baseText: testCase.base,
    jiraText: testCase.jira,
    localPath,
    basePath,
  });

  const ok = expected(testCase, result.text, result.conflicted);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${testCase.name}`);
    console.log(`  got  ${JSON.stringify(result.text)}`);
    console.log(`  conflicted=${result.conflicted}`);
  }
}

// A real file, edited on both sides the way an editor would.
const real = await readFile(
  join(process.cwd(), ".jira", "issues", "all", "SRFR-1.md"),
  "utf8",
)
  .catch(() => undefined);
if (real !== undefined) {
  const edited = real.replace(
    "Ability to set the commit based on ref",
    "Ability to set the commit based on the ref",
  );
  const jiraMoved = real.replace(
    "## Comments",
    "## Notes\n\nA new section added in Jira.\n\n## Comments",
  );
  const basePath = join(dir, "real.base.md");
  const localPath = join(dir, "real.local.md");
  await writeFile(basePath, real);
  await writeFile(localPath, edited);

  const clean = await mergeIssueFile({
    localText: edited,
    baseText: real,
    jiraText: jiraMoved,
    localPath,
    basePath,
  });
  if (
    !clean.text.includes("based on the ref") || !clean.text.includes("## Notes")
  ) {
    failures++;
    console.log("FAIL  real file: both edits should survive");
    console.log(clean.text);
  }
  if (clean.conflicted) {
    failures++;
    console.log("FAIL  real file: disjoint edits should not conflict");
  }

  // The same, but both sides touching the description, which must conflict.
  const bothEdited = jiraMoved.replace(
    "Ability to set the commit based on ref",
    "Ability to set the commit based on a branch or tag",
  );
  const clashing = await mergeIssueFile({
    localText: edited,
    baseText: real,
    jiraText: bothEdited,
    localPath,
    basePath,
  });
  if (!clashing.conflicted) {
    failures++;
    console.log(
      "FAIL  real file: the same sentence edited twice must conflict",
    );
  }
  if (!clashing.text.includes("||||||| base")) {
    failures++;
    console.log("FAIL  real file: the conflict must carry the base section");
  }
}

function expected(testCase: Case, text: string, conflicted: boolean): boolean {
  if (testCase.conflicted !== undefined && testCase.conflicted !== conflicted) {
    return false;
  }
  if (testCase.conflicted === true && !hasConflictMarkers(text)) return false;
  if (testCase.conflicted === false && hasConflictMarkers(text)) return false;
  if (testCase.expect === undefined) return true;
  return typeof testCase.expect === "string"
    ? text === testCase.expect
    : testCase.expect.test(text);
}

function slug(name: string): string {
  return name.replace(/[^a-z]+/gi, "-").toLowerCase();
}

await rm(dir, { recursive: true, force: true });

console.log(
  failures === 0
    ? `${CASES.length} merge cases pass`
    : `${failures} merge cases fail`,
);
process.exitCode = failures === 0 ? 0 : 1;
