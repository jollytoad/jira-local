# jira-local

> [!WARNING]
> **Very experimental.** Built mostly with [OpenCode](https://opencode.ai). It
> may change or break without notice and has not been battle-tested. Use at your
> own risk.

A small Deno tool that mirrors a Jira Cloud project onto local disk as plain
markdown — one file per issue — so you can grep, diff and edit your issues with
the tools you already use.

```
Jira Cloud ──stream──▶ render to markdown ──▶ .jira/issues/all/<KEY>.md
```

- **Streaming.** Search pages are fetched one ahead: while page N renders and
  writes, page N+1 is already downloading. A full pull of ~1,200 issues takes
  about 9 seconds; an incremental one about a second.
- **Incremental by default.** `.jira/.state.json` remembers the newest issue
  `updated` timestamp from the last clean run, and later pulls fetch only what
  changed. `--full` ignores it.
- **Idempotent.** Files are compared before writing, so a re-run with nothing
  new to report rewrites nothing and stays quiet.

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

- Either [Homebrew](https://brew.sh), or [Deno](https://deno.com) 2.x
- A Jira Cloud account with an
  [API token](https://id.atlassian.com/manage-profile/security/api-tokens)

## Install

### Homebrew

Prebuilt binaries for macOS (Apple Silicon and Intel) and Linux (x86_64 and
arm64), no Deno needed. The formula lives in this repo rather than a
`homebrew-*` tap repo, so tap the URL explicitly first:

```sh
brew tap jollytoad/jira-local https://github.com/jollytoad/jira-local
brew install jollytoad/jira-local/cli
```

### Deno

Run straight from the published JSR package (or clone the repo and use the
`deno task` entries):

```sh
deno run jsr:@jollytoad/jira-local/cli init
deno run --allow-net --allow-read --allow-write --allow-env jsr:@jollytoad/jira-local/cli pull
deno run jsr:@jollytoad/jira-local/cli categorize
```

Permissions are still needed (network for `pull`, file access for
`pull`/`categorize`), so grant them per-run as shown for `pull` above.

### Standalone binary

Releases also carry per-platform tarballs: download one, untar, and put the
`jira-local` binary on your `PATH`. To build locally:

```sh
deno task compile        # ./jira-local for this platform
./jira-local init
./jira-local pull
```

## Setup

```sh
deno task jira-local init
```

`init` creates `.jira/.config.ts` (a sibling of the issues folder, never
committed) and refuses to overwrite an existing one. It prompts for the site (a
full URL, bare domain or site prefix, normalised to a base URL), the project
key, and for email/token either a direct value or an env-var name (defaulting to
`JIRA_EMAIL`/`JIRA_API_TOKEN`); skipped inputs keep the template defaults. Pass
`--yes`/`-y` to skip the prompts (they also skip automatically when stdin is not
a terminal), or prefill them with `--site`/`--project`/`--email`/`--token`.

The generated config is a TypeScript module exporting a `config` object:

```ts
import type { JiraLocalConfig } from "jsr:@jollytoad/jira-local";

export const config: JiraLocalConfig = {
  site: "https://yoursite.atlassian.net",
  project: "EXAMPLE",
  email: process.env.JIRA_EMAIL,
  token: process.env.JIRA_API_TOKEN,
  // ...category fields, see Configuration below
};
```

The tool itself never reads environment variables — the config is a TS module,
so you opt into env access there. To feed those variables from a file, use a
gitignored `.env` (plain `KEY=VALUE` lines) and run through the `deno task`
entries, which pass `--env-file`; the compiled binary reads no `.env` at all.
All connection settings can also be overridden per-run with
`--site`/`--project`/`--email`/`--token`.

## Usage

```sh
deno task jira-local pull             # incremental pull (first run is full)
deno task jira-local pull --full      # full pull; also the only mode that prunes
deno task jira-local categorize       # re-categorise only (offline; pull also does this)
deno task jira-local init             # create .jira/.config.ts (see Setup)
deno task ok                          # deno fmt && deno lint && deno check
```

### Options

`pull` flags:

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

Global flags (accepted before or after the sub-command):

| Flag         | Meaning                                                      | Default                     |
| ------------ | ------------------------------------------------------------ | --------------------------- |
| `--verbose`  | One timestamped line per step instead of in-place task lines | task lines on a terminal    |
| `--no-color` | Disable colour in task lines                                 | colour when stdout is a tty |

### Colour

On a terminal the in-place task lines are coloured: yellow spinner while a task
runs, green ✔ on success, red ✘ on failure, a muted dot leader and a bold tally.
Piped output and `--verbose` are plain text with no escape codes at all.

Colour is off when stdout is not a terminal, when `TERM=dumb`, when `NO_COLOR`
is set, or when `--no-color` is passed; `FORCE_COLOR` turns it on regardless,
which is what makes coloured help useful in a CI log. `NO_COLOR` wins over
everything, including `--no-color`.

`--no-color` reaches the task lines only — help is rendered before flags are
parsed, so help follows `NO_COLOR` and the tty check instead.

### Files on disk

| Path                         | What it is                                                  |
| ---------------------------- | ----------------------------------------------------------- |
| `.jira/issues/all/<KEY>.md`  | One markdown file per issue; regenerated, safe to delete    |
| `.jira/issues/<category>.md` | Index pages, e.g. `status/Backlog.md` (see Configuration)   |
| `.jira/.state.json`          | Incremental watermark; delete to force a full pull          |
| `.jira/.config.ts`           | Connection settings and category config; created by `init`  |
| `.env`                       | Optional values for the `process.env.*` reads in the config |

`.jira/` and `.env` are gitignored, and `.jira/` is safe to delete at any time.

### Configuration

Besides the connection fields, `.jira/.config.ts` can restrict which index pages
get materialised. Omit `categoryIndex` for index pages everywhere with default
columns:

```ts
import type { JiraLocalConfig } from "jsr:@jollytoad/jira-local";

export const config: JiraLocalConfig = {
  // Index pages per top-level category, with table columns (front-matter
  // field names). Categories not listed here get nothing.
  categoryIndex: {
    status: ["key", "summary", "assignee"],
  },
};
```

Index pages hold a markdown table sorted by issue key; `key` renders as a link
into `all/`, any other column as the raw front-matter value. Names are
front-matter field names, enforced at type-check and runtime: a config naming
anything else aborts the run with a validation error before anything is written.

## Semantics and caveats

- **Deletes:** Jira issue _deletions_ are pruned only on a full pull, because an
  incremental run cannot know what it did not look at. Run `--full`
  occasionally, or after deleting issues.
- **Overwrite-only:** local edits to the markdown files are overwritten on the
  next pull. The mirror is one-way (Jira → disk); this tool never writes to
  Jira.
- **Clock:** the watermark uses Jira's own `updated` timestamps (rendered in the
  account's timezone), not your machine's clock, so local clock skew is
  irrelevant. A one-minute overlap absorbs edits in the watermark's own minute.
- **Aborted runs:** the watermark only advances after a run completes, so an
  interrupted pull simply re-pulls the same window next time.
- **Comment truncation:** Jira's search embeds at most 100 comments per issue;
  the tool detects truncation (`total` vs returned count) and transparently
  falls back to per-issue comment fetches.

## Development

| File                  | Role                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `cli.ts`              | Entry: builds/parses the cliffy Command, maps errors to exit codes                           |
| `commands/*.ts`       | One per subcommand — `pull`, `categorize`, `init` — each default-exporting its `Command`     |
| `jira.ts`             | REST v3 client: search paging with lookahead, comments, retries/429 backoff, incremental JQL |
| `render.ts`           | Issue → markdown (front matter, description, comments)                                       |
| `adf-to-markdown.ts`  | Atlassian Document Format → markdown                                                         |
| `pull.ts`             | Per-issue create/update/unchanged, pruning, progress lines                                   |
| `categorize.ts`       | The one `categorizeIssue` function: front matter + body → category strings                   |
| `categories.ts`       | Reconciles categories into index pages next to `all/`                                        |
| `category-indexes.ts` | Renders a category's index table                                                             |
| `config.ts`           | Loads/validates `.jira/.config.ts`, cached `getConfig`                                       |
| `state.ts`            | Incremental watermark load/save                                                              |
| `progress.ts`         | Task lines on a tty, timestamped lines when piped or `--verbose`                             |
| `style.ts`            | Colour gate (NO_COLOR / FORCE_COLOR / TERM / TTY) and the palette                            |
| `errors.ts`           | Error types shared by the client and CLI                                                     |
| `constants.ts`        | Front-matter field names, for config validation                                              |
| `types/`              | Types only, split by domain: `adf`, `jira-raw`, `jira-local`, `config`                       |
| `util.ts`             | Small shared helpers (bounded-concurrency pool)                                              |

Runtime dependencies are pinned by [`deno.lock`](./deno.lock): `@cliffy/command`
(the CLI), `@cliffy/prompt` (init's prompts), `@std/front-matter` (parsing issue
front matter for categorisation), `@std/yaml` (rendering front matter) and
`@std/fmt` (terminal colour).

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
