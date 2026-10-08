# AGENTS.md

## Commands

```sh
deno task ok                          # fmt + lint + typecheck — the only verification (no tests exist)
deno task jira-local init             # create .jira/.config.ts (--yes skips prompts; refuses if it exists)
deno task jira-local pull             # incremental pull
deno task jira-local pull --full      # full pull (also the only mode that prunes deletions)
deno task jira-local pull --dry-run   # decide but write nothing
deno task jira-local categorize       # re-categorise only (offline; pull also does this)
deno task compile                     # self-contained binary (--target to cross-compile)
```

## Constraints

- Cross-runtime only: no `Deno.*` globals, use the `node:` builtins
  (`node:fs/promises`, `node:path`, `node:process`, `node:url`) already used
  throughout, so a non-Deno runtime stays an option later. Hard filter on
  dependencies too — reject anything that unconditionally reaches for `Deno.*`
  internals, and implement small things here rather than adding a dependency for
  them. (`@std/fmt` is the known exception: it reads `globalThis.Deno?.noColor`
  opportunistically, so it degrades to plain output off-Deno.)
- `src/types/` holds types only (interfaces/type aliases), never runtime values;
  constants live in `src/constants.ts`. Split by domain: `adf.ts` (ADF
  documents), `jira-raw.ts` (raw REST payloads and credentials), `jira-local.ts`
  (converted front matter/file data, the field-name vocabulary, pipeline
  shapes), `config.ts` (the published `JiraLocalConfig`).
- The `pull`/`categorize` tasks use unscoped `--allow-write`, a legacy of the
  removed symlink-folder feature; the grants must also cover a custom `--out`.
  The code itself only ever writes inside `.jira`.
- The tool reads no environment variables. The config is a TS module, so users
  opt into env access there (`token: process.env.JIRA_API_TOKEN`). The deno
  tasks pass `--env-file` for a gitignored `.env`; the compiled binary reads
  none.

## Release

Deno 2.x, five runtime dependencies via `imports` in `deno.json`, pinned by
`deno.lock` (commit it). `init`'s generated config imports `JiraLocalConfig`
from `jsr:@jollytoad/jira-local`, so the package has to stay published for that
file to type-check.

CI is two workflows in `.github/workflows/`, both triggered by a published
release and both checking that the tag is `v` plus the `version` in `deno.json`:

- `publish.yml` — fmt/lint/check, then `deno publish` to JSR.
- `release.yml` — `deno compile -P` for four targets (`aarch64-apple-darwin`,
  `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`,
  `aarch64-unknown-linux-gnu`, permissions from `compile.permissions`), uploads
  each as `jira-local-v<version>-<target>.tar.gz`, then regenerates
  `Formula/cli.rb` with the new version and SHA256s and commits it to `main` as
  `github-actions[bot]`. That bot push needs the tag to point at current `main`.

To release: bump `version` in `deno.json`, then create a GitHub release tagged
`v<version>`.

## Gotchas

- Cliffy lazy commands: register with `.command("pull", () => import("…"))` and
  have each command module **default-export its `Command`**. A module exporting
  only a factory fails to type-check next to a `no-` prefixed global option.
- Cliffy renders help _before_ option actions fire, so `--no-color` can never
  reach it — help follows `NO_COLOR` and the tty check. Task-line precedence is
  `NO_COLOR` (enforced inside `@std/fmt`, which refuses to re-enable) >
  `--no-color` > `FORCE_COLOR`/`TERM=dumb`/tty. Help inherits that state because
  cliffy 1.3 reads the same `@std/fmt/colors` state.
- Option actions fire _during_ the parse, which is the only way `--verbose`
  reaches `progress()` before the subcommand's own action runs.

## Layout

`src/cli.ts` builds the cliffy `Command` (`jira-local` with `pull`, `categorize`
and `init`), parses it and maps runtime errors to exit codes. Pipeline:
`jira.ts` (REST v3, streaming pages with lookahead) → `adf-to-markdown.ts` →
`render.ts` → `pull.ts` (mirror issues to disk) → `commands/`; watermark in
`state.ts`, config in `config.ts`, progress in `progress.ts` + `style.ts`,
errors in `errors.ts`.

- Each command lives in `src/commands/<name>.ts` with its orchestration
  (`runPull`/`runCategorize`) beside the definition.
- `.jira/.config.ts` (sibling of `issues/`, gitignored, `export const config`):
  connection fields `site`/`project`/`email`/`token` (used by pull, ignored by
  categorize, validated as non-empty strings, resolving with precedence flags >
  config) plus the optional `categoryIndex` map (category → columns, an
  allowlist: omitted categories get no index; omit the whole field for index
  pages everywhere with the default columns). Keys and columns must be
  front-matter field names, enforced at type-check and runtime. Missing file =
  defaults, which then makes a missing site/project a hard error.
- Categories: `categorize.ts` holds the only `categorizeIssue` function (front
  matter + body → category strings, `/` nests); `categories.ts` reconciles those
  into index pages next to `all/` (`status/<status>.md`, plus `assignee/`,
  `labels/`, `parent/<key>`; unassigned → `assignee/Unassigned`; status category
  "Done" is status-only). Category names mirror the front-matter field they
  derive from. Every non-hidden directory under `.jira/issues/` other than
  `all/` is managed, so stale index pages are cleaned up automatically. Symlink
  category folders are a removed feature: leftovers are ignored, and deleting
  `.jira/` is the supported way to clear them.
- Index pages: `category-indexes.ts` renders one markdown table per leaf
  category; columns come from `categoryIndex` (default `DEFAULT_INDEX_COLUMNS` =
  `["key", "summary"]`, `key` linking into `all/`), rows sorted by key. Written
  only when content differs, removed when the category goes stale or loses its
  index entry.
- `.jira/` is gitignored generated output and safe to delete; deleting
  `.jira/.state.json` forces a full pull.
- The mirror is one-way (Jira → disk): local edits to `.jira/issues/all/*.md`
  are overwritten on the next pull, and nothing is ever written to Jira. Pruning
  happens only on `--full`, since an incremental run cannot know what it didn't
  fetch.
- Incremental pull keys off Jira's `updated` timestamps (account timezone), not
  the local clock, with a one-minute overlap because JQL has no seconds.
