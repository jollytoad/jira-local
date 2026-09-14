# AGENTS.md

## Commands

```sh
deno task ok                # fmt + lint + typecheck — the only verification (no tests exist)
deno task sync              # incremental sync
deno task sync --full       # full sync (also the only mode that prunes deletions)
deno task sync --dry-run    # decide but write nothing
deno task categorize        # re-categorise only (offline; sync also does this)
```

- Deno 2.x, one runtime dependency (`@std/front-matter` via `imports` in
  `deno.json`, pinned by `deno.lock` — commit it), no CI. `deno task ok` is the
  full check.
- The `sync`/`categorize` tasks use unscoped `--allow-write` because Deno
  refuses `symlink()` under path-scoped grants. The code itself only writes
  inside `.jira`.

## Files

- `.env` (gitignored): `JIRA_EMAIL` + `JIRA_API_TOKEN` (Atlassian API token, not
  password), plus `JIRA_SITE` + `JIRA_PROJECT` defaults. No defaults are
  hardcoded — a missing `JIRA_SITE`/`JIRA_PROJECT` is a hard error.
- `.jira/` is gitignored generated output — safe to delete. Deleting
  `.jira/.state.json` forces a full sync.
- The mirror is one-way (Jira → disk): local edits to `.jira/issues/all/*.md`
  are overwritten on the next sync; the tool never writes to Jira.
- Pruning of deleted issues only happens on `--full` (incremental runs can't
  know what they didn't fetch).

## Notes

- Entry point `src/main.ts`; pipeline: `jira.ts` (REST v3, streaming pages) →
  `adf-to-markdown.ts` → `render.ts` → `sync.ts`; watermark in `state.ts`.
- Categories: `categorize.ts` holds the single `categorizeIssue` function
  (front-matter object + raw body → category strings, `/` = nesting);
  `categories.ts` reconciles it into symlink folders next to `all/`
  (`.jira/issues/status/<status>/<KEY>-<summary>.md`), tracking managed folders
  in `.jira/issues/.categories.json`. Runs on every sync and via
  `deno task categorize` (offline).
- Incremental sync keys off Jira's `updated` timestamps (account timezone), not
  the local clock.
