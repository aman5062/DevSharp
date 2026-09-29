'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpHome } = require('./helpers');
const { setup, HOOK } = require('../src/hosts/setup');
const { handle } = require('../src/claude/hook');

test('codex: adds hooks, keeps the user\'s own hooks and settings, and removes cleanly', () => {
  const t = tmpHome();
  const file = path.join(t.home, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = { description: 'mine', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-stop.sh' }] }] } };
  fs.writeFileSync(file, JSON.stringify(mine));
  setup('codex', { home: t.home });
  setup('codex', { home: t.home }); // idempotent
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.description, 'mine');
  assert.equal(cfg.hooks.Stop.length, 2, 'user hook + one devsharp hook');
  assert.ok(cfg.hooks.UserPromptSubmit[0].hooks[0].command.includes(HOOK));
  assert.ok(cfg.hooks.UserPromptSubmit[0].hooks[0].command.includes('--host=codex'));
  assert.ok(fs.existsSync(`${file}.devsharp-backup`));
  setup('codex', { home: t.home, remove: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), mine);
  t.cleanup();
});

test('gemini: merges into settings.json without touching other keys', () => {
  const t = tmpHome();
  const file = path.join(t.home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', model: { name: 'x' } }));
  setup('gemini', { home: t.home });
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.theme, 'dark');
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['AfterAgent', 'AfterTool', 'BeforeAgent', 'SessionEnd', 'SessionStart']);
  setup('gemini', { home: t.home, remove: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark', model: { name: 'x' } });
  t.cleanup();
});

test('setup refuses to edit an unparseable settings file', () => {
  const t = tmpHome();
  const file = path.join(t.home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ // comments not JSON');
  assert.throws(() => setup('gemini', { home: t.home }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ // comments not JSON');
  t.cleanup();
});

test('opencode: writes and removes the plugin file', () => {
  const t = tmpHome();
  const old = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  const r = setup('opencode', { home: t.home });
  const src = fs.readFileSync(r.file, 'utf8');
  assert.match(src, /showToast/);
  assert.match(src, /--host=opencode/);
  setup('opencode', { home: t.home, remove: true });
  assert.ok(!fs.existsSync(r.file));
  if (old) process.env.XDG_CONFIG_HOME = old;
  t.cleanup();
});

test('unknown host is rejected', () => {
  assert.throws(() => setup('rm -rf', {}), /Unknown host/);
});

test('non-Claude hosts: /devsharp:* prompts are ignored (no block), cards are systemMessage only', () => {
  const t = tmpHome();
  fs.writeFileSync(path.join(t.home, 'config.json'), JSON.stringify({ updates: false, ai: false }));
  for (const host of ['codex', 'gemini', 'opencode']) {
    assert.equal(handle('prompt', { session_id: host, prompt: '/devsharp:stats' }, t.env, Date.now(), host), '');
    const out = handle('prompt', { session_id: `${host}-2`, prompt: 'build it' }, t.env, Date.now(), host);
    if (out) assert.deepEqual(Object.keys(JSON.parse(out)), ['systemMessage']);
  }
  t.cleanup();
});
