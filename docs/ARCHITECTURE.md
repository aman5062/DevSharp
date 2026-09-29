# DevSharp architecture

DevSharp is a small, dependency-free Node.js program with two thin front ends
(a Claude Code hook adapter and a CLI) around one engine. The engine reads
local JSON files, picks a card deterministically and renders plain text. It
contains no model client and never calls an LLM.

## Overview

```text
 ┌──────────────────────────── Claude Code ─────────────────────────────┐
 │  SessionStart   UserPromptSubmit          Stop            SessionEnd  │
 └───────┬────────────────┬───────────────────┬─────────────────┬───────┘
         │ stdin JSON     │ stdin JSON        │ stdin JSON      │
         ▼                ▼                   ▼                 ▼
 ┌──────────────────── src/claude/hook.js (sync, exit 0) ───────────────┐
 │  prints nothing   /devsharp:* → {"decision":"block",   {"systemMessage":│
 │                    "reason":…,                           "<card>"}      │
 │                    "suppressOriginalPrompt":true}       (or nothing)    │
 │                   anything else → nothing                               │
 └───────┬────────────────┬───────────────────┬─────────────────┬───────┘
         ▼                ▼                   ▼                 ▼
 ┌──────────────────────── src/core/engine.js ──────────────────────────┐
 │ onSessionStart   runCommand(name,args)   onTurnEnd       onSessionEnd │
 │      │                                        │                       │
 │      │     detect.js ─ techmap.js      select.js ─ render.js          │
 │      │     knowledge.js   store.js   config.js   stats.js             │
 └──────┼──────────────────────┬─────────────────────────────────────────┘
        │ spawn detached       │ read / atomic write
        ▼ (only if stale)      ▼
 ┌────────────────────┐   ┌──────────── local files (never uploaded) ─────────┐
 │ src/updates/       │   │ <plugin>/knowledge/**/*.json, index.json (bundled)│
 │   refresh.js       │   │ <plugin>/updates/sources.json          (bundled)  │
 │   (25 s hard exit) │   │ ~/.config/devsharp/config.json                    │
 │   fetch.js         │──▶│                    state.json                     │
 │   parse.js         │   │                    packs/*.json   (your packs)    │
 └─────────┬──────────┘   │                    sources.json   (your feeds)    │
           │ HTTPS GET    │                    cache/updates.json             │
           ▼              │                    cache/projects.json            │
   public feeds           │                    cache/refresh.lock             │
   (GitHub releases API,  └───────────────────────────────────────────────────┘
    official blogs)

 cli/devsharp.js ── same engine, session id "cli", plus doctor / statusline
```

Nothing DevSharp produces enters the model's context:

- `SessionStart` and `UserPromptSubmit` stdout would be injected into Claude's
  context, so the hook prints nothing for them, with one exception: the
  documented block decision for `/devsharp:*` prompts, which stops the prompt
  before any model request.
- `Stop` returns only `systemMessage`, which Claude Code displays to the user.
  It never returns `decision`, `reason` or `additionalContext` (those make
  Claude continue working and spend tokens).
- No hook is `async`: an async hook's `systemMessage` is delivered to Claude.
- Any exception is written to stderr (visible in `claude --debug`) and the hook
  exits 0 with no output, so DevSharp can never break or block a session.

## Lifecycle

```text
user           Claude Code                 hook.js / engine                 disk / network
 │  start          │                              │                               │
 │────────────────▶│ SessionStart ───────────────▶│ load config, state            │
 │                 │                              │ create session entry          │
 │                 │                              │ sinceCard = turns-1           │
 │                 │                              │ warm project detection ──────▶│ cache/projects.json
 │                 │                              │ updates stale? spawn ────────▶│ refresh.js ─▶ feeds
 │                 │◀──────────── (no output) ────│                               │
 │  prompt         │                              │                               │
 │────────────────▶│ UserPromptSubmit ───────────▶│ /devsharp:*?                  │
 │                 │                              │  no  → no output              │
 │                 │                              │  yes → runCommand → block     │
 │◀─ command text ─│◀── {"decision":"block"…} ────│                               │
 │                 │ (model not called)           │                               │
 │                 │ … Claude works …             │                               │
 │                 │ Stop ───────────────────────▶│ turns+=1, sinceCard+=1        │
 │                 │                              │ pending answer & next-turn?   │
 │                 │                              │   → render ANSWER             │
 │                 │                              │ else due & not snoozed?       │
 │                 │                              │   → select + render CARD      │
 │◀── card ────────│◀── {"systemMessage":…} ──────│ save state (atomic) ─────────▶│ state.json
 │  exit           │                              │                               │
 │────────────────▶│ SessionEnd ─────────────────▶│ unrevealed card → "skipped"   │
 │                 │                              │ delete session, prune >24 h   │
 │                 │                              │ stop background refresh       │
```

