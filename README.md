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
  in automatically if a payload is ever truncated). A full pull of ~1,200 issues
  takes ~9 seconds.
- **Incremental by default.** A watermark (`.jira/.state.json`) remembers the
  newest issue `updated` timestamp from the last clean run; subsequent pulls
  fetch only issues changed since then (typically ~1 second). Use `--full` to
  pull everything.
- **Idempotent.** Files are compared byte-for-byte; a re-run writes nothing and
  reports `N unchanged`.

Each issue file looks like:

```markdown
---
key: "EXAMPLE-123"
summary: "Fix the thing"
status: "Done"
statusCategory: "Done"
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

Run the interactive initialiser to create `.jira/.config.ts` (a sibling of the
issues folder, never committed):

```sh
deno task jira-local init
```

It prompts for the site (a full URL, bare domain, or site prefix — normalised to
a base URL), the project key, and for email/token either a direct value or an
environment-variable name (defaulting to `JIRA_EMAIL`/`JIRA_API_TOKEN`); skipped
inputs keep the template defaults. Pass `--yes`/`-y` to skip the prompts (they
are also skipped automatically when stdin is not a terminal), and
`--site`/`--project`/`--email`/`--token` flags prefill and skip their prompt. It
refuses to overwrite an existing config — edit that file instead.

The generated config is a TypeScript module exporting a `config` object:

```ts
import type { JiraLocalConfig } from "../src/types.ts";

export const config: JiraLocalConfig = {
  site: "https://yoursite.atlassian.net",
  project: "EXAMPLE",
  email: process.env.JIRA_EMAIL,
  token: process.env.JIRA_API_TOKEN,
  // ...category fields, see Configuration below
};
```

The tool itself never reads environment variables — the config is a TS module,
so you opt into env access there (`token: process.env.JIRA_API_TOKEN`). To feed
those variables from a file, put them in a gitignored `.env` (same `KEY=VALUE`
lines) and run through the `deno task` entries, which pass `--env-file`; the
compiled binary reads no `.env` at all. All connection settings can also be
overridden per-run with `--site`/`--project`/`--email`/ `--token`.

### Standalone executable

The tool compiles to a self-contained binary that needs no Deno install:

```sh
deno task compile        # produces ./jira-local (current platform)
./jira-local init        # provide config interactively
./jira-local pull        # fetch all issues from the configured project
./jira-local categorize  # generate category indexes
```

The binary reads no `.env` file: it gets values from `.jira/.config.ts`, the
flags, or environment variables the config itself reads via `process.env.*`.
Cross-compile to another platform with `--target` (e.g.
`--target aarch64-unknown-linux-gnu`).

## Usage

```sh
deno task jira-local pull             # incremental pull (first run is full)
deno task jira-local pull --full      # full pull; also the only mode that prunes
deno task jira-local categorize       # re-categorise only (offline; pull also does this)
deno task jira-local init             # create .jira/.config.ts (see Setup)
deno task ok                          # deno fmt && deno lint && deno check
```

### Options

| Flag                  | Meaning                                                | Default                |
| --------------------- | ------------------------------------------------------ | ---------------------- |
| `--site <url>`        | Jira Cloud base URL                                    | `.config.ts` `site`    |
| `--project <key>`     | Project key                                            | `.config.ts` `project` |
| `--out <dir>`         | Output directory                                       | `.jira/issues/all`     |
| `--email` / `--token` | Override the config credentials                        | —                      |
| `--dry-run`           | Decide but write nothing (state file untouched)        | —                      |
| `--no-prune`          | Skip deleting files for issues deleted in Jira         | prune on               |
| `--allow-empty`       | Accept a 0-issue result (genuinely empty project)      | off                    |
| `--full`              | Ignore the watermark; pull everything; enables pruning | incremental            |

### Files on disk

| Path                        | What it is                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.jira/issues/all/<KEY>.md` | One markdown file per issue (regenerated, safe to delete)                                                                                                                                                                    |
| `.jira/issues/<category>/…` | Symlinks into `all/`, e.g. `status/Done/`, `assignee/`, `labels/` or `parent/<KEY>/…` (every folder here except `all/` is managed; done issues are status-only; folder names mirror the front-matter field they derive from) |
| `.jira/.state.json`         | Incremental watermark + timezone + project (delete it to force a full pull)                                                                                                                                                  |
| `.jira/.config.ts`          | Connection settings and optional config: which category folders and index pages are created; created by `init` (not committed; missing file = defaults)                                                                      |
| `.env`                      | Optional: values for the `process.env.*` reads in `.jira/.config.ts`, loaded by the `deno task` entries via `--env-file` (not committed; the tool never reads env vars itself)                                               |

