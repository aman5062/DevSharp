'use strict';
// Architecture test: DevSharp's core never causes a model request, and the optional
// AI-cards feature (config `ai`, off by default) is fenced into src/ai/.
//
// How Claude Code could be made to spend tokens by a hook, and how each is ruled out:
//  1. stdout / additionalContext on SessionStart or UserPromptSubmit is injected into
//     Claude's context            -> those handlers print nothing (except a documented block).
//  2. Stop hook `decision:block`, `reason` or `additionalContext` makes Claude continue
//                                  -> Stop output may only contain `systemMessage`.
//  3. async hooks deliver systemMessage/additionalContext to Claude on the next turn
//                                  -> hooks.json has no async / asyncRewake.
//  4. prompt / agent hook types run a model -> only `command` hooks.
//  5. Calling a model directly      -> no model hosts or SDKs anywhere; the `claude` CLI only
//                                     from src/ai/index.js, only when `ai` is enabled.
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

test('hooks.json: only synchronous command hooks on the five lifecycle events', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
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
  const cliOnly = [/\bclaude\s+-p\b/, /spawn\w*\(\s*['"]claude['"]/, /exec\w*\(\s*['"]claude/];
  for (const file of walk(path.join(ROOT, 'src')).concat(walk(path.join(ROOT, 'cli')))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');
    for (const re of forbidden) {
      if (rel === 'src/ai/index.js' && cliOnly.some((c) => String(c) === String(re))) continue;
      assert.ok(!re.test(src), `${rel} matches ${re}`);
    }
  }
});

test('source: child processes are limited to known, shell-free call sites', () => {
  const allowed = new Set(['src/updates/index.js', 'src/ai/index.js', 'src/ai/diff.js']);
  for (const file of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');
    if (!/child_process/.test(src)) continue;
    assert.ok(allowed.has(rel), `unexpected child_process in ${rel}`);
    assert.ok(!/shell:\s*true/.test(src), `${rel}: no shell`);
    assert.ok(!/(?<![.\w])exec(Sync)?\(|child_process'\)\.exec\b|\{[^}]*\bexec\b[^}]*\}\s*=\s*require\('child_process'\)/.test(src), `${rel}: no shell exec`);
  }
});

test('ai: off by default, and nothing can start a model call while it is off', () => {
  const t = tmpHome();
  const ai = require('../src/ai');
  assert.equal(require('../src/core/config').DEFAULTS.ai, false);
  const orig = ai.spawnWorker;
  let spawned = 0;
  ai.spawnWorker = () => { spawned += 1; return 1; };
  try {
    fs.writeFileSync(path.join(t.home, 'config.json'), JSON.stringify({ updates: false, frequency: 'high', minimum_interval: '0s' }));
    const base = { session_id: 'ai-off', cwd: ROOT };
    handle('session-start', base, t.env);
    for (let i = 0; i < 10; i += 1) handle('stop', base, t.env, Date.now() + i * 3600e3);
    const j = JSON.parse(handle('prompt', { ...base, prompt: '/devsharp:ai now' }, t.env));
    assert.match(j.reason, /off/);
    assert.equal(spawned, 0);
  } finally {
    ai.spawnWorker = orig;
    t.cleanup();
  }
});

test('ai: when on, generation is rate-limited by interval', () => {
  const t = tmpHome();
  const ai = require('../src/ai');
  const orig = ai.spawnWorker;
  let spawned = 0;
  ai.spawnWorker = () => { spawned += 1; return 4242; };
  try {
    fs.writeFileSync(path.join(t.home, 'config.json'), JSON.stringify({ updates: false, ai: true, ai_min_interval: '10m' }));
    const base = { session_id: 'ai-on', cwd: ROOT };
    const t0 = Date.UTC(2026, 8, 29, 9);
    handle('stop', base, t.env, t0);
    assert.equal(spawned, 1);
    // The fake worker never records a run, so simulate what the real worker writes.
    const p = require('../src/core/paths').paths(t.env);
    const c = ai.loadCache(p);
    Object.assign(c, { day: require('../src/core/store').dayKey(t0), count: 1, lastRunAt: t0 });
    ai.saveCache(p, c);
    handle('stop', base, t.env, t0 + 60e3);
    assert.equal(spawned, 1, 'no second call within ai_min_interval');
    handle('stop', base, t.env, t0 + 11 * 60e3);
    assert.equal(spawned, 2);
  } finally {
    ai.spawnWorker = orig;
    t.cleanup();
  }
});

test('ai: the model call is isolated from the user\'s session', () => {
  const args = require('../src/ai').claudeArgs('haiku');
  const val = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], '-p');
  assert.equal(val('--tools'), '', 'no tools');
  assert.equal(val('--setting-sources'), '', 'no user/project settings, plugins or hooks');
  assert.deepEqual(JSON.parse(val('--settings')), { disableAllHooks: true });
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', '--max-budget-usd']) assert.ok(args.includes(f), f);
  assert.ok(Number(val('--max-budget-usd')) <= 0.05);
});

test('DEVSHARP_DISABLE makes every hook inert (no recursion from the AI child process)', () => {
  const env = { ...process.env, DEVSHARP_DISABLE: '1' };
  for (const ev of ['session-start', 'prompt', 'stop', 'session-end']) {
    assert.equal(handle(ev, { session_id: 'x', prompt: '/devsharp:next' }, env), '');
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
    } else if (pOut) {
      // An ordinary prompt may get a card for the user to read while waiting, never context for Claude.
      assert.deepEqual(Object.keys(JSON.parse(pOut)), ['systemMessage'], 'ordinary prompts: user-facing systemMessage only');
      cards += 1;
    }
    const tOut = handle('tool', base, t.env, now + 500);
    if (tOut) { assert.deepEqual(Object.keys(JSON.parse(tOut)), ['systemMessage'], 'PostToolUse: user-facing systemMessage only'); cards += 1; }
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
