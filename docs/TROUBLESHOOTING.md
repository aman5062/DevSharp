# Troubleshooting

Start with the two built-in checks:

```bash
devsharp doctor          # or: node /path/to/DevSharp/cli/devsharp.js doctor
```

```text
/devsharp:status         # inside Claude Code
```

`doctor` checks the Node.js version, that the data directory is writable, that
knowledge loads, that the config is valid, whether the plugin is registered in
`~/.claude/plugins/installed_plugins.json`, and that the hook handler
intercepts `/devsharp:*` commands locally.

## No cards appear

Cards appear only **after Claude finishes a turn**, and not after every turn.
Check in this order:

1. **Is it active?** `/devsharp:status` should say `Active: yes` and
   `Snoozed: no`. If not: `/devsharp:enable` (this also ends a snooze).
2. **Frequency.** The default `medium` needs 3 completed turns in the session
   *and* 10 minutes since the last card in any session. `Last card:` in
   `/devsharp:status` shows when the next card is eligible. To test quickly:
   `/devsharp:config set frequency high` and
   `/devsharp:config set minimum_interval 10s`, or just run `/devsharp:next`.
3. **`show_after_prompt`** must be `true` and `frequency` must not be `off`.
4. **Pending answer.** With `reveal: next-turn`, the turn after a Think First
   card shows the answer instead of a new card. That is expected.
5. **Interrupted turns.** Claude Code does not run the `Stop` hook when you
   interrupt Claude (Esc / Ctrl+C), so no card appears on those turns.
6. **Everything used up.** If `/devsharp:next` says "No cards available", every
   eligible card has been dismissed or marked known, or `topics` is too narrow.
   Set `topics` back to `auto` or add a custom pack.
7. **Is the plugin loaded at all?** Run `/devsharp:help`. If you get the
   "hook is not active" line, see the next section. If the command is unknown,
   the plugin is not installed or enabled: check `/plugin`.

## "DevSharp hook is not active — run `devsharp doctor` in a terminal."

The `/devsharp:*` commands are normally answered by DevSharp's
`UserPromptSubmit` hook before Claude sees them. This line means the command
text reached Claude instead, so the hooks are not running. Common causes:

- **The plugin was just installed.** Start a new Claude Code session so the
  hooks are registered.
- **The plugin is disabled.** Enable it in `/plugin`.
- **`node` is not found** by the process that runs the hooks (next section).
- **Hooks are disabled** in your Claude Code settings (for example
  `"disableAllHooks": true`), or your organisation's managed settings only
  allow managed hooks.

Run `claude --debug` to see each hook invocation, its command and its stderr.

## `node` not found

The hooks run `node` from the `PATH` of the process that started Claude Code,
which may differ from your interactive shell.

- **nvm / fnm / volta / asdf.** Version managers often add Node to `PATH` only
  in interactive shells. Start Claude Code from a shell where `node --version`
  works, or install a system Node.js (18 or newer), or make your version
  manager's default Node available in your login profile (e.g.
  `nvm alias default 20` plus loading nvm in `~/.profile` or `~/.zprofile`, not
  only `~/.bashrc`).
- **macOS GUI launchers** may not inherit your shell `PATH`; launch from a
  terminal.
- **Too old.** DevSharp needs Node.js 18+. `devsharp doctor` prints the version
  it runs with.

## Windows

- Hooks are registered in exec form (`"command": "node"` plus an `args` array
  with the script path), so no shell is involved: **Git Bash, WSL or a POSIX
  shell is not required.** Paths with spaces are fine.
- Node.js must be installed and on the system `PATH` (the official installer
  does this). Check with `node --version` in a new PowerShell window.
- Data lives in `%APPDATA%\devsharp` unless `DEVSHARP_HOME` is set.
- If card borders or emoji look wrong in an old console, use Windows Terminal,
  or `/devsharp:config set card_style plain`.

## Cards look misaligned or wrap badly

- The default `rail` style only has a left border, so it survives emoji-width
  differences and re-wrapping. `box` can misalign in terminals that disagree
  about emoji width.
- On narrow windows lower the width: `/devsharp:config set card_width 48`
  (40 to 100).
- Long URLs are hard-broken at the card width; this is intentional.

## "operation blocked by hook" next to command output

Cosmetic. Claude Code labels any `UserPromptSubmit` block this way. Blocking is
precisely how `/devsharp:*` commands avoid being sent to the model.

## Resetting

| Goal | Command |
|------|---------|
| Settings back to defaults | `/devsharp:config reset` |
| Erase learning history (keeps settings) | `/devsharp:reset confirm` |
| Start completely fresh | Close Claude Code and delete the data directory (`~/.config/devsharp`, `%APPDATA%\devsharp` or `$DEVSHARP_HOME`) |
| Force a feed refresh | `/devsharp:update` or `devsharp update` |

## Corrupt files

If `config.json`, `state.json` or a cache file cannot be parsed (for example
after a crash or a bad manual edit), DevSharp renames it to
`<name>.corrupt-<timestamp>` next to the original and continues with defaults.
Nothing blocks the session. You can inspect or delete the `.corrupt-*` files.
An invalid *value* in an otherwise valid `config.json` is reported as a warning
in `/devsharp:status` and `devsharp doctor` and replaced by its default.

## Headless runs and CI

In `claude -p` runs cards appear as informational messages in `stream-json`
output (they still cost no tokens). To keep CI output clean, disable DevSharp
for those runs:

```bash
mkdir -p /tmp/devsharp-ci
echo '{"enabled": false, "updates": false}' > /tmp/devsharp-ci/config.json
DEVSHARP_HOME=/tmp/devsharp-ci claude -p "..."
```

or set `frequency` to `off` in the config used by CI.

## Tech updates never show

- `updates` must be `true` (`/devsharp:config`).
- `/devsharp:status` shows how many headlines are cached and when they were
  refreshed. Run `devsharp update` in a terminal to fetch in the foreground
  and see the result.
- Only headlines from the last 45 days are shown, each at most once.
- With `topics` set to a list, headlines only appear for listed topics or
  categories.
- Corporate proxies: DevSharp uses Node's built-in `fetch`, which by default
  does not use `HTTP(S)_PROXY` environment variables. Behind a mandatory proxy,
  feeds fail quietly and previously cached headlines are kept.

## Debugging

- `claude --debug` shows every hook invocation, its exit code, output and
  stderr. DevSharp writes internal errors to stderr as
  `devsharp: <event>: <stack>` and always exits 0.
- Run the hook by hand:

  ```bash
  echo '{"prompt":"/devsharp:status","session_id":"test","cwd":"'"$PWD"'"}' \
    | node /path/to/DevSharp/src/claude/hook.js prompt
  echo '{"session_id":"test","cwd":"'"$PWD"'"}' \
    | node /path/to/DevSharp/src/claude/hook.js stop
  ```

  The first prints a `{"decision":"block",...}` JSON; the second prints a
  `{"systemMessage":...}` JSON when a card is due, otherwise nothing.
- Use a throwaway data directory to experiment:
  `DEVSHARP_HOME=$(mktemp -d) devsharp next`.

Still stuck? Open an issue at
<https://github.com/aman5062/DevSharp/issues> with the output of
`devsharp doctor`, your OS, Node.js and Claude Code versions.
