# jira-local

A small Deno tool that mirrors a Jira Cloud project onto local disk as plain
markdown — one file per issue — so you can grep, diff, and edit your issues with
the tools you already use.

## How it works

```
Jira Cloud ──stream──▶ render to markdown ──▶ .jira/issues/all/<KEY>.md
```

- **Streaming pipeline.** Search pages are fetched one ahead of the other: while
  page N is being rendered and written, page N+1 is already downloading.
  Comments are embedded in the search response (per-issue fallback fetches kick
  in automatically if a payload is ever truncated). A full sync of ~1,200 issues
  takes ~9 seconds.
- **Incremental by default.** A watermark (`.jira/.state.json`) remembers the
  newest issue `updated` timestamp from the last clean run; subsequent syncs
  fetch only issues changed since then (typically ~1 second). Use `--full` to
  sync everything.
- **Idempotent.** Files are compared byte-for-byte; a re-run writes nothing and
  reports `N unchanged`.

Each issue file looks like:

```markdown
---
key: "EXAMPLE-123"
summary: "Fix the thing"
status: "Done"
type: "Task"
priority: "Medium"
assignee: "Mark Gibson"
reporter: "Jane Doe"
labels: []
parent: "EXAMPLE-42"
children: []
linked: ["EXAMPLE-99", "EXAMPLE-120"]
created: "2026-01-05"
updated: "2026-09-12"
url: "https://yoursite.atlassian.net/browse/EXAMPLE-123"
---

# EXAMPLE-123 Fix the thing

## Description

...

## Comments

### Comment 1 — Jane Doe (2026-01-06)

...
```

## Requirements

