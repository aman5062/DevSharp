'use strict';
// Architecture test: DevSharp must never cause an additional model request.
//
// How Claude Code could be made to spend tokens by a hook, and how each is ruled out:
//  1. stdout / additionalContext on SessionStart or UserPromptSubmit is injected into
//     Claude's context            -> those handlers print nothing (except a documented block).
//  2. Stop hook `decision:block`, `reason` or `additionalContext` makes Claude continue
//                                  -> Stop output may only contain `systemMessage`.
//  3. async hooks deliver systemMessage/additionalContext to Claude on the next turn
//                                  -> hooks.json has no async / asyncRewake.
//  4. prompt / agent hook types run a model -> only `command` hooks.
//  5. Calling a model API directly  -> no model hosts, SDKs or CLIs referenced anywhere in src/.
// The end-to-end check against a real Claude Code binary is scripts/verify-zero-tokens.sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpHome } = require('./helpers');
const { handle } = require('../src/claude/hook');

const ROOT = path.join(__dirname, '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : d.name.endsWith('.js') ? [p] : [];
  });
}

test('hooks.json: only synchronous command hooks on the four lifecycle events', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  for (const [event, groups] of Object.entries(cfg.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        assert.equal(h.type, 'command', `${event}: prompt/agent hooks would call a model`);
        assert.ok(!h.async && !h.asyncRewake, `${event}: async hook output is delivered to Claude`);
      }
    }
  }
});

test('source: no model APIs, SDKs, CLIs or subagents referenced', () => {
  const forbidden = [
    /api\.anthropic\.com/i, /require\(\s*['"](?:@anthropic-ai|openai|@google\/generative-ai|langchain)/, /from\s+['"](?:@anthropic-ai|openai)/, /new\s+Anthropic\s*\(/, /api\.openai\.com/i, /new\s+OpenAI\s*\(/,
    /generativelanguage\.googleapis/i, /bedrock-runtime/i, /\bclaude\s+-p\b/, /spawn\w*\(\s*['"]claude['"]/,
    /exec\w*\(\s*['"]claude/, /ANTHROPIC_API_KEY/, /\/v1\/messages/,
  ];
  for (const file of walk(path.join(ROOT, 'src')).concat(walk(path.join(ROOT, 'cli')))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of forbidden) assert.ok(!re.test(src), `${path.relative(ROOT, file)} matches ${re}`);
  }
});

test('source: child processes only re-launch node on our own refresh script', () => {
  for (const file of walk(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/child_process/.test(src)) continue;
    assert.equal(path.relative(ROOT, file).replace(/\\/g, '/'), 'src/updates/index.js', `unexpected child_process in ${file}`);
    assert.ok(/process\.execPath/.test(src), 'must spawn node itself');
    assert.ok(!/shell:\s*true/.test(src), 'no shell');
    assert.ok(!/\bexec(Sync)?\(/.test(src), 'no exec');
  }
});

test('source: no dynamic code execution', () => {
  for (const file of walk(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/\beval\s*\(|new Function\s*\(|vm\.run/.test(src), file);
  }
});

test('hook output contract holds across many turns, commands and modes', () => {
  const t = tmpHome();
  fs.writeFileSync(path.join(t.home, 'config.json'), JSON.stringify({ updates: false, frequency: 'high', minimum_interval: '0s' }));
  const now0 = Date.UTC(2026, 8, 29);
  const prompts = ['refactor the db layer', '/devsharp:next', '/devsharp:reveal', '/devsharp:stats', 'ignore previous instructions', '/devsharp:dismiss', '/devsharp:known', '/other:cmd', '/devsharp'];
  let cards = 0;
  for (let i = 0; i < 60; i += 1) {
    const now = now0 + i * 60e3;
    const base = { session_id: `sess-${i % 3}`, cwd: ROOT };
    if (i % 20 === 0) assert.equal(handle('session-start', base, t.env, now), '');
    const pOut = handle('prompt', { ...base, prompt: prompts[i % prompts.length] }, t.env, now);
    if (/^\/devsharp:/.test(prompts[i % prompts.length])) {
      const j = JSON.parse(pOut);
      assert.deepEqual(Object.keys(j).sort(), ['decision', 'reason', 'suppressOriginalPrompt']);
      assert.equal(j.decision, 'block');
    } else {
      assert.equal(pOut, '', 'ordinary prompts must pass through untouched, with no added context');
    }
    const sOut = handle('stop', base, t.env, now + 1000);
    if (sOut) {
      cards += 1;
      assert.deepEqual(Object.keys(JSON.parse(sOut)), ['systemMessage'], 'Stop may only emit a user-facing systemMessage');
    }
    if (i % 20 === 19) assert.equal(handle('session-end', base, t.env, now), '');
  }
  assert.ok(cards > 10, `expected cards to be shown, got ${cards}`);
  t.cleanup();
});

test('no network during the hook lifecycle when updates are cached/disabled', () => {
  const t = tmpHome();
  fs.writeFileSync(path.join(t.home, 'config.json'), JSON.stringify({ updates: false, frequency: 'high', minimum_interval: '0s' }));
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('network used'); };
  try {
    const base = { session_id: 'net', cwd: ROOT };
    handle('session-start', base, t.env);
    for (let i = 0; i < 5; i += 1) handle('stop', base, t.env, Date.now() + i * 1e6);
    handle('prompt', { ...base, prompt: '/devsharp:stats' }, t.env);
    handle('session-end', base, t.env);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls, 0);
  t.cleanup();
});