Details:

- **SessionStart** (`startup|resume|clear`, 5 s timeout). Creates the per
  session record, primes `sinceCard` so the first card can appear after the
  first completed turn, runs project detection once so later `Stop` calls hit
  the cache, and, when `updates` is on and `cache/updates.json` is older than
  `update_refresh_hours`, spawns the background refresher.
- **UserPromptSubmit** (10 s timeout). Matches
  `^\s*/devsharp:([a-z-]{1,20})(?:\s+(.*))?$`. Up to 10 whitespace separated
  arguments are passed to `engine.runCommand`. Commands work even when
  DevSharp is disabled (so `/devsharp:enable` works).
- **Stop** (10 s timeout). Skipped when `stop_hook_active` is set. Returns
  nothing when disabled, when `show_after_prompt` is false or when
  `frequency` is `off`.
- **SessionEnd** (2 s timeout). Records an unanswered pending card as
  `skipped`, deletes the session entry, prunes sessions idle for more than
  24 hours and stops any running background refresh.

### Background refresh

`spawnBackgroundRefresh` starts `node src/updates/refresh.js` detached, with
`stdio: 'ignore'`, and writes `cache/refresh.lock` containing the child's pid.
The child:

- takes the lock (a lock whose pid is alive and younger than 60 s blocks a
  second refresh; an older lock is considered stale),
- fetches all sources with a concurrency of 4,
- writes `cache/updates.json` atomically,
- releases the lock and exits.

A `setTimeout` makes the child exit after **25 seconds** no matter what, and
`SIGTERM` (sent by `SessionEnd`) makes it release the lock and exit. No
DevSharp process outlives that.

Per request: 8 s timeout, 2 MB body cap, at most 5 redirects, each hop
re-checked against the source's host allow-list. A failed source keeps its
previously cached headlines, so going offline never empties the cache. At most
50 sources and 200 cached headlines.

## Module map

| Module | Responsibility |
|--------|----------------|
| `src/claude/hook.js` | Hook adapter. `node hook.js <session-start\|prompt\|stop\|session-end>`. Parses stdin (capped at 1 MB), maps events to engine calls, emits only zero-token JSON. |
| `cli/devsharp.js` | CLI adapter. Same commands (session id `cli`), coloured output on a TTY (respects `NO_COLOR`), interactive `next`, `doctor`, `statusline`, `--version`. |
| `src/core/engine.js` | Cadence, pending card / reveal flow, all commands. Knows nothing about Claude Code. |
| `src/core/config.js` | Defaults, validation and coercion of every key, cadence table, duration parsing. |
| `src/core/store.js` | `state.json`: per-item progress, capped event log, sessions, active days. |
| `src/core/knowledge.js` | Loads and validates bundled and custom packs; index-based partial loading. |
| `src/core/select.js` | Mode choice and scoring. Deterministic. |
| `src/core/render.js` | Plain-text card rendering (`rail`, `box`, `plain`), display-width aware wrapping. |
| `src/core/stats.js` | Stats and streak derived from local history. |
| `src/core/detect.js`, `techmap.js` | Offline project technology detection and the dependency → topic map. |
| `src/core/sanitize.js` | `cleanText` / `cleanUrl`: the single gate for everything displayed. |
| `src/core/fsutil.js` | JSON read with corrupt-file quarantine, atomic write, `isInside` path check. |
| `src/core/paths.js` | Data directory resolution. |
| `src/updates/index.js` | Source loading and validation, cache, refresh, lock, background spawn. |
| `src/updates/fetch.js` | Locked-down HTTPS GET with manual redirect checks, size cap and timeout. |
| `src/updates/parse.js` | Dependency-free RSS 2.0 / Atom / GitHub releases parsers. |
| `src/updates/refresh.js` | The detached refresher process. |

