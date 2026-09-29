'use strict';
// Integration: drives the real hook script the way Claude Code does
// (JSON on stdin, JSON/empty on stdout) through a whole session lifecycle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpHome } = require('./helpers');
const { handle } = require('../src/claude/hook');
const { paths } = require('../src/core/paths');
const store = require('../src/core/store');

const HOOK = path.join(__dirname, '..', 'src', 'claude', 'hook.js');
const PROJECT = path.join(__dirname, '..');

function run(event, input, env) {
  const r = spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(input), env, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function setup(cfg = {}) {
  const t = tmpHome();
  fs.writeFileSync(path.join(t.home, 'config.json'), JSON.stringify({ updates: false, card_timing: 'after', reveal: 'next-turn', ...cfg }));
  return t;
}

test('lifecycle: start → prompt → stop shows card → cooldown → session end cleans up', () => {
  const t = setup({ mode: 'fact' });
  const base = { session_id: 'sess-1', cwd: PROJECT };
  assert.equal(run('session-start', { ...base, hook_event_name: 'SessionStart', source: 'startup' }, t.env), '');
  assert.equal(run('prompt', { ...base, prompt: 'Fix the authentication middleware' }, t.env), '', 'normal prompts are untouched');

  const out = run('stop', { ...base, stop_hook_active: false, last_assistant_message: 'done' }, t.env);
  const j = JSON.parse(out);
  assert.deepEqual(Object.keys(j), ['systemMessage']);
  assert.match(j.systemMessage, /QUICK FACT/);

  // Cooldown: medium frequency → no second card on the very next turns.
  assert.equal(run('stop', base, t.env), '');
  assert.equal(run('stop', base, t.env), '');

  const p = paths(t.env);
  assert.ok(store.loadState(p).sessions['sess-1']);
  assert.equal(run('session-end', { ...base, reason: 'prompt_input_exit' }, t.env), '');
  assert.equal(store.loadState(p).sessions['sess-1'], undefined);
  t.cleanup();
});

test('lifecycle: Think First answer is revealed after the next turn', () => {
  const t = setup({ mode: 'think' });
  const base = { session_id: 'sess-2', cwd: PROJECT };
  run('session-start', base, t.env);
  const card = JSON.parse(run('stop', base, t.env)).systemMessage;
  assert.match(card, /THINK FIRST/);
  assert.match(card, /\/devsharp:reveal/);
  const ans = JSON.parse(run('stop', base, t.env)).systemMessage;
  assert.match(ans, /ANSWER/);
  const s = store.loadState(paths(t.env));
  assert.ok(s.events.some((e) => e.e === 'revealed' && e.auto));
  t.cleanup();
});

test('lifecycle: reveal=manual keeps the answer hidden until /devsharp:reveal', () => {
  const t = setup({ mode: 'think', reveal: 'manual' });
  const base = { session_id: 'sess-3', cwd: PROJECT };
  run('session-start', base, t.env);
  JSON.parse(run('stop', base, t.env));
  assert.equal(run('stop', base, t.env), '');
  const blocked = JSON.parse(run('prompt', { ...base, prompt: '/devsharp:reveal' }, t.env));
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /ANSWER/);
  t.cleanup();
});

test('commands: every /devsharp:* command is answered locally with a block', () => {
  const t = setup();
  const base = { session_id: 'sess-4', cwd: PROJECT };
  for (const cmd of ['help', 'status', 'stats', 'config', 'topics', 'next', 'reveal', 'known', 'next think', 'dismiss', 'snooze 5m', 'disable', 'enable', 'reset', 'reset confirm', 'config set frequency high', 'bogus']) {
    const j = JSON.parse(run('prompt', { ...base, prompt: `/devsharp:${cmd}` }, t.env));
    assert.equal(j.decision, 'block', cmd);
    assert.equal(typeof j.reason, 'string');
    assert.ok(j.reason.length > 0 && j.reason.length < 10000, cmd);
    assert.equal(j.hookSpecificOutput, undefined, `${cmd}: must not add context`);
  }
  t.cleanup();
});

