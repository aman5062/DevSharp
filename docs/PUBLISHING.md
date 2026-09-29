# Publishing a release

DevSharp is distributed in two ways:

1. **Claude Code plugin** through this repository's own marketplace
   (`.claude-plugin/marketplace.json`). Users get new versions from GitHub.
2. **Optional npm package** `devsharp`, for the standalone CLI.

## Checklist

1. **Make sure `main` is green.**

   ```bash
   npm test
   npm run validate        # knowledge pack schema and quality checks
   npm run build:index     # regenerate knowledge/index.json
   git status              # index.json must be committed if it changed
   ```

2. **Bump the version in all three places** (they must match; use
   [semantic versioning](https://semver.org)):

   | File | Field |
   |------|-------|
   | `package.json` | `"version"` |
   | `.claude-plugin/plugin.json` | `"version"` |
   | `.claude-plugin/marketplace.json` | `"plugins"[0].version` |

   Quick check:

   ```bash
   grep -n '"version"' package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
   ```

   Claude Code uses the plugin version to decide whether an installed plugin is
   out of date, so do not skip `plugin.json` and `marketplace.json`.

3. **Update `CHANGELOG.md`**: move the items under a new
   `## [x.y.z] — YYYY-MM-DD` heading. Call out anything that changes behaviour
   users might notice (frequency, new network sources, config keys).

4. **Test the plugin as users will run it**, from a clean checkout:

   ```bash
   claude --plugin-dir "$PWD"
   ```

   Then `/devsharp:status`, `/devsharp:next`, `/devsharp:reveal`, and a couple
   of normal prompts to see a card after a turn. Optionally run
   `npm run verify:zero-tokens` (needs a logged-in `claude` CLI).

5. **Commit, tag and push.**

   ```bash
   git commit -am "Release vX.Y.Z"
   git tag -a vX.Y.Z -m "DevSharp vX.Y.Z"
   git push origin main --tags
   ```

6. **Create a GitHub release** from the tag, pasting the changelog section:

   ```bash
   gh release create vX.Y.Z --title "DevSharp vX.Y.Z" --notes-file <(sed -n '/## \[X.Y.Z\]/,/## \[/p' CHANGELOG.md | sed '$d')
   ```

## How users update

Plugin users pull the new version with:

```text
/plugin marketplace update devsharp
```

and then update or reinstall the plugin from `/plugin` if their Claude Code
does not do it automatically. A new session is needed for hook changes to take
effect. Their data directory (`~/.config/devsharp`) is untouched by updates.

## Publishing the CLI to npm (optional)

The `files` list in `package.json` controls what is published. Check it first:

```bash
npm pack --dry-run
```

The tarball should contain `cli/`, `src/`, `knowledge/` (including
`index.json`), `updates/`, `hooks/`, `commands/`, `.claude-plugin/`,
`examples/`, `docs/` and the top-level docs, and nothing else (no `test/`, no
`scripts/`). Then:

```bash
npm login
npm publish --access public
```

Users install with `npm install -g devsharp` and get the `devsharp` binary.
The package has no dependencies, so there is nothing else to audit in the
tree.

## Submitting to community marketplaces

The repository already works as a marketplace, so anyone can add it directly.
To be listed in a community or team marketplace, submit an entry that points
at this repository, following that marketplace's contribution rules. A typical
entry:

```json
{
  "name": "devsharp",
  "source": { "source": "github", "repo": "aman5062/DevSharp" },
  "description": "Zero-token learning cards between Claude turns: facts, Think First questions, concepts and tech updates.",
  "version": "0.1.0",
  "category": "learning",
  "homepage": "https://github.com/aman5062/DevSharp",
  "license": "MIT"
}
```

Things reviewers usually ask about, with where to point them:

- **What runs on the user's machine:** four synchronous hooks running
  `node src/claude/hook.js` (see `hooks/hooks.json` and
  [ARCHITECTURE.md](ARCHITECTURE.md)).
- **Network access:** HTTPS GETs to the public feeds in `updates/sources.json`
  only, from a detached process with a 25 s hard exit; can be turned off with
  `updates: false`.
- **Token use:** none; see the README's zero-token section.
- **Security model:** [SECURITY.md](../SECURITY.md).

Keep the marketplace entry's `version` in sync when you release, if that
marketplace pins versions.
