# Configuration

DevSharp works with no configuration. Everything below is optional.

## Where settings live

| Platform | Data directory |
|----------|----------------|
| Linux / macOS | `$XDG_CONFIG_HOME/devsharp`, default `~/.config/devsharp` |
| Windows | `%APPDATA%\devsharp` |
| Any | `$DEVSHARP_HOME` overrides both |

Settings are in `config.json` in that directory. The file only needs the keys
you want to change; anything missing uses its default.

## Changing settings

Inside Claude Code:

```text
/devsharp:config                         show current settings
/devsharp:config set frequency low
/devsharp:config set topics databases,security,docker
/devsharp:config reset                   back to defaults
```

In a terminal: `devsharp config set frequency low`, and so on. You can also edit
`config.json` directly; changes apply on the next hook call, no restart needed.

Validation rules:

- Every value is validated. An invalid value is ignored, the default is used,
  and a warning appears in `/devsharp:status` and `devsharp doctor`.
- Unknown keys are ignored with a warning.
- Keys starting with `$` or `//` are ignored silently, so `"$schema"` or
  `"// note"` comments are fine.
- `config set` rejects unknown keys and invalid values with a message listing
  what is accepted.
- Booleans accept `true/false`, `yes/no`, `on/off`, `1/0`.

## All settings

| Key | Default | Accepted values | Meaning |
|-----|---------|-----------------|---------|
| `enabled` | `true` | boolean | Master switch. When false: no cards and no background refresh. Commands still work. |
| `frequency` | `"medium"` | `off`, `low`, `medium`, `high` | How often cards appear (see below). `off` stops automatic cards; `/devsharp:next` still works. |
| `mode` | `"mixed"` | `mixed`, `fact`, `think`, `concept`, `why`, `update` | Which card types to show. `mixed` balances all types; a single type falls back to another type when none of it is left. |
| `show_after_prompt` | `true` | boolean | Show cards automatically after Claude finishes a turn. Set false to only use `/devsharp:next`. |
| `minimum_interval` | `"auto"` | `auto` or a duration: `90s`, `10m`, `1.5h`, `1d`; a bare number means minutes | Minimum time between automatic cards across all sessions. `auto` uses the frequency's interval. |
| `topics` | `"auto"` | `auto`, or a list of categories and/or topic ids (comma string or JSON array) | `auto`: project technologies first, then everything. A list restricts cards to those topics/categories (custom pack cards are always allowed). |
| `difficulty` | `"adaptive"` | `adaptive`, `easy`, `medium`, `hard` | `adaptive` starts each topic at easy, moves to medium after 3 cards seen, and to hard once 3 of its cards are marked known. |
| `updates` | `true` | boolean | Fetch public technology-update feeds in the background and include 📰 Tech Update cards. `false` means no network access at all. |
| `update_refresh_hours` | `24` | number, 1 to 168 | How old the update cache must be before a new session triggers a refresh. |
| `think_first` | `true` | boolean | Include 🧠 Think First questions in `mixed` mode. |
| `reveal` | `"next-turn"` | `next-turn`, `manual` | `next-turn`: the answer to a question appears automatically after your next turn. `manual`: only `/devsharp:reveal` shows it. |
| `project_awareness` | `true` | boolean | Detect technologies in the current project and prioritise them. |
| `card_style` | `"rail"` | `rail`, `box`, `plain` | `rail`: left border only (robust to emoji width). `box`: closed frame. `plain`: no border. |
| `card_width` | `64` | integer, 40 to 100 | Card width in columns. |
| `telemetry` | `false` | `false` only | DevSharp has no telemetry. Any other value is rejected. |

## Frequency

A card is shown when enough turns have passed in the current session **and**
enough time has passed since the last card in any session.

| `frequency` | Completed turns between cards | Minimum time between cards |
|-------------|------------------------------|----------------------------|
| `off` | never | never |
| `low` | 5 | 30 minutes |
| `medium` (default) | 3 | 10 minutes |
| `high` | 1 | 3 minutes |

The first card of a session can appear after the first completed turn, if the
time interval allows. Setting `minimum_interval` replaces the time column,
e.g. `frequency: high` with `minimum_interval: 30s` shows a card after nearly
every turn.

To pause for a while instead: `/devsharp:snooze 2h` (accepts `30m`, `2h`,
`1d`, default `1h`). `/devsharp:snooze 0` or `/devsharp:enable` ends a snooze early.

## Topic ids and categories

`topics` accepts any of these category names or topic ids:

| Category | Topic ids |
|----------|-----------|
| `languages` | `javascript`, `typescript`, `python`, `go`, `rust`, `java`, `bash` |
| `frontend` | `react`, `nextjs`, `css`, `browser` |
| `backend` | `nodejs`, `http`, `auth`, `api-design` |
| `databases` | `sql`, `postgresql`, `mysql`, `redis`, `mongodb`, `sqlite`, `prisma` |
| `devops` | `docker`, `kubernetes`, `git`, `linux`, `ci-cd` |
| `cloud` | `aws` |
| `security` | `web-security`, `tls`, `cryptography` |
| `networking` | `tcp`, `dns` |
| `distributed-systems` | `distributed-systems` |
| `system-design` | `system-design`, `caching` |
| `ai-ml` | `ai-ml`, `llm` |
| `computer-science` | `algorithms`, `data-structures`, `memory`, `concurrency` |

