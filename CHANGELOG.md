# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Index page links pointed one directory too high.

## [0.3.0] - 2026-11-05

### Added

- `push`, which sends local edits back to Jira.
- New issues: write a `# Heading` and `push` creates it.
- `status`, an offline report of local edits.
- `--dir`, which points the mirror somewhere else.

### Changed

- `pull` merges instead of overwriting.
- `children` lists every child, not just sub-tasks.

## [0.2.0] - 2026-10-08

### Added

- `install.sh` and `jira-local upgrade`.

### Changed

- Progress is now coloured task lines, with `--no-color`.
- `categorize` reads the files on disk, so categories are current.

### Removed

- `--out`.

## [0.1.2] - 2026-10-06

### Changed

- Symlinked category folders are gone. Every category is an index page now.
- No `Deno.*` globals.

## [0.1.1] - 2026-09-17

### Added

- `pull` mirrors a Jira project to markdown files.
- Categories, index pages, `.jira/.config.ts` and `init`.
- Published to JSR, as a compiled binary, and as a Homebrew formula.

[Unreleased]: https://github.com/jollytoad/jira-local/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jollytoad/jira-local/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jollytoad/jira-local/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/jollytoad/jira-local/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jollytoad/jira-local/releases/tag/v0.1.1
