# AGENTS.md

## Commands

```sh
deno task ok                          # sh -n installer + fmt + lint + typecheck + src/tools checks + publish dry run
deno task version                     # regenerate src/version.ts from deno.json (CI fails a release that forgets)
deno task jira-local init             # create .jira/.config.ts (--yes skips prompts; refuses if it exists)
deno task jira-local pull             # incremental pull
deno task jira-local pull --full      # full pull (also the only mode that prunes deletions)
deno task jira-local pull --dry-run   # decide but write nothing
deno task jira-local status           # report local edits, conflicts, missing bases, declarations (offline)
deno task jira-local push --dry-run   # report what would go to Jira, write nothing
deno task jira-local push             # send local edits back, create declared issues
deno task jira-local categorize       # re-categorise only (offline; pull also does this)
deno task compile                     # self-contained binary (--target to cross-compile)
```

## Comments

Write few comments, and only when the code leaves a decision unexplained.
Explain why, never what: if a name already says what something is, add nothing.
Leave out a restatement of the code, a function's own parameters, and any note
that something was removed. Worth keeping: an external quirk you had to work
around, a limit that forced the shape of the code, and an assumption a later
edit could break by accident.

## Constraints

- Cross-runtime only: no `Deno.*` globals, use the `node:` builtins
  (`node:fs/promises`, `node:path`, `node:process`, `node:url`,
  `node:child_process`) already used throughout, so a non-Deno runtime stays an
  option later. Hard filter on dependencies too — reject anything that
  unconditionally reaches for `Deno.*` internals, and implement small things
  here rather than adding a dependency for them. (`@std/fmt` is the known
  exception: it reads `globalThis.Deno?.noColor` opportunistically, so it
  degrades to plain output off-Deno.)
- `--allow-run` is unscoped, because the only subprocess is `git merge-file` and
  a scoped `--allow-run=git` makes the CLI refuse to start at all when git is
  absent — taking `categorize`, which needs no git, down with it. The merge
  reports the missing binary itself instead.
- `src/types/` holds types only (interfaces/type aliases), never runtime values;
  constants live in `src/constants.ts`. Split by domain: `adf.ts` (ADF
  documents), `jira-raw.ts` (raw REST payloads and credentials), `jira-local.ts`
  (converted front matter/file data, the field-name vocabulary, pipeline
  shapes), `config.ts` (the published `JiraLocalConfig`).
- The `pull`/`categorize` tasks use unscoped `--allow-write`, a legacy of the
  removed symlink-folder feature. The code itself only ever writes inside
  `.jira/`, at the fixed paths in `constants.ts` (`JIRA_DIR`, `ISSUES_DIR`).
- The tool reads no environment variables. The config is a TS module, so users
  opt into env access there (`token: process.env.JIRA_API_TOKEN`). The deno
  tasks pass `--env-file` for a gitignored `.env`; the compiled binary reads
  none. The single exception is `upgrade`, where cliffy's GithubProvider picks
  up `GH_TOKEN`/`GITHUB_TOKEN` to lift GitHub's anonymous API rate limit.

## Release

Deno 2.x, six runtime dependencies via `imports` in `deno.json`, pinned by
`deno.lock` (commit it). `git` must be on `PATH` for the merge (the tool says so
plainly if it is not). `init`'s generated config imports `JiraLocalConfig` from
`jsr:@jollytoad/jira-local`, so the package has to stay published for that file
to type-check.

`src/version.ts` is generated from `deno.json` by `tools/write-version.ts`
(`deno task version`, which `compile` and both workflows run), because Deno 2.x
has no `--define` and JSR's `<pkg>/version` module does not resolve. It is
committed, and `git diff --exit-code src/version.ts` is what stops a release
that bumps `deno.json` without regenerating it.

CI is two workflows in `.github/workflows/`, both triggered by a published
release and both checking that the tag is `v` plus the `version` in `deno.json`:

- `publish.yml` — version drift, `sh -n install.sh`, fmt/lint/check, then
  `deno publish` to JSR.
