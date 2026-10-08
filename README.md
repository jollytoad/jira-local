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

- A Jira Cloud account with an
  [API token](https://id.atlassian.com/manage-profile/security/api-tokens)

## Install

### Install script

Prebuilt binary, no Homebrew and no Deno. Downloads the release for your
platform, verifies its checksum and drops it in `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/jollytoad/jira-local/main/install.sh | sh
```

Pass `--prefix <dir>` to install elsewhere (or set `JIRA_LOCAL_PREFIX`),
`--version <ver>` to pin a release. If the directory isn't on your `PATH` the
script tells you what to add. Later updates come from the binary itself:

```sh
jira-local upgrade
```

### Homebrew

Prebuilt binaries for macOS (Apple Silicon and Intel) and Linux (x86_64 and
arm64), no Deno needed. The formula lives in this repo rather than a
`homebrew-*` tap repo, so tap the URL explicitly first:

```sh
brew tap jollytoad/jira-local https://github.com/jollytoad/jira-local
brew install jollytoad/jira-local/cli
```

### Deno

Install the CLI from the published JSR package to get the same `jira-local`
command as the binary builds:

```sh
deno install --global jsr:@jollytoad/jira-local/cli
```

Or run it straight from the package without installing, granting permissions
per-run:

```sh
deno run jsr:@jollytoad/jira-local/cli init
deno run --allow-net --allow-read --allow-write --allow-env jsr:@jollytoad/jira-local/cli pull
deno run jsr:@jollytoad/jira-local/cli categorize
```

## Setup

```sh
jira-local init
```

This creates `.jira/.config.ts` and refuses to overwrite an existing one.

It prompts for the Jira site, the project key, and for email/token either a
direct value or an env-var name. Pass `--yes`/`-y` to skip the prompts, or
prefill them with `--site`/`--project`/`--email`/`--token` options.

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

## Usage

```sh
jira-local pull             # incremental pull (first run is full)
jira-local pull --full      # full pull; also the only mode that prunes
jira-local categorize       # re-categorise only (offline; pull also does this)
```

### Upgrading

A binary installed by the install script replaces itself in place:

```sh
jira-local upgrade                     # latest release
jira-local upgrade --version 0.1.1     # pin a version (v prefix optional)
jira-local upgrade --list-versions     # what is available
jira-local upgrade --force             # reinstall even if up to date
```

`jira-local --version` also reports when a newer release exists. The command
only works for the compiled binary, since it replaces the running executable — a
Deno or Homebrew install is upgraded by whatever installed it
(`deno install --global`, `brew upgrade`).

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

```sh
deno task ok               # fmt + lint + typecheck + publish dry run — the only verification
deno task compile          # self-contained binary at ./jira-local for this platform
deno task jira-local <sub-command>   # the same CLI from source, with --env-file for a .env
```

The compiled binary is the release artefact: `deno task compile` cross-compiles
to the four published targets with `--target`, and those tarballs are what
`install.sh`, the Homebrew formula and `jira-local upgrade` all fetch.

| File                     | Role                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `cli.ts`                 | Entry: builds/parses the cliffy Command, maps errors to exit codes                                  |
| `commands/*.ts`          | One per subcommand — `pull`, `categorize`, `init`, `upgrade` — each default-exporting its `Command` |
| `jira.ts`                | REST v3 client: search paging with lookahead, comments, retries/429 backoff, incremental JQL        |
| `render.ts`              | Issue → markdown (front matter, description, comments)                                              |
| `adf-to-markdown.ts`     | Atlassian Document Format → markdown                                                                |
| `mirror.ts`              | The disk mirror: locate issue files, write one, prune deleted ones                                  |
| `categorize.ts`          | The one `categorizeIssue` function: front matter + body → category strings                          |
| `categories.ts`          | Reconciles categories into index pages next to `all/`, reading each issue's front matter from disk  |
| `category-indexes.ts`    | Renders a category's index table                                                                    |
| `config.ts`              | Loads/validates `.jira/.config.ts`, cached `getConfig`                                              |
| `state.ts`               | Incremental watermark load/save                                                                     |
| `progress.ts`            | Task lines on a tty, timestamped lines when piped or `--verbose`                                    |
| `style.ts`               | Colour gate (NO_COLOR / FORCE_COLOR / TERM / TTY) and the palette                                   |
| `errors.ts`              | Error types shared by the client and CLI                                                            |
| `constants.ts`           | Front-matter field names, for config validation                                                     |
| `types/`                 | Types only, split by domain: `adf`, `jira-raw`, `jira-local`, `config`                              |
| `util.ts`                | Small shared helpers (bounded-concurrency pool)                                                     |
| `version.ts`             | The published version, generated from `deno.json` (never edited by hand)                            |
| `install.sh`             | The `curl \| sh` installer for the release tarballs                                                 |
| `tools/write-version.ts` | Regenerates `version.ts` from `deno.json` (the `deno task version` entry)                           |

Runtime dependencies are pinned by [`deno.lock`](./deno.lock): `@cliffy/command`
(the CLI), `@cliffy/prompt` (init's prompts), `@cliffy/upgrade` (the `upgrade`
command), `@std/front-matter` (parsing issue front matter for categorisation),
`@std/yaml` (rendering front matter) and `@std/fmt` (terminal colour).

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