test('disabled: no cards, commands still work', () => {
  const t = setup({ enabled: false });
  const base = { session_id: 'sess-5', cwd: PROJECT };
  run('session-start', base, t.env);
  for (let i = 0; i < 5; i += 1) assert.equal(run('stop', base, t.env), '');
  assert.equal(JSON.parse(run('prompt', { ...base, prompt: '/devsharp:status' }, t.env)).decision, 'block');
  t.cleanup();
});

test('first-ever card appears after the first turn even without SessionStart (installed mid-session)', () => {
  const t = setup({ mode: 'fact' });
  const out = run('stop', { session_id: 'mid-install', cwd: PROJECT }, t.env);
  assert.match(JSON.parse(out).systemMessage, /╭─/);
  assert.equal(run('stop', { session_id: 'mid-install', cwd: PROJECT }, t.env), '', 'then the normal cadence applies');
  t.cleanup();
});

test('stop_hook_active is respected (never participates in stop-hook loops)', () => {
  const t = setup();
  assert.equal(run('stop', { session_id: 's', cwd: PROJECT, stop_hook_active: true }, t.env), '');
  t.cleanup();
});

test('robustness: garbage / empty / huge stdin exits 0 with no output', () => {
  const t = setup();
  for (const input of ['', 'not json', '[]', 'null', '{"session_id":{"a":1}}', 'x'.repeat(3 * 1024 * 1024)]) {
    for (const ev of ['session-start', 'prompt', 'stop', 'session-end', 'unknown']) {
      const r = spawnSync(process.execPath, [HOOK, ev], { input, env: t.env, encoding: 'utf8', timeout: 10000 });
      assert.equal(r.status, 0, `${ev}: ${r.stderr}`);
      if (ev !== 'stop') assert.equal(r.stdout, '', ev);
    }
  }
  t.cleanup();
});