- `release.yml` — version drift, then `deno compile -P` for four targets
  (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`,
  `aarch64-unknown-linux-gnu`, permissions from `compile.permissions`), uploads
  each as `jira-local-v<version>-<target>.tar.gz` plus a
  `jira-local-v<version>-checksums.txt` for `install.sh` and `upgrade` to
  verify, then regenerates `Formula/cli.rb` from that same checksums file and
  commits it to `main` as `github-actions[bot]`. That bot push needs the tag to
  point at current `main`.

To release: bump `version` in `deno.json`, run `deno task version`, then create
a GitHub release tagged `v<version>`.

## Gotchas

- Cliffy lazy commands: register with `.command("pull", () => import("…"))` and
  have each command module **default-export its `Command`**. A module exporting
  only a factory fails to type-check next to a `no-` prefixed global option.
- `upgrade` is cliffy's `UpgradeCommand`, so it owns its own flags: its `-v` is
  cliffy's verbose logging, not ours, and it calls `.noGlobals()` — so
  `jira-local --verbose upgrade` works (ours, handled by the parent) while
  `jira-local upgrade --verbose` is cliffy's. Releases are tagged `v<version>`
  but the cli reports the bare version, which is what `ReleaseProvider` in
  `commands/upgrade.ts` bridges in both directions. Its spinner is off because
  cliffy's ignores the colour gate in `style.ts`.
- `upgrade` replaces the running executable, so cliffy's `isStandalone()` is the
  only thing keeping a script install from overwriting the `deno` binary; the
  provider's `upgrade()` override turns that case into a message instead of
  letting cliffy shell out to the runtime.
- Cliffy renders help _before_ option actions fire, so `--no-color` can never
  reach it — help follows `NO_COLOR` and the tty check. Task-line precedence is
  `NO_COLOR` (enforced inside `@std/fmt`, which refuses to re-enable) >
  `--no-color` > `FORCE_COLOR`/`TERM=dumb`/tty. Help inherits that state because
  cliffy 1.3 reads the same `@std/fmt/colors` state.
- Option actions fire _during_ the parse, which is the only way `--verbose`
  reaches `progress()` before the subcommand's own action runs.
- Never hard link a base file to an issue file. An editor that writes in place
  rewrites the merge base, so the next merge loses its ancestor and returns
  wrong results with no error. `base.ts` clones with `COPYFILE_FICLONE` instead,
  which shares blocks and never shares an inode.
- Cliffy argument definitions are split on spaces, so `.arguments()` takes the
  bare `[keys...:string]` and the description goes in a separate `.example()`
  call. Passing `"[keys...:string] Issue keys to push."` throws while parsing
  its own help.
- Jira reports `operations: ["set"]` for `parent` and no `remove`, checked
  against an issue that really does have a parent. Clearing one through the API
  is not permitted, so `push-plan.ts` refuses a blanked `parent` instead of
  sending a request that can only earn an error nobody can satisfy.
- `issuetype` reports `operations: []` on edit, which says nothing either way,
  but a type change does work in practice: TEST-18 went `Story` → `Task` through
  `PUT /issue/{key}` on a live instance. Do not read the empty operations array
  as a prohibition.

## Layout

`src/cli.ts` builds the cliffy `Command` (`jira-local` with `pull`, `push`,
`status`, `categorize`, `init` and `upgrade`), parses it and maps runtime errors
to exit codes. Pull pipeline: `jira.ts` (REST v3, streaming pages with
lookahead) → `adf-to-markdown.ts` → `render.ts` → `merge.ts` → `mirror.ts`
(write issues to disk) → `commands/`. Push runs the other way:
`commands/push.ts` → `issue-file.ts` → `push-plan.ts` → `markdown-to-adf.ts` →
`jira.ts`, and for new issues `declarations.ts` → `create.ts` → `jira.ts`.
Watermark in `state.ts`, merge base in `base.ts`, config in `config.ts`,
progress in `progress.ts` + `style.ts`, errors in `errors.ts`.

- Each command lives in `src/commands/<name>.ts` with its orchestration
  (`runPull`/`runPush`/`runCategorize`) beside the definition.
- `src/tools/` holds development aids, not tests: `merge-check.ts` drives the
  merge engine through its cases plus a real file, `pull-e2e.ts` drives the
  whole write path over a scratch project, `push-e2e.ts` drives `runPush`
  against a fake Jira over real HTTP, `create-e2e.ts` does the same for
  declaring and creating issues, and `md-roundtrip.ts` checks the markdown
  subset against every description in the mirror. All five run as part of
  `deno task ok`. Only `push-e2e.ts` and `create-e2e.ts` exercise response
  parsing, so a change to the shape of a Jira reply needs those two rerun.
  `md-roundtrip` reports refusals as counts rather than failures, because a
  construct outside the subset is the designed outcome; it checks that no _text_
  is lost, not that the tree is identical, because `adf-to-markdown.ts`
  normalises whitespace and merges paragraphs in a list item.
- `install.sh` is the only shell in the repo: POSIX `sh`, no bashisms, `curl` +
  `tar` + a sha256 tool only. It resolves "latest" by following the
  `releases/latest` redirect rather than the GitHub api, so it needs no token
  and cannot hit the anonymous rate limit. `sh -n install.sh` is part of
  `deno task ok`.
- Disk is the only source of truth for categorisation. `mirror.ts` keeps just a
  SHA-256 per issue file to detect changes, `base.ts` holds the last synced
  _content_ per issue as the merge base, and `categories.ts` reads each issue's
  front matter itself, so an index page can never be built from a pre-pull
  snapshot.
- `configPath()`, `statePath()` and `getConfig()` take no directory: everything
  is anchored to `process.cwd()` plus `JIRA_DIR`. `getConfig()` stays cached per
  path.
- `.jira/.config.ts` (gitignored, `export const config`): connection fields
  `site`/`project`/`email`/`token` (used by pull, ignored by categorize,
  validated as non-empty strings, resolving with precedence flags > config) plus
  the optional `categoryIndex` map (category → columns, an allowlist: omitted
  categories get no index; omit the whole field for index pages everywhere with
  the default columns), and the optional `defaultIssueType` / `newIssueLinkType`
  used when declaring issues. Keys and columns must be front-matter field names,
  enforced at type-check and runtime. Missing file = defaults, which then makes
  a missing site/project a hard error.
- Categories: `categorize.ts` holds the only `categorizeIssue` function (front
  matter + body → category strings, `/` nests); `categories.ts` reconciles those
  into index pages next to `all/` (`status/<status>.md`, plus `assignee/`,
  `labels/`, `parent/<key>`; unassigned → `assignee/Unassigned`; status category
  "Done" is status-only). Category names mirror the front-matter field they
  derive from. Every non-hidden directory under `.jira/issues/` other than
  `all/` is managed, so stale index pages are cleaned up automatically; `new/`
  is the one exception, skipped by name in `scanManagedCategories`, because it
  holds declarations rather than a category. Symlink category folders are a
  removed feature: leftovers are ignored, and deleting `.jira/` is the supported
  way to clear them.
- Index pages: `category-indexes.ts` renders one markdown table per leaf
  category; columns come from `categoryIndex` (default `DEFAULT_INDEX_COLUMNS` =
  `["key", "summary"]`, `key` linking into `all/`), rows sorted by key. Written
  only when content differs, removed when the category goes stale or loses its
  index entry. A pull that wrote and pruned nothing skips reconciliation
  entirely — the pages cannot have changed.
- `.jira/` is gitignored generated output and safe to delete; deleting
  `.jira/.state.json` forces a full pull.
- Write-back: `.jira/.base/<KEY>.md` is the merge base (the last version Jira
  held, never the merged result — otherwise every later Jira change conflicts
  with itself). The base is created by reflink and every issue file and base is
  written temp-then-`rename`, because the temp must be a sibling to make
  `rename` atomic. `merge.ts` shells out to
  `git merge-file --diff3 -p -L local -L base -L jira`, so a conflict is the
  shape every merge tool and agent already reads; five fast paths in
  `mergeIssueFile` mean only a genuine three-way case reaches the subprocess.
  `pull --no-merge` restores the old overwrite behaviour.
- Timestamps are stored exactly as Jira sends them, via `jiraTimestamp()`. Never
  widen or narrow one: a field Jira reports as a bare date stays a bare date,
  and one it reports to the millisecond keeps it. `created`, `updated` and each
  comment heading all go through it. This is what makes push's lease check
  possible — it compares `updated` against the value it is about to write, and a
  date cannot tell two syncs on the same day apart. `util.ts` has no
  date-truncating helper for this reason; do not add one back.
- The push lease is the base file's own `updated` front matter. There is no
  separate lease file, so the sync state a reader sees in the file is the state
  the check uses, and deleting anything cannot silently disable the check.
- Push reads only what changed against the base, so an untouched description
  never reaches the lossy `markdown-to-adf.ts`; that module throws naming the
  construct rather than degrade a Jira issue, and refuses tables, images,
  attachments and raw HTML outright. Comments are read-only except for text
  appended below the last one, which posts as one new comment. `assignee` and
  `linked` are read-only because the render drops what writing them needs.
  Writable fields are `summary`, `labels`, `priority`, `parent`, `status`,
  `type`, `children` and the description. `parent` is writable but not
  clearable. The lease check refuses an issue whose `updated` moved since the
  base was taken. `push --dry-run` performs every read and conversion, writes
  nothing, and exits 1 if any issue would be refused.
- A summary appears twice in a file: the front matter and the `# KEY summary`
  line. Editing either one alone changes the summary — whichever moved against
  the base wins, and the refresh afterwards rewrites the other, so the file
  settles on one answer with nothing to reconcile by hand. Only a file where
  both moved to _different_ texts is refused, since nothing says which one was
  meant; an earlier version warned about every disagreement instead, which just
  told people to edit a second line. `titleSummary()` reads the summary out of
  the title, treating a title with no key in it as the summary on its own.
- Two fields reach the API as an id rather than the name in the file, because
  the name is not unique enough: `children`, because `update.subtasks` is keyed
  by numeric id, and `type`, because a type name is only unique within a
  project. `push-plan.ts` records the name and leaves resolution to the command,
  which is where the I/O lives. `type` resolves against `GET /project/{key}` and
  its `issueTypes`, fetched once per push because the answer is the same for
  every issue. Neither is guessed at: a name that does not resolve refuses that
  issue and lists what is available.
- The mirror is two-way but only on demand: pull merges Jira into disk, push
  sends local edits back, and nothing reaches Jira without a `push`. Pruning
  happens only on `--full`, since an incremental run cannot know what it didn't
  fetch.
- Declaring a new issue: a top-level heading, in a file in `.jira/issues/new/`,
  in a loose file beside `all/`, or in an issue file that already exists. The
  first heading of an issue file is that issue's own title, so only later ones
  declare; in every other file all of them do. `declarations.ts` is pure and
  returns both the chunks and the file with them cut out — `status` compares
  that stripped text against the base, and `push` diffs it, so declaring an
  issue inside another one is never mistaken for an edit to its host. The cut
  has to keep the front matter and the trailing newline byte for byte, or every
  untouched issue would look edited. Text before a declaration is never touched:
  a loose file that still holds notes survives, and only one left with nothing
  but whitespace is deleted. Fenced code is skipped, so a `# comment` in a shell
  sample declares nothing — but a description that genuinely contains an h1
  renders as `# text` and _will_ be read as a declaration, which is the cost of
  using an ordinary heading as the marker. There is no duplicate guard: a crash
  between creating an issue and cutting its declaration leaves the text in place
  and a second push would create it again.
- A heading's `[Type]` marker is read at either end — `# [Bug] the title` as
  readily as `# the title [Bug]` — and stripped only when it matches a name from
  `GET /project/{key}`. So `# Cache it [urgent]` keeps its brackets, and a
  bracketed word with no whitespace inside the brackets, as in `# see [1]` or
  `# array[0]`, is never read as a type. `status` is offline and cannot check,
  so it shows the marker as `[urgent] unverified`. `defaultIssueType` (built-in
  `Task`) supplies the type when the heading names none — not the host's type,
  because on the link fallback that would make a child of an Epic a second Epic.
- Child first, link second: the create sends `parent`, and a 4xx whose body
  mentions `parent` is retried with the relationship turned into an issue link
  of type `newIssueLinkType` (built-in `Relates To`), new issue as the inward
  end. `isParentRefusal` reads Jira's error prose because there is no field for
  it — if Atlassian reword it the fallback stops firing and the declaration
  stays put, which is the safe direction. Asking first does not work:
  `createmeta` gives `hierarchyLevel`, which separates `Sub-task` from the rest
  but knows nothing about a classic project letting only an Epic hold children.
  `[Sub-task]` is the one case neither path satisfies — Jira will not create a
  subtask with no parent — so it is reported once, naming both halves, rather
  than as two failures. A conflicted host declares nothing that may be created.
- `children` means the issues whose **Parent** is this one, which is not what
  `fields.subtasks` reports: that field holds Sub-task children only, so an
  Epic's Story/Task/Bug children are invisible in it. On the TEST project
  `subtasks` on the Epic came back empty with four issues naming it as parent.
  `fetchChildMap` asks for the Parent field instead, one narrow paginated query
  per pull and once per push, and the renderer unions it with `subtasks` so a
  Sub-task still shows if the query ever missed one. `children` is sorted, so
  the file does not churn when Jira answers in another order. Writing it
  therefore has two shapes: a Sub-task goes through `update.subtasks`, keyed by
  numeric id as before, and any other child is attached by writing Parent on the
  child itself, which is a separate request to a different issue. Taking a
  non-Sub-task child off is refused, the same limit as clearing a parent by
  hand.
- After a write, a host is re-read so its `children` or `linked` is current, but
  only when its own edits went out or it had none: re-reading a host whose edits
  are still unsent would throw them away. Declarations that were not created are
  put back on the end afterwards, so re-reading never drops text. The base is
  always the bare Jira render, never the file with declarations on it.
- A `.md` file in `all/` whose name is issue-key shaped is never a declaration —
  an issue key cannot be chosen — so if Jira does not know that key the file is
  reported and nothing is written.
- Incremental pull keys off Jira's `updated` timestamps (account timezone), not
  the local clock, with a one-minute overlap because JQL has no seconds.