- [Deno](https://deno.com) 2.x
- A Jira Cloud account with an
  [API token](https://id.atlassian.com/manage-profile/security/api-tokens)

## Setup

Put credentials and defaults in `.env` (never commit it):

```
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=<atlassian-api-token>
JIRA_SITE=https://yoursite.atlassian.net
JIRA_PROJECT=<project-key>
```

All of these can be overridden with `--email`/`--token`/`--site`/`--project`.

### Standalone executable

The tool compiles to a self-contained binary that needs no Deno install:

```sh
deno task compile           # produces ./jira-local (current platform)
./jira-local sync --dry-run
./jira-local categorize
```

The binary reads credentials from the environment or from `.jira/.env` (created
next to the issue files, in dotenv format — same `KEY=VALUE` lines as `.env`;
real environment variables win). Cross-compile to another platform with
`--target` (e.g. `--target aarch64-unknown-linux-gnu`).

## Usage

```sh
deno task sync             # incremental sync (first run is full)
deno task sync --full      # full sync; also the only mode that prunes
deno task sync --dry-run
deno task categorize       # re-categorise only (offline; sync also does this)
deno task ok               # deno fmt && deno lint && deno check
```

### Options

| Flag                  | Meaning                                                | Default            |
| --------------------- | ------------------------------------------------------ | ------------------ |
| `--site <url>`        | Jira Cloud base URL                                    | `JIRA_SITE`        |
| `--project <key>`     | Project key                                            | `JIRA_PROJECT`     |
| `--out <dir>`         | Output directory                                       | `.jira/issues/all` |
| `--email` / `--token` | Override `.env` credentials                            | —                  |
| `--dry-run`           | Decide but write nothing (state file untouched)        | —                  |
| `--no-prune`          | Skip deleting files for issues deleted in Jira         | prune on           |
| `--allow-empty`       | Accept a 0-issue result (genuinely empty project)      | off                |
| `--full`              | Ignore the watermark; sync everything; enables pruning | incremental        |

### Files on disk

| Path                        | What it is                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.jira/issues/all/<KEY>.md` | One markdown file per issue (regenerated, safe to delete)                                                                                                                                                                    |
| `.jira/issues/<category>/…` | Symlinks into `all/`, e.g. `status/Done/`, `assignee/`, `labels/` or `parent/<KEY>/…` (every folder here except `all/` is managed; done issues are status-only; folder names mirror the front-matter field they derive from) |
| `.jira/.state.json`         | Incremental watermark + timezone + project (delete it to force a full sync)                                                                                                                                                  |
| `.jira/config.ts`           | Optional config: which category folders and index pages are created (not committed; missing file = defaults)                                                                                                                 |
| `.jira/.env`                | Optional credentials for the compiled binary and all runs (not committed; real environment variables win)                                                                                                                    |
| `.env`                      | Credentials and defaults loaded by the `deno task` entries (not committed)                                                                                                                                                   |

### Configuration

`.jira/config.ts` (a sibling of `issues/`) optionally restricts what the
categoriser materialises. It is a TypeScript module exporting a `config` object;
every field is optional and a missing file means "everything, with default
columns":

```ts
import type { JiraLocalConfig } from "../src/types.ts";

export const config: JiraLocalConfig = {
  // Top-level category folders to create, named after the front-matter field
  // they derive from; unlisted ones are cleaned up.
  categoryFolders: ["status", "assignee"],
  // Index pages per top-level folder, with table columns (front-matter
  // field names). Independent of `categoryFolders`: a folder listed here
  // but not in `categoryFolders` gets only its index pages (no symlink
  // folders). Folders in neither list get nothing; omit `categoryIndex`
  // entirely for index pages everywhere with `["key", "summary"]` columns.
  categoryIndex: {
    status: ["key", "summary", "assignee"],
  },
};
```

A malformed config (folder names or columns that aren't front-matter field
names) aborts the run with a validation error before anything is written.

## Semantics and caveats

- **Deletes:** Jira issue _deletions_ are only pruned on a full sync, because an
  incremental run cannot know what it did not look at. Run `--full`
  occasionally, or after deleting issues.
- **Overwrite-only:** local edits to the markdown files are overwritten on the
  next sync. The mirror is one-way (Jira → disk); this tool never writes to
  Jira.
- **Clock:** the watermark uses Jira's own `updated` timestamps (rendered in the
  account's timezone), not your machine's clock, so local clock skew is
  irrelevant. A 1-minute overlap absorbs edits in the watermark minute.
- **Aborted runs:** the watermark only advances after a run completes, so an
  interrupted sync simply re-syncs the same window next time.
- **Comment truncation:** Jira's search embeds at most 100 comments per issue;
  the tool detects truncation (`total` vs returned count) and transparently
  falls back to per-issue comment fetches when needed.

## Development

Source lives in `src/`:

| File                  | Role                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `main.ts`             | CLI entry: credentials, preflight, stream → sync loop, state, summary                               |
| `cli.ts`              | Argument parsing + help                                                                             |
| `env.ts`              | Env-var helper, `.jira/.env` dotenv loader                                                          |
| `errors.ts`           | Error types shared by the client and CLI                                                            |
| `jira.ts`             | Jira REST v3 client: search paging (with lookahead), comments, retries/429 backoff, incremental JQL |
| `render.ts`           | Issue → markdown (front matter, description, comments)                                              |
| `adf-to-markdown.ts`  | Atlassian Document Format → markdown converter                                                      |
| `sync.ts`             | Per-issue create/update/unchanged decisions, pruning, progress lines                                |
| `categorize.ts`       | The single `categorizeIssue` function: front matter + body → category strings (`/` nests folders)   |
| `categories.ts`       | Reconciles those categories into symlink folders next to `all/`                                     |
| `category-indexes.ts` | Renders per-category index tables (`<folder>.md` next to each category folder)                      |
| `config.ts`           | Loads/validates `.jira/config.ts` (category folders + index pages), cached `getConfig`              |
| `state.ts`            | Incremental watermark load/save                                                                     |
| `util.ts`             | Small shared helpers (progress logging, pool)                                                       |

Run checks with `deno task ok` (fmt, lint, type-check). Runtime dependencies
([pinned by `deno.lock`](./deno.lock)):
[`@std/front-matter`](https://jsr.io/@std/front-matter) (issue front-matter
parsing for categorisation) and [`@std/yaml`](https://jsr.io/@std/yaml)
(front-matter rendering).

## Troubleshooting

- **"Jira rejected the credentials (401)"** — the token must be an Atlassian
  _API token_, not your account password.
- **"Project X not found"** — wrong key, or the account lacks Browse Projects.
- **Search returns 0 issues for a non-empty project** — the search endpoint can
  silently degrade to an anonymous query; the tool double-checks with the
  approximate-count endpoint and refuses to prune in that case. Check the
  credentials and project key.

## License

[MIT](./LICENSE) © Mark Gibson
