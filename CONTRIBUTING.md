# Contributing to DevSharp

Thanks for helping. The most valuable contributions are **good knowledge
cards**: accurate, short, source-backed, and interesting to a working
developer. Code contributions are welcome too, within the two rules below.

## Two non-negotiable rules

1. **No LLM, ever.** DevSharp must not call a language model, embed a model
   client, or send anything to Claude. Cards are hand-written data. Any
   change that could put DevSharp output into Claude's context (new hook
   output fields, `async` hooks, stdout from `SessionStart` or
   `UserPromptSubmit`) will not be merged.
2. **No runtime dependencies.** `package.json` has no `dependencies` and should
   keep it that way. Use Node.js 18 built-ins only. Dev tooling also sticks to
   built-ins (`node:test`, `node:assert/strict`).

## Development setup

```bash
git clone https://github.com/aman5062/DevSharp.git
cd DevSharp
node --version            # 18 or newer
npm test                  # node --test test/
```

There is nothing to install. Try it:

```bash
export DEVSHARP_HOME=$(mktemp -d)     # keep your real history clean
node cli/devsharp.js next
node cli/devsharp.js doctor
claude --plugin-dir "$PWD"            # run it as a plugin
```

## Scripts

| Command | What it does |
|---------|--------------|
| `npm test` | Unit and integration tests (`node --test test/`) |
| `npm run validate` | Validates every knowledge pack against the schema and quality rules |
| `npm run build:index` | Regenerates `knowledge/index.json` (commit it with pack changes) |
| `npm run bench` | Measures hook latency and selection cost |
| `npm run verify:zero-tokens` | End-to-end check against a real `claude` CLI that DevSharp adds no tokens |

## Code style

- CommonJS: `'use strict';`, `require` / `module.exports`.
- Hooks must be fast and must never throw to Claude Code: catch, write to
  stderr, exit 0.
- Everything displayed goes through `cleanText` / `cleanUrl`
  (`src/core/sanitize.js`).
- Selection stays deterministic: no `Math.random()`, use the seeded `hash32`.
- New behaviour needs a test. Changes to hook output need a zero-token test.

The internal contract (layout, file formats, canonical topic ids) is in
[docs/CONTRACT.md](docs/CONTRACT.md). The design is explained in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Writing knowledge items

Packs live in `knowledge/<category>/<topic>.json`. Use only the canonical
categories and topic ids listed in `docs/CONTRACT.md`; propose a new topic in
an issue first.

```json
{
  "id": "postgresql-mvcc-001",
  "type": "concept",
  "difficulty": "medium",
  "title": "MVCC",
  "body": "PostgreSQL keeps several versions of a row ...",
  "question": "Why can this reduce read/write blocking?",
  "answer": "Readers see a snapshot of row versions ...",
  "tags": ["concurrency", "transactions"],
  "source": { "name": "PostgreSQL Documentation: Concurrency Control", "url": "https://www.postgresql.org/docs/current/mvcc-intro.html" }
}
```

### Format rules

- `id`: `^[a-z0-9][a-z0-9._-]{2,80}$`, globally unique, prefixed with the topic
  (`postgresql-...`). Never reuse or rename an id: users' history is keyed by it.
- `type`:
  - `fact`: `title` + `body` (1 to 3 sentences). `question`/`answer` optional.
  - `think`: `title` + `question` (a concrete scenario to reason about) +
    `answer` (2 to 4 sentences). No `body`.
  - `concept`: `title` + `body` (2 to 4 sentences); optional `question` +
    `answer` for a "Think:" prompt.
  - `why`: `title` + `question` ("Why does X ...?") + `answer`.
- `difficulty`: `easy`, `medium` or `hard`.
- `tags`: lowercase; tags that match topic ids help project relevance.
- Length limits: `title` ≤ 60, `question` ≤ 300, `body` ≤ 400,
  `answer` ≤ 600 characters.
- Plain text only: no Markdown, no ANSI, no HTML.
- `source` is required and must be an official doc, spec, RFC or other
  primary source, over `https`.

### Quality rules

- **Correct and current.** Check the claim against the source you cite. Name
  versions when behaviour changed between versions.
- **One idea per card.** If it needs two paragraphs, it is two cards.
- **Useful to someone who already codes.** Skip trivia and definitions anyone
  could guess; prefer the surprising, the commonly misunderstood and the
  "this will bite you in production".
- **Think First cards are real questions.** A scenario the reader can reason
  about in under a minute, whose answer teaches something. Not a quiz on
  syntax.
- **Neutral.** No marketing, no vendor comparisons, no opinions dressed as
  facts.
- **Your own words.** Do not copy text from the source.

Before opening a PR:

```bash
npm run validate
npm run build:index
npm test
```

## Pull requests

- Keep PRs focused (one topic's cards, or one fix).
- Describe what you changed and how you checked it.
- By contributing you agree your work is licensed under the MIT License.
- Be kind; see the [Code of Conduct](CODE_OF_CONDUCT.md).

Security issues: please do not open a public issue; see
[SECURITY.md](SECURITY.md).