## Cadence

Cards are shown after Claude finishes a turn, never mid-turn. On each `Stop`:

1. If the pending card has a hidden answer, it has not been revealed,
   `reveal` is `next-turn`, and at least one more turn has completed, the
   **answer** is shown. No new card is shown on that turn.
2. Otherwise, if not snoozed, a new card is shown when **both** of these hold:
   - `sinceCard >= turns` (turns completed in *this* session since its last card), and
   - `now - lastShownAt >= interval` (time since the last card in *any* session).

| `frequency` | turns | minimum interval |
|-------------|-------|------------------|
| `off` | never | never |
| `low` | 5 | 30 min |
| `medium` (default) | 3 | 10 min |
| `high` | 1 | 3 min |

`minimum_interval` overrides the time part. Because the interval is global,
several parallel Claude sessions do not multiply the number of cards.

When a new card replaces an unrevealed question, the old one is recorded as
`skipped`.

## Selection algorithm

`src/core/select.js` is deterministic: the same history, project, config and
seed always pick the same card. The seed is
`<session id>|<local date>|<number of events>`, so it changes after every card.

### 1. Candidate pools and exclusions

Items are grouped into five pools by type: `fact`, `think`, `concept`, `why`,
`update`. Excluded:

- items you dismissed or marked known,
- items outside your interests when `topics` is a list (an item passes when its
  topic *or* its category is in the list; items from your custom packs always
  pass),
- tech-update headlines already shown once,
- headlines published more than 45 days ago,
- all headlines when `updates` is off.

### 2. Mode (card type)

If a specific type was requested (`/devsharp:next think`) and is available, it
is used. If `mode` is not `mixed`, that type is used when available, otherwise
the first available type in the order think, fact, concept, why, update.

In `mixed` mode DevSharp uses **deficit round-robin** over the last 20 cards.
Target shares:

| think | fact | concept | why | update |
|-------|------|---------|-----|--------|
| 0.35 | 0.25 | 0.20 | 0.10 | 0.10 |

A share is set to 0 when `think_first` is off (think), when `updates` is off
(update), or when the pool is empty; the rest are renormalised. For each mode:

```text
deficit(m) = share(m) / Σshares × (recent + 1) − count of m in recent
```

The mode with the largest deficit wins (ties go to the earlier mode in the
order above). A mode is never chosen three times in a row if another mode is
available.

### 3. Scoring within the chosen pool

```text
score = relevance + novelty + difficulty fit + diversity + custom bonus + tie-break
```

| Component | Rule |
|-----------|------|
| Project relevance | `+45 × weight` when the item's topic was detected in the project (weight 0..1) |
| Tag relevance | `+10` per item tag that is a detected topic, capped at `+20` |
| Novelty | never shown: `+25` |
| Repetition decay | shown before: `−(80 × e^(−days/21) + 5 × timesShown + 10 if revealed)` |
| Difficulty fit (knowledge items) | `+12` exact match, `+4` one level off, `−8` two levels off |
| Freshness (updates) | `+20` if published within 7 days, `+10` within 30 days |
| Same topic as last card | `−30` |
| Same category as last card (other topic) | `−6` |
| Topic in the last 6 cards | `−12` per occurrence, capped at `−30` |
| Custom pack item | `+5` |
| Tie-break | `hash32(seed + id) mod 8` (FNV-1a) |

Highest score wins; an exact tie goes to the lexicographically smaller id.

**Difficulty target.** With `difficulty: adaptive` the target for a topic is
*easy* until you have seen 3 cards of it, *hard* once you have marked 3 of its
cards known, and *medium* otherwise. A fixed `difficulty` sets the target for
every topic.

**Repetition.** The decay penalty is about −80 right after a card is shown and
fades with a 21-day time constant, so an old card can come back after weeks,
but only once the fresh ones are used up. Known and dismissed cards never
return.

### Project detection