### Configuration

`.jira/.config.ts` (a sibling of `issues/`, created by `init`) holds the
connection fields (`site`, `project`, `email`, `token` — used by pull, ignored
by categorise) and optionally restricts what the categoriser materialises. It is
a TypeScript module exporting a `config` object; the category fields are
optional and a missing file means "everything, with default columns":

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

- **Deletes:** Jira issue _deletions_ are only pruned on a full pull, because an
  incremental run cannot know what it did not look at. Run `--full`
  occasionally, or after deleting issues.
- **Overwrite-only:** local edits to the markdown files are overwritten on the
  next pull. The mirror is one-way (Jira → disk); this tool never writes to
  Jira.
- **Clock:** the watermark uses Jira's own `updated` timestamps (rendered in the
  account's timezone), not your machine's clock, so local clock skew is
  irrelevant. A 1-minute overlap absorbs edits in the watermark minute.
- **Aborted runs:** the watermark only advances after a run completes, so an
  interrupted pull simply re-pulls the same window next time.
- **Comment truncation:** Jira's search embeds at most 100 comments per issue;
  the tool detects truncation (`total` vs returned count) and transparently
  falls back to per-issue comment fetches when needed.

## Development

Source lives in `src/`:

| File                     | Role                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `main.ts`                | Thin entry: parses via the cliffy command tree, maps runtime errors to exit codes                          |
| `cli.ts`                 | Builds the cliffy `Command` (`pull`, `categorize`, `init` subcommands) + help                              |
| `commands/pull.ts`       | The `pull` command: connection resolution, preflight, stream → mirror loop, state, summary                 |
| `commands/categorize.ts` | The `categorize` command: offline re-categorisation of the files already on disk                           |
| `commands/init.ts`       | The `init` command: prompts, site normalisation, writes the `.jira/.config.ts` template                    |
| `errors.ts`              | Error types shared by the client and CLI                                                                   |
| `jira.ts`                | Jira REST v3 client: search paging (with lookahead), comments, retries/429 backoff, incremental JQL        |
| `render.ts`              | Issue → markdown (front matter, description, comments)                                                     |
| `adf-to-markdown.ts`     | Atlassian Document Format → markdown converter                                                             |
| `pull.ts`                | Per-issue create/update/unchanged decisions, pruning, progress lines                                       |
| `categorize.ts`          | The single `categorizeIssue` function: front matter + body → category strings (`/` nests folders)          |
| `categories.ts`          | Reconciles those categories into symlink folders next to `all/`                                            |
| `category-indexes.ts`    | Renders per-category index tables (`<folder>.md` next to each category folder)                             |
| `config.ts`              | Loads/validates `.jira/.config.ts` (connection fields, category folders + index pages), cached `getConfig` |
| `state.ts`               | Incremental watermark load/save                                                                            |
| `constants.ts`           | Shared runtime constants (front-matter field names for config validation)                                  |
| `types.ts`               | Types only (interfaces/type aliases)                                                                       |
| `util.ts`                | Small shared helpers (progress logging, pool)                                                              |

Run checks with `deno task ok` (fmt, lint, type-check). Runtime dependencies
([pinned by `deno.lock`](./deno.lock)):
[`@cliffy/command`](https://jsr.io/@cliffy/command) (the CLI) and
[`@cliffy/prompt`](https://jsr.io/@cliffy/prompt) (init's interactive prompts),
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
