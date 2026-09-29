# Changelog

All notable changes to DevSharp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] — 2026-09-29

### Added

- Other AI CLIs: `devsharp setup codex|gemini|opencode` (backs up and merges configs,
  `--remove` undoes it) and `devsharp watch`, a companion pane for any CLI (Freebuff,
  Codebuff, Aider, Copilot CLI, Cursor...). Codex, Gemini and opencode support is untested.

### Changed

- AI cards are on by default. The first card says so once and shows how to turn them off.
- `mid_run_interval` defaults to 1 minute.

## [0.2.0] — 2026-09-29

### Changed

- **Cards now fill the time you spend waiting.** A card appears when you submit a
  prompt, and every `mid_run_interval` (default 3 minutes) during long Claude runs,
  via the PostToolUse hook. The old end-of-turn style is `card_timing: after`.
- **Every card is a complete lesson.** Answers are shown on the card itself
  (`reveal: inline`, the new default), so there is nothing to type.
  `reveal: next-turn` and `reveal: manual` keep the guess-first style.

### Verified

- Prompt-submit and after-tool-call `systemMessage` output is shown to the user and
  is not in Claude's context (resume test, Claude Code 2.1.284).
- The tool-call hook's fast path adds about 5 ms over Node start-up.

## [0.1.1] — 2026-09-29

### Fixed

- The first card ever now appears after your first turn, even when the plugin was
  installed in the middle of a session (previously it waited for 3 turns).

## [0.1.0] — 2026-09-29

First public release.

### Added

- Claude Code plugin using the official plugin system: `plugin.json`,
  synchronous hooks (`SessionStart`, `UserPromptSubmit`, `Stop`,
  `SessionEnd`), `/devsharp:*` commands, and a self-hosted marketplace
  (`/plugin marketplace add aman5062/DevSharp`).
- Learning cards between Claude turns: Quick Fact, Think First, Concept, Why?
  and Tech Update, rendered in `rail`, `box` or `plain` style.
- Zero-token delivery: cards via the `Stop` hook's `systemMessage`, commands
  answered in `UserPromptSubmit` via a block decision; nothing reaches the
  model.
- Think First flow with `/devsharp:reveal` or automatic reveal after the next
  turn (`reveal: next-turn | manual`).
- Commands: `reveal`, `next`, `known`, `dismiss`, `stats`, `status`, `config`,
  `topics`, `snooze`, `enable`, `disable`, `update`, `reset`, `help`.
- Standalone CLI `devsharp` with interactive `next` (Enter / k / d / Esc),
  `doctor` and `statusline`.
- Offline project technology detection from dependency manifests, Dockerfiles,
  compose, CI and infrastructure files, with a 24-hour fingerprinted cache.
- Deterministic selection: mode deficit round-robin, project relevance,
  novelty and repetition decay, adaptive difficulty, topic diversity.
- Bundled, source-backed knowledge packs across 12 categories, with
  `knowledge/index.json` for partial loading at scale.
- Custom knowledge packs (`packs/*.json`) and custom update sources
  (`sources.json`).
- Background refresh of public technology feeds (GitHub releases, RSS, Atom)
  in a detached process with a 25-second hard exit.
- Learning stats and daily streak.
- Security hardening: terminal-escape and bidi sanitisation, https-only
  allow-listed URLs, size and time caps, symlink and path checks on custom
  packs, corrupt-file recovery.

[Unreleased]: https://github.com/aman5062/DevSharp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aman5062/DevSharp/releases/tag/v0.1.0

### Added (0.1.0, same release)

- Opt-in AI cards (`/devsharp:ai on`). After a turn, one budgeted background
  `claude -p --model haiku` call runs with hooks, tools and MCP disabled and no
  persisted session. It turns your filtered, redacted git diff into learning cards
  and summarises real release-note excerpts. Measured cost is about $0.005 per call,
  with defaults of 25 calls/day and at most one per 10 minutes.
- Feed items keep a short plain-text release-notes excerpt; release candidates
  are skipped; at most 20 items per source.
- The hook loads its engine lazily, so ordinary prompts cost only Node start-up.
