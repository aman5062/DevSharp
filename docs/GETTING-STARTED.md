# Getting started with DevSharp

DevSharp shows you a short, useful tech lesson while Claude Code works for you:
a quick fact, a small question to think about, or a release headline for the tools
your project uses. It costs nothing extra and needs no account.

This guide takes about 3 minutes.

---

## 1. Before you start

You need two things. You probably have both already.

| You need | Check it | Get it |
|----------|----------|--------|
| **Claude Code** | Run `claude --version` in a terminal | https://claude.com/claude-code |
| **Node.js 18 or newer** | Run `node --version` (should print v18 or higher) | https://nodejs.org (the "LTS" download) |

---

## 2. Install (pick ONE way)

### Option A: one command in your terminal (easiest)

**macOS / Linux**, paste into your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/aman5062/DevSharp/main/install.sh | bash
```

**Windows**, paste into PowerShell:

```powershell
irm https://raw.githubusercontent.com/aman5062/DevSharp/main/install.ps1 | iex
```

The script checks that Claude Code and Node.js are there, then runs the two
official Claude Code plugin commands for you. It is safe to run again. You can read
it first: [install.sh](../install.sh), [install.ps1](../install.ps1).

Prefer not to pipe a script? Run the same two commands yourself:

```bash
claude plugin marketplace add aman5062/DevSharp
claude plugin install devsharp@devsharp
```

### Option B: from inside Claude Code

Start `claude`, then type these two lines, one at a time:

```text
/plugin marketplace add aman5062/DevSharp
/plugin install devsharp@devsharp
```

> **"Marketplace not found"?** Run the first line before the second. The first
> line tells Claude Code where DevSharp lives; the second installs it.

You can also click through it: type `/plugin`, open **Marketplaces**, choose
**Add**, enter `aman5062/DevSharp`, then open **Discover**, pick **DevSharp** and
choose **Install**.

### Option C: for a whole team, automatically

Add this to your project's `.claude/settings.json` and commit it:

```json
{
  "extraKnownMarketplaces": {
    "devsharp": { "source": { "source": "github", "repo": "aman5062/DevSharp" } }
  },
  "enabledPlugins": { "devsharp@devsharp": true }
}
```

Anyone who opens the project in Claude Code and trusts the folder is offered
DevSharp. Nobody has to type an install command.

---

## 3. Check that it works

**Restart Claude Code** (quit and run `claude` again), then type:

```text
/devsharp:status
```

You should see `Active: yes`. Then ask for your first card:

```text
/devsharp:next
```

---

## 4. Everyday use: you don't have to do anything

Just use Claude Code as usual. **While you wait for Claude**, a card appears: right
after you send a prompt, and every 3 minutes while Claude keeps working on a long task.
Each card is a complete lesson, with the answer included, so there is nothing to type:

```text
╭─ 🧠 THINK FIRST · PostgreSQL
│
│  The job that ran twice
│
│  A billing job charged a customer twice after a worker restarted
│  mid-job. The queue delivers at least once. What should the job
│  handler do so a redelivery is harmless?
│
│  💡 Make the handler idempotent: store the job id with the
│  charge in the same transaction and skip work when it exists.
╰─ PostgreSQL Documentation · https://www.postgresql.org/docs/
```

What to do with it:

- **Just read it.** That's the whole idea: 20 seconds of learning while Claude works.
  You never need to type anything.
- **Already knew it?** Type `/devsharp:known` and it won't come back.
- **Not interested?** Type `/devsharp:dismiss`.

Cards lean towards what your project actually uses. In a Next.js + Prisma project
you'll see React, Next.js, Prisma, Node.js and SQL cards first.

---

## 5. Commands you'll actually use

Type `/devsharp:` in Claude Code and the full list appears. The useful ones:

| Type this | What happens |
|-----------|--------------|
| `/devsharp:next` | Show a card right now |
| `/devsharp:reveal` | Show the answer to the current question |
| `/devsharp:known` | "I knew this", never show it again |
| `/devsharp:dismiss` | "Not for me", never show it again |
| `/devsharp:stats` | Your progress: cards seen, streak, strong areas |
| `/devsharp:snooze 2h` | Quiet for 2 hours (also `30m`, `1d`; `/devsharp:snooze 0` to resume) |
| `/devsharp:disable` | Turn it off (`/devsharp:enable` to turn it back on) |

These commands are handled entirely on your computer. They never go to Claude and
cost nothing.

---

## 6. Make it yours (optional)

Change settings with `/devsharp:config set <setting> <value>`:

```text
/devsharp:config set frequency low            # fewer cards (low / medium / high)
/devsharp:config set frequency high           # more cards
/devsharp:config set topics databases,security  # only these subjects
/devsharp:config set mode think               # only Think First questions
/devsharp:config set updates false            # no tech-news headlines (fully offline)
/devsharp:config                              # see all settings
```

---

## 7. Cards about YOUR code (AI cards)

On by default. DevSharp occasionally asks a small, cheap
model (Haiku, through your own Claude login) to explain the concepts in the code you
just changed, and to summarise real release notes for your tools:

```text
/devsharp:ai          # see today's usage and cost
/devsharp:ai off      # turn off
/devsharp:ai on       # turn back on
```

- Each call costs about half a US cent at Haiku list price, with a maximum of 25 a day.
- It runs separately in the background and never adds anything to your conversation with Claude.
- Only your changed lines are sent. Secrets, `.env` files, keys and lockfiles are
  never included, and anything that looks like a password or token is blanked out.

---

## 7b. Using another AI CLI?

```bash
npm install -g github:aman5062/DevSharp
devsharp setup codex      # or: gemini, opencode
devsharp run freebuff     # Freebuff or any other CLI: opens it with a card panel beside it
devsharp watch            # or run this yourself in any split pane / second terminal
```

## 8. Updating and removing

- **Update:** `claude plugin marketplace update devsharp` (or run the install command again).
- **Turn off for now:** `/devsharp:disable`.
- **Uninstall:** `claude plugin uninstall devsharp@devsharp`.
- **Wipe your history:** `/devsharp:reset confirm`. Your data lives in
  `~/.config/devsharp` (Windows: `%APPDATA%\devsharp`) and never leaves your computer.

---

## 9. Something not working?

| Problem | Fix |
|---------|-----|
| `Marketplace "devsharp" not found` | Run `/plugin marketplace add aman5062/DevSharp` first, then install |
| `/devsharp:...` commands don't appear | Restart Claude Code after installing |
| "DevSharp hook is not active" | Node.js is missing or too old. Install Node 18+ and restart Claude Code |
| No cards showing up | Cards come every few turns (at most every 10 min on the default setting). Try `/devsharp:next`, or `/devsharp:config set frequency high` |
| Still stuck | Run `/devsharp:status`, or open an issue at https://github.com/aman5062/DevSharp/issues |

More detail: [Troubleshooting](TROUBLESHOOTING.md) · [All settings](CONFIGURATION.md)