Your own packs can add new topic ids (see below).

## Example config

A complete file with every key is in
[`examples/config.example.json`](../examples/config.example.json). A typical
customised one:

```json
{
  "frequency": "low",
  "topics": ["databases", "security", "docker"],
  "reveal": "manual",
  "card_style": "box",
  "card_width": 72
}
```

Quiet mode for CI or shared machines:

```json
{ "enabled": false, "updates": false }
```

## Custom knowledge packs

Put pack files in `<data dir>/packs/`, e.g. `~/.config/devsharp/packs/acme.json`.
They are loaded on every card selection; no restart needed. A full example with
three items is in [`examples/custom-pack.json`](../examples/custom-pack.json).

```json
{
  "schema": 1,
  "topic": "acme-platform",
  "category": "custom",
  "name": "Acme Platform",
  "items": [
    {
      "id": "acme-platform-deploy-001",
      "type": "fact",
      "difficulty": "easy",
      "title": "Deploys are blue/green",
      "body": "Every production deploy starts a new stack next to the old one and shifts traffic only after health checks pass.",
      "tags": ["deploy"],
      "source": { "name": "Acme Platform Handbook", "url": "https://handbook.acme.example/deploys" }
    }
  ]
}
```

Rules (enforced when the pack is loaded; invalid items are skipped silently):

| Field | Rule |
|-------|------|
| file name | `[A-Za-z0-9._-]+.json`, a regular file (symlinks are ignored), at most 2 MB |
| `topic` | required, `[a-z0-9-]{1,40}` |
| `category` | `[a-z0-9-]{1,40}`; defaults to `custom` for your packs |
| `name` | display name in the card header (defaults to the topic) |
| `items[].id` | required, `^[a-z0-9][a-z0-9._-]{2,80}$`, unique. Prefix it with your topic. An id that already exists in a bundled pack is ignored (bundled cards cannot be overridden). |
| `items[].type` | `fact`, `think`, `concept`, `why` |
| `items[].difficulty` | `easy`, `medium`, `hard` (default `medium`) |
| `fact`, `concept` | need `title` and `body`; optional `question` + `answer` add a "Think:" prompt |
| `think`, `why` | need `title`, `question` and `answer` |
| `tags` | optional lowercase `[a-z0-9-]` strings, at most 10 |
| `source` | optional for your packs: `{ "name": "...", "url": "https://..." }`; non-https URLs are dropped |

All text is plain text: terminal escape sequences, control characters and
invisible/bidi formatting characters are stripped, and fields are length
capped (title 80, body 600, question 400, answer 800 characters). Bundled
packs follow stricter limits; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Custom pack cards get a small score bonus and are never filtered out by
`topics`, so they show up regularly. Use `/devsharp:next` a few times to check
yours.

## Custom update sources

DevSharp ships a default list of public feeds (`updates/sources.json` in the
plugin: Node.js, Python, Rust, Go, TypeScript, React, Next.js, Kubernetes,
Docker, PostgreSQL, Redis, Linux, PyTorch, Git). Add, replace or disable feeds
in `<data dir>/sources.json`. Example:
[`examples/sources.example.json`](../examples/sources.example.json).

```json
{
  "sources": [
    { "id": "deno", "name": "Deno", "topic": "javascript", "type": "github-releases", "repo": "denoland/deno" },
    { "id": "prisma", "name": "Prisma", "topic": "prisma", "type": "feed", "url": "https://github.com/prisma/prisma/releases.atom" }
  ],
  "disable": ["pytorch", "linux"]
}
```

| Field | Rule |
|-------|------|
| `id` | required, `[a-z0-9-]{1,40}`. A source with the same id as a bundled one **replaces** it. |
| `name` | required, display name |
| `topic` | required, `[a-z0-9-]{1,40}`. Use a topic id from the table above so project relevance and the `topics` filter apply. |
| `type` | `github-releases` or `feed` |
| `repo` | for `github-releases`: `owner/name`. Fetched from `https://api.github.com/repos/<repo>/releases?per_page=10`. |
| `url` | for `feed`: an `https://` RSS 2.0 or Atom URL (no credentials, no IP addresses, no localhost) |
| `allow_hosts` | for `feed`, optional: up to 10 extra hostnames that item links and redirects may point to. By default only the feed URL's own host (and its subdomains) is allowed. |
| `disable` | list of source ids (bundled or yours) to turn off |

Invalid entries are skipped. At most 50 sources are used. Run
`/devsharp:update` (or `devsharp update` to see the result in the terminal) to
fetch immediately. Headlines older than 45 days are not shown, and each
headline is shown at most once.
