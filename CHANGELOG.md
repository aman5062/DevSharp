# Changelog

All notable changes to DevSharp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
