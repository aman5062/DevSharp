# DevSharp

**Keep learning while AI helps you code.**

DevSharp is not another AI coding assistant. It is a small Claude Code plugin
(and standalone CLI) that shows a short technology learning card between Claude
turns: a quick fact, a question to think about, a concept, a "why does it work
like this?", or a headline from a project you depend on.

Its core never calls a language model and adds **zero tokens** to your Claude usage.
Optionally, you can turn on [AI cards](#ai-cards-from-your-own-code-opt-in) that teach the concepts in *your own* latest edits, using a small, budgeted Haiku call that never touches your conversation.

> **Think → Learn → Code.** While the AI writes the code, you keep the
> understanding.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-green.svg)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

---

## What it looks like

After Claude finishes a turn, DevSharp may print a card like this (Claude Code
shows it as a message to you; the model never sees it):

```text
╭─ 🧠 THINK FIRST · HTTP
│
│  no-cache that still caches
│
│  An API response has Cache-Control: no-cache. The browser
│  keeps the response, but sends a request every time and gets
│  304 Not Modified back. Is caching broken?
│
│  💭 Think it through first. /devsharp:reveal shows the answer
│  (or wait: it appears after your next turn).
│
╰─ RFC 9111 §5.2.2.4 · https://www.rfc-editor.org/rfc/rfc9111
```

After your next turn (or when you type `/devsharp:reveal`) the answer follows:

```text
╭─ 💡 ANSWER · HTTP
│
│  no-cache that still caches
│
│  Q: An API response has Cache-Control: no-cache. The browser
│  keeps the response, but sends a request every time and gets
│  304 Not Modified back. Is caching broken?
│
│  No. no-cache means the response may be stored but must be
│  revalidated with the origin before every reuse; a 304 is
│  that revalidation succeeding. If the response must never be
│  stored at all, the directive you want is no-store.
│
│  Knew it? /devsharp:known · Not for you? /devsharp:dismiss
│
╰─ RFC 9111 §5.2.2.4 · https://www.rfc-editor.org/rfc/rfc9111
```

Card types:

| Card | What it is |
|------|------------|
| ⚡ **Quick Fact** | One to three sentences you can absorb in a few seconds. |
| 🧠 **Think First** | A small scenario to reason about. The answer is hidden until you ask for it or finish another turn. |
| 📘 **Concept** | A short explanation of an idea, sometimes with a "Think:" prompt. |
| ❓ **Why?** | "Why does X behave like this?", with a hidden answer. |
| 📰 **Tech Update** | A release or blog headline from a public feed, shown as-is (never summarised by AI). |

