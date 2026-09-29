# DevSharp one-line installer for Windows (PowerShell).
#   irm https://raw.githubusercontent.com/aman5062/DevSharp/main/install.ps1 | iex
#
# It only runs the two official Claude Code plugin commands for you, after checking
# the prerequisites. It does not download or run anything else.
$ErrorActionPreference = 'Stop'

function Ok($m) { Write-Host "OK  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "ERR $m" -ForegroundColor Red; exit 1 }

Write-Host 'Installing DevSharp - learning cards for Claude Code' -ForegroundColor Cyan

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail 'Claude Code is not installed. Get it from https://claude.com/claude-code and run this again.' }
Ok "Claude Code found ($(claude --version))"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed. DevSharp needs Node.js 18 or newer: https://nodejs.org' }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Fail "Node.js $(node -v) is too old. DevSharp needs Node.js 18 or newer: https://nodejs.org" }
Ok "Node.js $(node -v) found"

$list = (claude plugin marketplace list 2>$null) -join "`n"
if ($list -match 'devsharp') {
  claude plugin marketplace update devsharp *> $null
  Ok 'DevSharp marketplace already added (refreshed)'
} else {
  claude plugin marketplace add aman5062/DevSharp *> $null
  if ($LASTEXITCODE -ne 0) { Fail 'Could not add the marketplace. Check your internet connection and try again.' }
  Ok 'Added the DevSharp marketplace'
}

claude plugin install devsharp@devsharp *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Install failed. Try inside Claude Code: /plugin install devsharp@devsharp' }
Ok 'Installed the DevSharp plugin'

Write-Host ''
Write-Host 'Done! Next steps:' -ForegroundColor Cyan
Write-Host '  1. Start (or restart) Claude Code:   claude'
Write-Host '  2. Check it is running:              /devsharp:status'
Write-Host '  3. See a card right away:            /devsharp:next'
Write-Host ''
Write-Host 'Guide: https://github.com/aman5062/DevSharp/blob/main/docs/GETTING-STARTED.md'
