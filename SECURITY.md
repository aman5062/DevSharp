# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/aman5062/DevSharp/security/advisories/new)
("Report a vulnerability"). Do not open a public issue.

Include the version, your OS and Node.js version, and steps or a proof of
concept. You should get a first response within a few days. Fixes are
released as a patch version and credited in the changelog unless you prefer
otherwise.

Supported versions: the latest release.

## What DevSharp does on your machine

- Runs four **synchronous** Claude Code hooks: `node src/claude/hook.js
  <event>` for `SessionStart`, `UserPromptSubmit`, `Stop` and `SessionEnd`.
- Reads and writes JSON files in its own data directory
  (`~/.config/devsharp`, `%APPDATA%\devsharp` or `$DEVSHARP_HOME`), with file
  mode `0600` and atomic renames.
- Reads a fixed set of dependency manifests in the current project to detect
  technologies (never source code, never `.env` or secret-looking files such
  as `*.pem`, `*.key`, `.npmrc`, `.netrc`).
- Optionally (`updates: true`, the default) starts a short-lived detached Node
  process that makes HTTPS `GET` requests to public feeds and exits within
  25 seconds.
- Never executes, evaluates or imports content. Knowledge packs, feeds and
  caches are data only.
- Has no telemetry and no model client.

## Threat model

### Untrusted inputs

| Input | Who controls it |
|-------|-----------------|
| Feed and GitHub API responses | Remote servers, and anyone who can tamper with them |
| Custom update sources (`sources.json`) | The local user (or anything that can write to their config) |
| Custom knowledge packs (`packs/*.json`) | The local user, or whoever wrote a pack they downloaded |
| Cache and state files | Any local process running as the user |
| Hook stdin | Claude Code |

All of these are treated as untrusted and validated every time they are read,
including DevSharp's own cache files.

### Terminal injection

Card text is displayed in the user's terminal, so hostile text could try to
move the cursor, recolour or retitle the terminal, write the clipboard (OSC
52), create deceptive hyperlinks (OSC 8) or visually reorder text ("Trojan
Source"). Every string DevSharp displays passes through `cleanText`
(`src/core/sanitize.js`), which:

- removes ESC-introduced sequences (CSI, OSC terminated by BEL or ST, DCS, SOS,
  PM, APC and two-byte escapes),
- removes the remaining C0 and C1 control characters (including 8-bit CSI/OSC)
  except newline and tab,
- removes bidi overrides and isolates, zero-width and other invisible
  formatting characters (ZWJ is kept for emoji),
- normalises to NFC and caps length.

Card rendering emits no ANSI of its own; the CLI adds colour only to its own
frame characters on a TTY.

### URLs and network

- `cleanUrl` accepts only `https:` URLs up to 500 characters, with no
  credentials, no raw IP addresses and no `localhost`.
- Each source has a host allow-list: GitHub sources may only reach
  `api.github.com` / `github.com`; feeds may only reach the feed's own host
  plus up to 10 explicitly listed `allow_hosts`. Item links outside the
  allow-list are dropped.
- Redirects are followed manually (at most 5), and every hop is checked
  against the allow-list.
- Requests send only the URL and the User-Agent
  `devsharp (+https://github.com/aman5062/DevSharp)`: no cookies, no
  credentials, no referrer, no local or project data.
- Limits: 8 s per request, 2 MB per response (checked from `Content-Length`
  and while streaming), 50 items parsed per feed, 50 sources, 200 cached
  headlines, 25 s total lifetime for the refresh process.
- Feeds are parsed by small hand-written string parsers (no XML entity
  expansion, no DTDs, single-pass entity decoding), so XXE and
  entity-expansion attacks do not apply.

### Custom packs and path safety

- Only files named `[A-Za-z0-9._-]+.json` directly inside `packs/` are read.
- Each is checked with `lstat`: symlinks and non-regular files are ignored,
  files over 2 MB are skipped, and the resolved path must be inside the packs
  directory.
- Bundled pack paths from `index.json` containing `..` are rejected.
- Every item is schema-validated and sanitised; invalid items are dropped.
  An item whose id already exists in a bundled pack is ignored, so a custom
  pack cannot replace a bundled card.
- Project detection does not follow symlinks out of the project.

### Prompt injection

Feed headlines and pack text are shown to **you**, never to Claude:

- The only hook output that carries content is the `Stop` hook's
  `systemMessage`, which Claude Code displays to the user and does not send
  to the model.
- `/devsharp:*` command output is returned as a `UserPromptSubmit` block
  `reason`, which is shown to the user; the prompt never reaches the model.
- `SessionStart` and `UserPromptSubmit` print nothing to stdout (which would
  enter Claude's context), and no hook is `async`.

So a malicious headline cannot instruct Claude to do anything. This was
verified empirically: after a card was shown, a resumed session could not find
the card's text anywhere in its context.

### Robustness

- Hooks catch every error, log it to stderr and exit 0 with no output; they
  cannot block or break a Claude Code session.
- Hook stdin is capped at 1 MB.
- Corrupt JSON files are moved aside and replaced by defaults.
- `telemetry` cannot be enabled; there is no code that could send it.

## Out of scope

- An attacker who can already write to your home directory or your Node.js
  installation.
- The content of third-party feeds beyond what is displayed: headlines are
  shown as-is with a link; opening the link is your choice.

## Optional AI cards: data egress

With `ai` off (the default), DevSharp sends nothing to any model. With `ai` on:

- **What is sent.** Changed diff hunks, capped at 5 KB, go to the model through the
  user's own `claude` CLI login, the same provider their code already goes to.
  `.env*`, keys and certificates, lockfiles, generated, minified and vendored files,
  and binaries are excluded. Secret-looking values are redacted before sending
  (`src/ai/diff.js`, tested in `test/ai.test.js`).
- **Isolation.** The call is a separate `claude -p` process run with
  `--tools ""`, `--setting-sources ""`, `disableAllHooks`, `--strict-mcp-config`,
  `--no-session-persistence` and `--max-budget-usd 0.05`, plus `DEVSHARP_DISABLE=1`
  to prevent recursion. The model can take no actions.
- **Untrusted input.** The diff and feed excerpts are fenced and labelled
  untrusted in the prompt.
- **Untrusted output.** The reply is parsed as JSON, validated against the card
  schema, sanitised, and only ever displayed. It never reaches the user's Claude
  conversation.
