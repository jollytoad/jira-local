# AGENTS.md

## Commands

```sh
deno task ok                # fmt + lint + typecheck — the only verification (no tests exist)
deno task sync              # incremental sync
deno task sync --full       # full sync (also the only mode that prunes deletions)
deno task sync --dry-run    # decide but write nothing
deno task categorize        # re-categorise only (offline; sync also does this)
```

- Deno 2.x, three runtime dependencies (`@cliffy/command` for the CLI,
  `@std/front-matter`, `@std/yaml` via `imports` in `deno.json`, pinned by
  `deno.lock` — commit it), no CI. `deno task ok` is the full check.
- `src/types.ts` holds types only (interfaces/type aliases) — never runtime
  values. Constants live in `src/constants.ts`.
- The `sync`/`categorize` tasks use unscoped `--allow-write` because Deno
  refuses `symlink()` under path-scoped grants. The code itself only writes
  inside `.jira`.

## CLI

- `src/cli.ts` builds the cliffy `Command` (`jira-local` with a `categorize`
  subcommand); `src/run.ts` holds `runSync`/`runCategorize`; `src/main.ts` is a
  thin entry that parses and maps runtime errors to exit codes.
- Env fallbacks come from cliffy `.env()` with `prefix: "JIRA_"` (so
  `JIRA_API_TOKEN` maps to `options.apiToken`, read as `--token`'s value); flags
  beat env vars. The old `.jira/.env` dotenv loader is gone — the root `.env` is
  loaded by `--env-file` in the deno tasks (and not at all for a compiled
  binary, which needs real env vars or flags).

## Files

- `.env` (gitignored): `JIRA_EMAIL` + `JIRA_API_TOKEN` (Atlassian API token, not
  password), plus `JIRA_SITE` + `JIRA_PROJECT` defaults, loaded via `--env-file`
  in the deno tasks. No defaults are hardcoded — a missing
  `JIRA_SITE`/`JIRA_PROJECT` is a hard error.
- `.jira/` is gitignored generated output — safe to delete. Deleting
  `.jira/.state.json` forces a full sync.
- The mirror is one-way (Jira → disk): local edits to `.jira/issues/all/*.md`
  are overwritten on the next sync; the tool never writes to Jira.
- Pruning of deleted issues only happens on `--full` (incremental runs can't
  know what they didn't fetch).

## Notes

- Entry point `src/main.ts`; pipeline: `jira.ts` (REST v3, streaming pages) →
  `adf-to-markdown.ts` → `render.ts` → `sync.ts` → `run.ts` (sync/categorize
  orchestration); watermark in `state.ts`; config in `config.ts`
  (`.jira/config.ts`, loaded lazily via `getConfig`).
- Categories: `categorize.ts` holds the single `categorizeIssue` function
  (front-matter object + raw body → category strings, `/` = nesting);
  `categories.ts` reconciles it into symlink folders next to `all/`
  (`.jira/issues/status/<status>/<KEY>-<summary>.md` plus `assignee/`, `labels/`
  (one folder per label, `/` in a label nests) and `parent/<key>` when the issue
  has one; unassigned issues go to `assignee/Unassigned`; issues with status
  category "Done" are status-only and appear nowhere else). Folder names mirror
  the front-matter field each category derives from. Every non-hidden directory
  under `.jira/issues/` other than `all/` is treated as managed, so stale
  folders are cleaned up automatically. Runs on every sync and via
  `deno task categorize` (offline).
- Index pages: `category-indexes.ts` renders a markdown table per leaf category
  (`.jira/issues/status/Backlog.md` next to the folder); columns come from
  `.jira/config.ts`'s `categoryIndex` (default `DEFAULT_INDEX_COLUMNS`: `key`
  links into `all/`, any other front-matter field renders as a column), rows
  sorted by key. Written only when content differs; removed when their category
  goes stale or loses its index entry.
- `.jira/config.ts` (sibling of `issues/`, gitignored, `export const config`):
  optional `categoryFolders` allowlist (top-level folders, typed as front-matter
  field names; unlisted ones are cleaned up as stale, valid-but-unproduced keys
  are inert) and `categoryIndex` map (folder → columns, allowlist — omitted
  folders get no index; omit the whole field for defaults everywhere). The two
  are independent: an index entry without `categoryFolders` membership yields
  index-only categories (leaf `.md` pages, no symlink folders). Keys and columns
  are front-matter field names, enforced at type-check and runtime.
  Loaded/validated by `config.ts`'s cached `getConfig`; missing file = defaults.
- Incremental sync keys off Jira's `updated` timestamps (account timezone), not
  the local clock.