`detect.js` reads a fixed set of small manifests (e.g. `package.json`,
lockfiles, `tsconfig.json`, `pyproject.toml`, `requirements*.txt`, `go.mod`,
`Cargo.toml`, `pom.xml`, Gradle files, Dockerfiles, compose files, CI files,
small Kubernetes YAML, `*.tf`) plus a bounded file-extension census. Signal
strengths: dependency 1.0, container image 0.9, config file 0.8, extension
census up to 0.7. It also looks one level into conventional monorepo and
sub-project folders (`apps/`, `packages/`, `services/`, `backend/`, `web/`, ...).
It never reads source code, README files, `.env` or secret-looking files.
Results are cached per project root in `cache/projects.json` for 24 hours,
keyed by a manifest fingerprint (so editing `package.json` invalidates it),
with at most 50 projects kept.

## Data files and their bounds

| File | Contents | Bound |
|------|----------|-------|
| `config.json` | Only the keys you changed | tiny |
| `state.json` | `items` (per-item progress), `events` (log), `sessions`, `days`, `lastShownAt`, `snoozeUntil` | events capped at 3000, days at 400, sessions pruned after 24 h idle |
| `cache/updates.json` | Validated headlines + per-source status | 200 items, max 20 per source, release-candidate tags skipped |
| `cache/projects.json` | Detection results | 50 projects, 24 h TTL |
| `cache/refresh.lock` | `{pid, startedAt}` of a running refresh | removed on exit |

All writes are atomic (temp file + rename, mode `0600`). Several Claude
sessions may share `state.json`; a lost update in a race costs at most one
history event. A file that fails to parse is renamed to
`<name>.corrupt-<timestamp>` and replaced by defaults, so a bad write can never
wedge the hooks.

## Scaling the knowledge base

`scripts/build-index.js` generates `knowledge/index.json`, listing every pack
with its file, topic, category and item count, plus the total.

- While the catalogue has at most **5000** items (`LOAD_ALL_LIMIT`), every pack
  is loaded (a few milliseconds).
- Above that, only packs whose topic or category is relevant right now
  (detected in the project or listed in `topics`) are loaded, plus **6**
  exploration packs chosen by a hash of the current date, so exploration
  rotates daily. Per-card cost stays flat as the catalogue grows.
- Without an index (during development), the `knowledge/` tree is scanned.

Custom packs from `packs/` are always loaded after the bundled packs. When two
items share an id, the first definition wins, so a custom pack cannot replace a
bundled card.

## Why these choices

- **Hooks, not an MCP server or a model call.** The requirement is zero
  tokens. The `Stop` hook's `systemMessage` and the `UserPromptSubmit` block
  decision are the documented outputs that reach the user without reaching
  the model.
- **Synchronous hooks.** Async hook output is delivered to Claude. The work
  per hook is a few file reads, so blocking is cheap; anything slow (network)
  runs in the detached refresher.
- **JSON files, not SQLite.** Zero dependencies was a hard rule, Node 18 has no
  built-in SQLite, and the data is small and bounded (event log capped at
  3000, one entry per item, sessions pruned after 24 h). Atomic rename gives
  crash safety without a database.
- **Deterministic selection.** No `Math.random()`: behaviour is reproducible
  in tests and explainable ("new to you", "project uses postgresql").
- **Plain-text rendering, rail style.** Claude Code renders the message, so
  DevSharp emits no ANSI. A left rail cannot be misaligned by emoji width
  differences between terminals and survives re-wrapping on narrow windows.
- **Data-only content.** Cards are validated JSON, never code, so community
  packs and feeds cannot execute anything.

## Optional AI cards (`src/ai/`)

```text
Stop hook ──(ai on, under budget, interval elapsed)──► detached node src/ai/worker.js
                                                          │  lock, count call first
                                                          │  git diff (filtered, redacted, <=5 KB)
                                                          │  + <=3 release-note excerpts (1 per project)
                                                          ▼
                                             claude -p --model haiku  (no tools/hooks/MCP,
                                             MAX_THINKING_TOKENS=0, $0.05 cap, not persisted)
                                                          │  JSON → validate → sanitise
                                                          ▼
                                              cache/ai.json  (cards TTL 7 d, notes)
                                                          │
Stop hook (later) ── selectCard: AI cards +35, shown once ─┘  → systemMessage (zero-token display)
```

Disabling thinking was measured to cut a diff-based call from 34 s / $0.019 to
about 10 s / $0.005. `--bare` is not used because it disables OAuth, which would
lock out subscription logins.