test('robustness: unwritable data dir never breaks the session', () => {
  const t = tmpHome();
  const blocker = path.join(t.home, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const env = { ...process.env, DEVSHARP_HOME: path.join(blocker, 'devsharp') }; // parent is a file -> ENOTDIR
  for (const ev of ['session-start', 'stop', 'session-end']) {
    const r = spawnSync(process.execPath, [HOOK, ev], { input: '{"session_id":"x"}', env, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, ev);
    assert.equal(r.stdout, '', ev);
  }
  const r = spawnSync(process.execPath, [HOOK, 'prompt'], { input: '{"prompt":"/devsharp:status"}', env, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0);
  t.cleanup();
});

test('in-process handle(): SessionStart and SessionEnd never print (their stdout would reach Claude)', () => {
  const t = setup();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(handle('session-start', { session_id: `s${i}`, cwd: PROJECT }, t.env), '');
    assert.equal(handle('session-end', { session_id: `s${i}`, cwd: PROJECT }, t.env), '');
  }
  t.cleanup();
});

// ---- card_timing "during" (default): cards fill the time spent waiting ----------
function during(cfg = {}) {
  const t = tmpHome();
  fs.writeFileSync(path.join(t.home, 'config.json'), JSON.stringify({ updates: false, mode: 'think', reveal: 'next-turn', ...cfg }));
  return t;
}

test('during: card appears the moment a prompt is submitted; answer when Claude finishes', () => {
  const t = during();
  const base = { session_id: 'wait-1', cwd: PROJECT };
  const now = Date.UTC(2026, 8, 29, 10);
  const card = JSON.parse(handle('prompt', { ...base, prompt: 'refactor the auth module' }, t.env, now)).systemMessage;
  assert.match(card, /THINK FIRST/);
  assert.match(card, /when Claude finishes/);
  const ans = JSON.parse(handle('stop', base, t.env, now + 30e3)).systemMessage;
  assert.match(ans, /ANSWER .*Claude is done/);
  t.cleanup();
});

test('during: a long run gets an answer, then a new card, every mid_run_interval', () => {
  const t = during({ mid_run_interval: '3m' });
  const base = { session_id: 'wait-2', cwd: PROJECT };
  const t0 = Date.UTC(2026, 8, 29, 10);
  assert.ok(handle('prompt', { ...base, prompt: 'migrate the whole codebase' }, t.env, t0));
  assert.equal(handle('tool', base, t.env, t0 + 60e3), '', 'not due yet');
  const a = JSON.parse(handle('tool', base, t.env, t0 + 181e3)).systemMessage;
  assert.match(a, /ANSWER .*still working/);
  assert.equal(handle('tool', base, t.env, t0 + 200e3), '');
  const c = JSON.parse(handle('tool', base, t.env, t0 + 362e3)).systemMessage;
  assert.match(c, /THINK FIRST/);
  // 2 hours of tool calls every 20 s -> about 40 cards/answers, never more than one per interval.
  let shown = 0;
  for (let s = 400; s < 7200; s += 20) if (handle('tool', base, t.env, t0 + s * 1e3)) shown += 1;
  assert.ok(shown >= 35 && shown <= 40, `shown ${shown}`);
  handle('stop', base, t.env, t0 + 7200e3);
  assert.equal(handle('tool', base, t.env, t0 + 7400e3), '', 'turn over: no mid-run cards');
  t.cleanup();
});

test('during: mid_run false means no cards during tool calls', () => {
  const t = during({ mid_run: false });
  const base = { session_id: 'wait-3', cwd: PROJECT };
  const t0 = Date.UTC(2026, 8, 29, 10);
  handle('prompt', { ...base, prompt: 'go' }, t.env, t0);
  for (let s = 0; s < 3600; s += 30) assert.equal(handle('tool', base, t.env, t0 + s * 1e3), '');
  t.cleanup();
});

test('during: slash commands and empty prompts never trigger a waiting card', () => {
  const t = during();
  const base = { session_id: 'wait-4', cwd: PROJECT };
  assert.equal(handle('prompt', { ...base, prompt: '   ' }, t.env), '');
  assert.equal(JSON.parse(handle('prompt', { ...base, prompt: '/devsharp:stats' }, t.env)).decision, 'block');
  t.cleanup();
});

test('during: the tool-call hook is cheap when nothing is due', () => {
  const t = during();
  const r = spawnSync(process.execPath, [HOOK, 'tool'], { input: '{"session_id":"none"}', env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const loaded = spawnSync(process.execPath, ['-e', `process.env.DEVSHARP_HOME=${JSON.stringify(t.home)};require(${JSON.stringify(HOOK)}).handle('tool',{session_id:'none'});console.log(Object.keys(require.cache).some(k=>k.includes('engine.js')))`], { encoding: 'utf8' });
  assert.equal(loaded.stdout.trim(), 'false', 'engine must not load on the fast path');
  t.cleanup();
});

test('default: one card holds the whole lesson (question + answer), nothing to reveal', () => {
  const t = tmpHome();
  fs.writeFileSync(path.join(t.home, 'config.json'), JSON.stringify({ updates: false, mode: 'think', mid_run_interval: '3m' }));
  const base = { session_id: 'inline-1', cwd: PROJECT };
  const t0 = Date.UTC(2026, 8, 29, 10);
  const card = JSON.parse(handle('prompt', { ...base, prompt: 'build the feature' }, t.env, t0)).systemMessage;
  assert.match(card, /THINK FIRST/);
  assert.match(card, /💡/);
  assert.ok(!/\/devsharp:reveal/.test(card), 'no command needed');
  // Mid-run brings a NEW full card (not a separate answer), and Stop adds nothing.
  const next = JSON.parse(handle('tool', base, t.env, t0 + 181e3)).systemMessage;
  assert.ok(!/ANSWER/.test(next) && /💡/.test(next));
  assert.equal(handle('stop', base, t.env, t0 + 200e3), '');
  t.cleanup();
});