Every bundled card cites a primary source (official docs, a spec or an RFC).
Cards lean towards the technologies DevSharp detects in your current project
(`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, Dockerfiles, compose
files, CI config and so on), then branch out so you keep exploring.

## Why

AI assistants are great at producing code. They are less good at leaving you
understanding it. The pause while Claude works is dead time; DevSharp fills
it with something small and worth knowing: 20 seconds, no context switch, no
extra cost.

- **Not an assistant.** DevSharp has no model client. The cards are
  hand-written, source-backed data files.
- **Zero tokens.** Nothing DevSharp shows or does is sent to Claude.
- **Offline-first.** Everything works without a network. Tech Update headlines
  are refreshed in the background when you are online.
- **Private.** No telemetry, no accounts. Nothing is uploaded unless you turn on AI cards, which send a filtered, redacted diff to the same Claude account you already code with.
- **Quiet.** Medium frequency means at most one card every 3 turns and 10
  minutes. It can be snoozed, tuned or turned off.

## The zero-token guarantee

DevSharp uses only Claude Code hook outputs that do not reach the model:

| Hook | What DevSharp does | Why it costs nothing |
|------|--------------------|----------------------|
| `Stop` (synchronous) | Returns `{"systemMessage": "<card>"}` | Claude Code shows `systemMessage` to the user and does not send it to the model. |
| `UserPromptSubmit` | For `/devsharp:*` only, returns `{"decision":"block","reason":"<output>","suppressOriginalPrompt":true}` | The prompt is blocked before any model request; Claude Code shows `reason` to you. |
| `SessionStart` | Prints nothing | Stdout from this hook would be added to Claude's context, so there is none. |
| `SessionEnd` | Prints nothing | Cleanup only. |

DevSharp never uses `async` hooks (an async hook's `systemMessage` *is*
delivered to Claude) and never returns `decision`, `reason` or
`additionalContext` from `Stop` (those would make Claude continue).

**How it was verified** (Claude Code 2.1.284):

- **Cards are invisible to the model.** After a card was shown, a resumed
  session asked Claude to search its whole context for the card's text. Result:
  `NOTFOUND`.
- **Commands cost nothing.** A blocked slash command run headless
  (`claude -p "/probe:ping"`, the same mechanism DevSharp uses) reported
  `num_turns: 0`, `total_cost_usd: 0` and zero input/output/cache tokens.

The files in `commands/*.md` exist so Claude Code lists `/devsharp:*` in its
command menu. Their bodies are only a fallback: if the hook is not running, the
command text reaches Claude, which replies with a one-line "DevSharp hook is
not active" message (see [Troubleshooting](docs/TROUBLESHOOTING.md)).

## AI cards from your own code (opt-in)

Static packs cannot know what *you* just wrote. Turn on AI cards and DevSharp also
teaches the concepts behind your latest edits, and summarises real release notes
for the technologies your project uses:

```text
/devsharp:ai on      # enable (off by default)
/devsharp:ai         # status: calls used today, last cost, cards waiting
/devsharp:ai now     # generate right away
```

How it works:

- After a Claude turn, DevSharp may start **one background job**. It takes your
  `git diff HEAD` (or the last commit if it is under 6 h old), filtered and
  capped at 5 KB, plus up to three release-note excerpts from the feeds.
- It sends them to a small model (`haiku` by default) through **your own
  `claude` CLI login**, in a separate, non-persisted process: hooks disabled,
  no tools, no MCP, a fixed system prompt, and a $0.05 cap per call.
- The model's JSON reply is validated and sanitised, then cached. The card appears
  later through the normal zero-token display, marked `✨ from your code`. Update
  cards gain an `✨ In short:` line summarised **only from the real release notes**,
  never guessed from a title.

What gets sent: changed hunks only. `.env*`, keys and certificates, lockfiles,
minified, vendored and generated files, and binaries are never included.
Secret-looking values (AWS/GitHub/Slack/OpenAI-style keys, JWTs, passwords, URL
credentials, long hex/base64 strings) are replaced with `<redacted>`.

Measured cost (Claude Code 2.1.284, Haiku 4.5, thinking disabled): a diff-based
call is ~2.7k input + ~0.5k output tokens, ~10 s in the background, **~$0.005 at
list price**. A headlines-only call is ~$0.002. The default budget is 25 calls/day
and at most one per 10 minutes (`ai_daily_limit`, `ai_min_interval`). A failed call
still counts, so errors can never loop. Your conversation's context is untouched
either way.

## Install

Requires **Node.js 18 or newer** on your `PATH` (the hooks run `node`).
DevSharp has no npm dependencies.

### Claude Code plugin (recommended)

This repository is its own plugin marketplace. Inside Claude Code:

```text
/plugin marketplace add aman5062/DevSharp
/plugin install devsharp@devsharp
```

Restart Claude Code (or start a new session), then run `/devsharp:status`.

### Local checkout (development)

```bash
git clone https://github.com/aman5062/DevSharp.git
claude --plugin-dir /path/to/DevSharp
```

### Standalone CLI

The same cards work without Claude Code, for example in a separate terminal
pane next to any AI tool:

```bash
npm install -g github:aman5062/DevSharp   # or: node /path/to/DevSharp/cli/devsharp.js
devsharp next
```

`devsharp next` is fully interactive: **Enter** reveals the answer, **k**
marks the card known, **d** dismisses it, **Esc** or **q** closes it.

The plugin and the CLI share the same data directory, so your history,
settings and streak are the same in both.

## Usage

Inside Claude Code every command is `/devsharp:<name>`. In a terminal it is
`devsharp <name>`.

| Command | What it does |
|---------|--------------|
| `reveal` | Show the answer to the current Think First / Why card |
| `next [fact\|think\|concept\|why\|update]` | Show a card right now, optionally of one type |
| `known` | Mark the current card as known (it will not come back) |
| `dismiss` | Never show the current card again |
| `stats` | Your learning statistics: cards seen, answers revealed, streak, strong areas |
| `status` | Whether DevSharp is active, what it detected, when the next card is due |
| `config` | Show settings. `config set <key> <value>`, `config reset` |
| `topics` | Technologies detected in the current project, with evidence |
| `snooze [30m\|2h\|1d]` | Pause cards for a while (default 1h) |
| `enable` / `disable` | Turn DevSharp on or off (enable also ends a snooze) |
| `update` | Refresh technology-update feeds now |
| `ai [on\|off\|now]` | Opt-in AI cards from your recent code changes; no argument shows status and budget |
| `reset confirm` | Erase learning history (settings are kept) |
| `help` | List the commands |
| `doctor` *(CLI only)* | Check Node version, data directory, knowledge, config, plugin install and hook handler |
| `statusline` *(CLI only)* | One-line teaser for Claude Code's `statusLine` (see below) |

Examples:

```text
/devsharp:next think
/devsharp:config set frequency low
/devsharp:config set topics databases,security,docker
/devsharp:snooze 2h
```

### Optional status line teaser

Plugins cannot set Claude Code's main status line, so this is a manual,
optional step. With the CLI on your `PATH` (`npm i -g github:aman5062/DevSharp`), add to
`~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "devsharp statusline" }
}
```

Without a global install, use `"command": "node /path/to/DevSharp/cli/devsharp.js statusline"`.
It shows the title of an unanswered Think First card (`🧠 <title> · /devsharp:reveal`)
or your streak (`🎯 DevSharp · 5-day streak`).

## Configuration

Settings live in `config.json` in the data directory and can be changed with
`/devsharp:config set <key> <value>`. Invalid values fall back to defaults and
are reported by `/devsharp:status` and `devsharp doctor`; a bad config never
breaks a session.

| Key | Default | Values |
|-----|---------|--------|
| `enabled` | `true` | Master switch |
| `frequency` | `medium` | `off`, `low` (5 turns / 30 min), `medium` (3 turns / 10 min), `high` (1 turn / 3 min) |
| `mode` | `mixed` | `mixed`, `fact`, `think`, `concept`, `why`, `update` |
| `show_after_prompt` | `true` | Show cards automatically after Claude's turns |
| `minimum_interval` | `auto` | `auto` or a duration such as `10m`, `1h` |
| `topics` | `auto` | `auto`, or a comma list of categories/topics |
| `difficulty` | `adaptive` | `adaptive`, `easy`, `medium`, `hard` |
| `updates` | `true` | Background refresh of public tech-update feeds |
| `update_refresh_hours` | `24` | 1 to 168 |
| `think_first` | `true` | Include Think First questions in the mix |
| `reveal` | `next-turn` | `next-turn` (auto-reveal after your next turn) or `manual` |
| `project_awareness` | `true` | Prioritise technologies detected in the project |
| `card_style` | `rail` | `rail`, `box`, `plain` |
| `card_width` | `64` | 40 to 100 columns |
| `telemetry` | `false` | Always false; it cannot be turned on |
| `ai` | `false` | Opt-in AI cards (see above) |
| `ai_model` | `haiku` | Model alias passed to `claude --model` |
| `ai_daily_limit` | `25` | 1 to 100 calls per day |
| `ai_min_interval` | `10m` | Minimum time between AI calls (>= 1m) |

Full reference, custom knowledge packs and custom update sources:
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Where data lives

| Platform | Directory |
|----------|-----------|
| Linux / macOS | `$XDG_CONFIG_HOME/devsharp` (default `~/.config/devsharp`) |
| Windows | `%APPDATA%\devsharp` |
| Any | `$DEVSHARP_HOME` overrides both |

It contains `config.json`, `state.json` (your history), `packs/` (your own
knowledge packs), `sources.json` (your own update feeds) and `cache/`.

## Privacy

- **No telemetry.** There is no analytics code and nothing to switch on.
- **Nothing is uploaded.** Your history, config and project information stay
  in local JSON files.
- **Project detection is local and narrow.** It reads dependency manifests and
  config files, never source code, never `.env` or secret-looking files, and
  never follows symlinks out of the project.
- **The only network traffic** is plain HTTPS `GET` requests to public release
  and blog feeds (GitHub releases API, official project blogs), sent with the
  User-Agent `devsharp (+https://github.com/aman5062/DevSharp)` and no cookies,
  credentials or local data. Set `updates` to `false` and DevSharp makes no
  network requests at all.

## Limitations

Honest notes about what a Claude Code plugin can and cannot do:

- **Cards stay in scrollback.** Hooks cannot draw overlays or capture
  keystrokes inside Claude Code's UI, so a card cannot disappear when your next
  prompt starts. It stays in the transcript like any other message.
- **No "press Enter to reveal" inside Claude Code.** Use `/devsharp:reveal`, or
  let the answer appear after your next turn (`reveal: next-turn`, the
  default). For real Enter / k / d / Esc interaction, run `devsharp next` in a
  separate terminal pane.
- **Commands look "blocked".** Claude Code labels the output of a
  `UserPromptSubmit` block as a blocked prompt ("operation blocked by hook").
  That is cosmetic: it is exactly the mechanism that keeps commands at zero
  tokens.
- **The status line is manual.** Plugins cannot set the main `statusLine`; see
  above.
- **No card after an interrupt.** Claude Code does not fire `Stop` when you
  interrupt a turn, so no card appears then.
- **Headless runs.** In `claude -p` runs, cards appear as informational
  messages in `stream-json` output. For CI, set `frequency` to `off` or point
  `DEVSHARP_HOME` at a directory whose config disables DevSharp.
- **Node.js must be on `PATH`** for the process that launches Claude Code.

## Performance

Measured on Linux (AMD EPYC, Node 22), `npm run bench`, 30 runs each:

| Hook | Wall p50 / p95 | CPU | Peak RSS |
|------|----------------|-----|----------|
| bare `node -e 0` (baseline) | 49 / 69 ms | n/a | n/a |
| UserPromptSubmit, ordinary prompt | 55 / 84 ms | ~20 ms | 44 MB |
| UserPromptSubmit, `/devsharp:stats` | 105 / 177 ms | ~50 ms | 57 MB |
| Stop, card shown | 106 / 142 ms | ~50 ms | 56 MB |
| SessionStart / SessionEnd | 84-96 / 111-137 ms | ~40 ms | 53 MB |

- **Ordinary prompts pay only Node start-up.** The engine loads lazily, and only
  for `/devsharp:*` commands.
- **Idle cost is zero.** Hooks are short-lived processes, so nothing stays
  resident between turns.
- **Background work is bounded.** The feed refresh is a detached process that
  exits within 25 s (about 1.5 s in practice), and the optional AI job is capped
  at 2 minutes.
- **Disk:** about 400 KB of knowledge. State is about 10 KB after 150 hook calls
  and is capped at 3000 events.
- **Network:** with `updates` on, about 14 small HTTPS GETs once every 24 h, and
  none otherwise.

End-to-end verification (`npm run verify:zero-tokens -- --full`) on Claude Code 2.1.284:

- Every `/devsharp:*` command runs with 0 turns, $0 and 0 tokens.
- A session's context is **23,984 tokens with and without the plugin**.
- After a card is shown, a resumed session asked to find its title answers
  `NOTFOUND`.


## Documentation

- [Architecture](docs/ARCHITECTURE.md): hooks, lifecycle, selection algorithm, scaling
- [Configuration](docs/CONFIGURATION.md): every setting, custom packs, custom feeds
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Publishing a release](docs/PUBLISHING.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE) © 2026 Aman
