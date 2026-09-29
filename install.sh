#!/usr/bin/env bash
# DevSharp one-line installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/aman5062/DevSharp/main/install.sh | bash
#
# It only runs the two official Claude Code plugin commands for you, after checking
# the prerequisites. It does not download or run anything else.
set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }

bold "Installing DevSharp — learning cards for Claude Code"

command -v claude >/dev/null 2>&1 || fail "Claude Code is not installed. Get it from https://claude.com/claude-code and run this again."
ok "Claude Code found ($(claude --version 2>/dev/null | head -1))"

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. DevSharp needs Node.js 18 or newer: https://nodejs.org"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || fail "Node.js $(node -v) is too old. DevSharp needs Node.js 18 or newer: https://nodejs.org"
ok "Node.js $(node -v) found"

if claude plugin marketplace list 2>/dev/null | grep -q 'devsharp'; then
  claude plugin marketplace update devsharp >/dev/null 2>&1 || true
  ok "DevSharp marketplace already added (refreshed)"
else
  claude plugin marketplace add aman5062/DevSharp >/dev/null || fail "Could not add the marketplace. Check your internet connection and try again."
  ok "Added the DevSharp marketplace"
fi

claude plugin install devsharp@devsharp >/dev/null || fail "Install failed. Try inside Claude Code: /plugin install devsharp@devsharp"
ok "Installed the DevSharp plugin"

echo
bold "Done! Next steps:"
echo "  1. Start (or restart) Claude Code:   claude"
echo "  2. Check it is running:              /devsharp:status"
echo "  3. See a card right away:            /devsharp:next"
echo
echo "Cards then appear by themselves after Claude finishes a turn."
echo "Guide: https://github.com/aman5062/DevSharp/blob/main/docs/GETTING-STARTED.md"
