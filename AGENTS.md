# AGENTS.md

## Commands

```sh
deno task ok                          # fmt + lint + typecheck — the only verification (no tests exist)
deno task jira-local init             # create .jira/.config.ts interactively (--yes skips prompts; refuses if it exists)
deno task jira-local pull             # incremental pull
deno task jira-local pull --full      # full pull (also the only mode that prunes deletions)
deno task jira-local pull --dry-run   # decide but write nothing
deno task jira-local categorize       # re-categorise only (offline; pull also does this)
```

- Bare invocation shows help.

- Deno 2.x, four runtime dependencies (`@cliffy/command` for the CLI and
  `@cliffy/prompt` for init's interactive prompts, `@std/front-matter`,
  `@std/yaml` via `imports` in `deno.json`, pinned by `deno.lock` — commit it).
  `deno task ok` is the full check; CI is two workflows in `.github/workflows/`
  (both `on: release: types: [published]`, and both verify the tag is `v` +
  `version` from `deno.json`): `publish.yml` fmt/lint/checks then `deno publish`
  to JSR, `release.yml` compiles a single `aarch64-apple-darwin` binary via
  `deno compile -P` (permissions from `compile.permissions` in `deno.json`) and
  uploads it to the release that triggered the run. To release, bump `version`
  in `deno.json`, then create/publish a GitHub release tagged `v<version>`.
- `src/types/` hold types only (interfaces/type aliases) — never runtime values.
  Constants live in `src/constants.ts`. Types are split by domain:
  `types/adf.ts` (ADF documents), `types/jira-raw.ts` (raw Jira REST payloads
  and credentials), `types/jira-local.ts` (converted front matter/file data, the
  field-name vocabulary, and pull-pipeline shapes: rendered issue, local file
  records, counters, state), and `types/config.ts` (the `JiraLocalConfig` user
  config).
- The `pull`/`categorize` tasks use unscoped `--allow-write` because Deno
  refuses `symlink()` under path-scoped grants. The code itself only writes
  inside `.jira`.

## CLI

- `src/cli.ts` builds the cliffy `Command` (`jira-local` with `pull`,
  `categorize` and `init` subcommands), parses it and maps runtime errors to
  exit codes; each command lives in `src/commands/<name>.ts` with its
  orchestration (`runPull`/`runCategorize`) next to its definition.
- Connection settings (site, project, email, token) resolve with precedence
  flags > `.jira/.config.ts`. The tool never reads environment variables — the
  config is a TS module, so the user opts into env access there
  (`token: process.env.JIRA_API_TOKEN`). Categorize needs no credentials.
- The compiled binary reads no `.env` file; it gets values from `.config.ts`,
  flags, or env vars the config reads itself.
- The package also publishes to JSR (`deno task publish:check` /
  `deno task publish`; bump `version` in deno.json): exports are `.` →
  `src/mod.ts` (re-exporting the `JiraLocalConfig` type from
  `src/types/config.ts` so `.config.ts` authors can
  `import type { JiraLocalConfig } from "jsr:@jollytoad/jira-local"`) and
  `./cli` → `src/cli.ts`, runnable directly as
  `deno run jsr:@jollytoad/jira-local/cli`. `init`'s generated config imports
  from `../src/mod.ts` locally and from the package specifier when run from a
  published copy.

## Files

- `.jira/.config.ts` (sibling of `issues/`, gitignored, `export const config`):
  connection fields (`site`, `project`, `email`, `token` — used by pull, ignored
  by categorize; validated as non-empty strings) plus the category fields below.
  Loaded/validated by `config.ts`'s cached `getConfig`; missing file = defaults
  (then missing site/project is a hard error). Created by
  `deno task jira-local init`: interactive by default — prompts for the site
  (full URL, domain, or bare site prefix, normalised to a base URL), the project
  key directly, and for email/token either a direct value or an env var name;
  `--yes`/`-y` (or a non-TTY stdin) skips the prompts, and connection flags
  prefill/skip their prompt. Refuses if the file exists.
- `.env` (gitignored, optional): not read by the tool itself — the user's
  `.config.ts` can pull values from it via `process.env.*` when run with
  `--env-file` in the deno tasks.
- `.jira/` is gitignored generated output — safe to delete. Deleting
  `.jira/.state.json` forces a full pull.
- The mirror is one-way (Jira → disk): local edits to `.jira/issues/all/*.md`
  are overwritten on the next pull; the tool never writes to Jira.
- Pruning of deleted issues only happens on `--full` (incremental runs can't
  know what they didn't fetch).

## Notes

- Entry point `src/cli.ts`; pipeline: `jira.ts` (REST v3, streaming pages) →
  `adf-to-markdown.ts` → `render.ts` → `pull.ts` (mirror issues to disk) →
  `commands/` (pull/categorize orchestration); watermark in `state.ts`; config
  in `config.ts` (`.jira/.config.ts`, loaded lazily via `getConfig`).
- Categories: `categorize.ts` holds the single `categorizeIssue` function
  (front-matter object + raw body → category strings, `/` = nesting);
  `categories.ts` reconciles it into symlink folders next to `all/`
  (`.jira/issues/status/<status>/<KEY>-<summary>.md` plus `assignee/`, `labels/`
  (one folder per label, `/` in a label nests) and `parent/<key>` when the issue
  has one; unassigned issues go to `assignee/Unassigned`; issues with status
  category "Done" are status-only and appear nowhere else). Folder names mirror
  the front-matter field each category derives from. Every non-hidden directory
  under `.jira/issues/` other than `all/` is treated as managed, so stale
  folders, are cleaned up automatically. Runs on every pull and via
  `deno task jira-local categorize` (offline).
- Index pages: `category-indexes.ts` renders a markdown table per leaf category
  (`.jira/issues/status/Backlog.md` next to the folder); columns come from
  `.jira/.config.ts`'s `categoryIndex` (default `DEFAULT_INDEX_COLUMNS`: `key`
  links into `all/`, any other front-matter field renders as a column), rows
  sorted by key. Written only when content differs; removed when their category
  goes stale or loses its index entry.
- `.jira/.config.ts` (sibling of `issues/`, gitignored, `export const config`):
  optional `categoryFolders` allowlist (top-level folders, typed as front-matter
  field names; unlisted ones are cleaned up as stale, valid-but-unproduced keys
  are inert) and `categoryIndex` map (folder → columns, allowlist — omitted
  folders get no index; omit the whole field for defaults everywhere), plus the
  connection fields described under CLI. The two category are independent: an
  index entry without `categoryFolders` membership yields index-only categories
  (leaf `.md` pages, no symlink folders). Keys and columns are front-matter
  field names, enforced at type-check and runtime. Loaded/validated by
  `config.ts`'s cached `getConfig`; missing file = defaults.
- Incremental pull keys off Jira's `updated` timestamps (account timezone), not
  the local clock.
