#!/usr/bin/env node
'use strict';
// End-to-end proof against a real Claude Code binary that DevSharp adds no model usage.
//
//   node scripts/verify-zero-tokens.js          free checks only (no model calls at all)
//   node scripts/verify-zero-tokens.js --full   also spends a few tokens on control turns
//
// Free:   every /devsharp:* command -> num_turns 0, total_cost_usd 0, zero tokens.
// --full: (a) the same prompt with and without the plugin uses the same input tokens
//             (the plugin adds nothing to Claude's context: no command listings, no hook text);
//         (b) a card is shown after a turn, then the session is resumed and Claude is asked
//             to find the card's text in its context -> it must answer NOTFOUND.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const full = process.argv.includes('--full');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devsharp-verify-'));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ updates: false, frequency: 'high', minimum_interval: '0s', mode: 'fact' }));
const env = { ...process.env, DEVSHARP_HOME: home };
let failed = 0;

function claude(args) {
  const r = spawnSync('claude', args, { env, encoding: 'utf8', timeout: 240000, cwd: ROOT });
  if (r.error) throw r.error;
  const lines = r.stdout.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { lines, result: lines.find((l) => l.type === 'result') || lines[lines.length - 1] || {} };
}
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed += 1; };
const tokens = (u = {}) => (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);

for (const cmd of ['help', 'next', 'reveal', 'stats', 'status', 'config']) {
  const { result } = claude(['-p', `/devsharp:${cmd}`, '--plugin-dir', ROOT, '--output-format', 'json']);
  check(result.num_turns === 0 && result.total_cost_usd === 0 && tokens(result.usage) === 0,
    `/devsharp:${cmd}: turns=${result.num_turns} cost=$${result.total_cost_usd} tokens=${tokens(result.usage)}`);
}

if (full) {
  const prompt = 'Reply with exactly: ok';
  const base = claude(['-p', prompt, '--output-format', 'json', '--no-session-persistence']).result;
  const withPlugin = claude(['-p', prompt, '--plugin-dir', ROOT, '--output-format', 'json', '--no-session-persistence']).result;
  const a = (base.usage || {}); const b = (withPlugin.usage || {});
  const ctxA = (a.input_tokens || 0) + (a.cache_creation_input_tokens || 0) + (a.cache_read_input_tokens || 0);
  const ctxB = (b.input_tokens || 0) + (b.cache_creation_input_tokens || 0) + (b.cache_read_input_tokens || 0);
  check(ctxA === ctxB, `context size without plugin ${ctxA} vs with plugin ${ctxB} tokens (turns ${base.num_turns}/${withPlugin.num_turns})`);

  const run = claude(['-p', prompt, '--plugin-dir', ROOT, '--output-format', 'stream-json', '--verbose']);
  const card = run.lines.find((l) => l.type === 'system' && typeof l.content === 'string' && /QUICK FACT|THINK FIRST|CONCEPT|WHY\?/.test(l.content));
  check(!!card, 'a learning card was displayed after the turn');
  if (card) {
    console.log(card.content.split('\n').slice(0, 5).map((l) => `      ${l}`).join('\n'));
    // First non-empty body line of the card (its title), e.g. "│  Composite index order".
    const body = card.content.split('\n').map((l) => l.replace(/^\s*Stop says:\s*/, '').replace(/^\s*[│╰╭]─?\s*/, '').trim()).filter((l) => l && !/^[⚡🧠📘❓📰💡]/.test(l));
    const needle = body[0] || '';
    if (needle.length < 8) { check(false, `could not extract card title from: ${JSON.stringify(card.content.slice(0, 200))}`); }
    const sid = run.result.session_id;
    const q = claude(['-p', `Search everything in your context window. Does the exact phrase "${needle.slice(0, 40)}" appear anywhere BEFORE this message (in any earlier message, reminder or hook output)? Reply exactly FOUND or NOTFOUND.`,
      '--resume', sid, '--plugin-dir', ROOT, '--output-format', 'json']).result;
    check(/NOTFOUND/.test(q.result || ''), `resumed session cannot see card "${needle.slice(0, 40)}": ${q.result}`);
  }
}

fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll zero-token checks passed.');
process.exitCode = failed ? 1 : 0;
