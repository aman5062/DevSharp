#!/usr/bin/env node
'use strict';
// DevSharp standalone CLI. Works with or without Claude Code; never calls an LLM.

const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../src/core/engine');
const { paths } = require('../src/core/paths');
const store = require('../src/core/store');
const { loadKnowledge } = require('../src/core/knowledge');
const { renderAnswer } = require('../src/core/render');
const { loadConfig } = require('../src/core/config');

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

function colorize(text) {
  return text.split('\n').map((l, i) => (i === 0 ? bold(c('36', l)) : l.startsWith('╰─') || l.startsWith('│') ? c('36', l.slice(0, 1)) + l.slice(1) : l)).join('\n');
}

function usage() {
  const cmds = Object.entries(engine.COMMANDS).map(([k, v]) => `  ${k.padEnd(9)} ${v}`);
  return [
    `${bold('devsharp')} — learning cards for developers who code with AI (zero LLM tokens)`,
    '',
    'Usage: devsharp <command> [args]',
    '',
    ...cmds,
    `  ${'doctor'.padEnd(9)} Check the installation`,
    `  ${'statusline'.padEnd(9)} One-line teaser for Claude Code's statusLine setting`,
    `  ${'setup'.padEnd(9)} Connect another AI CLI: setup codex | gemini | opencode  [--remove]`,
    `  ${'watch'.padEnd(9)} Companion pane for ANY AI CLI: a new card every minute  [--every 2m]`,
    '',
    'Inside Claude Code the same commands are available as /devsharp:<command>.',
  ].join('\n');
}

// Interactive card: Enter reveals, k = known, d = dismiss, Esc/q closes. Ctrl+C always works.
function interactive(text) {
  const p = paths();
  const state = store.loadState(p);
  const pend = Object.prototype.hasOwnProperty.call(state.sessions, 'cli') ? state.sessions.cli.pending : null;
  process.stdout.write(`${colorize(text)}\n`);
  if (!process.stdin.isTTY || !pend) return Promise.resolve();
  const keys = pend.hasAnswer ? 'Enter reveal · k known · d dismiss · Esc close' : 'k known · d dismiss · Esc close';
  process.stdout.write(dim(`  ${keys}\n`));
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onKey);
      resolve();
    };
    const onKey = (buf) => {
      const k = buf.toString();
      if (k === '\u0003') { done(); process.exitCode = 130; return; }
      if (k === '\r' || k === '\n') {
        if (!pend.hasAnswer) return;
        const { text: ans } = engine.runCommand('reveal', [], { sessionId: 'cli' });
        process.stdout.write(`\n${colorize(ans)}\n`);
        return done();
      }
      if (k === 'k' || k === 'd') {
        const { text: t } = engine.runCommand(k === 'k' ? 'known' : 'dismiss', [], { sessionId: 'cli' });
        process.stdout.write(`\n${colorize(t)}\n`);
        return done();
      }
      if (k === '\u001b' || k === 'q') return done();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
  });
}

function doctor() {
  const p = paths();
  const ok = (b, msg) => `${b ? c('32', '✓') : c('31', '✗')} ${msg}`;
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(ok(major >= 18, `Node.js ${process.versions.node} (need >= 18)`));
  let writable = false;
  try { fs.mkdirSync(p.home, { recursive: true }); fs.accessSync(p.home, fs.constants.W_OK); writable = true; } catch { /* no */ }
  lines.push(ok(writable, `Data directory writable: ${p.home}`));
  const items = loadKnowledge(p);
  lines.push(ok(items.length > 0, `Knowledge loaded: ${items.length} cards`));
  const { warnings } = loadConfig(p);
  lines.push(ok(!warnings.length, warnings.length ? `Config warnings: ${warnings.join('; ')}` : 'Config valid'));
  const installed = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let plugin = false;
  try { plugin = Object.keys(JSON.parse(fs.readFileSync(installed, 'utf8')).plugins || {}).some((k) => k.startsWith('devsharp@')); } catch { /* ignore */ }
  lines.push(ok(plugin, plugin ? 'Claude Code plugin installed' : 'Claude Code plugin not found in ~/.claude/plugins (fine if you use --plugin-dir)'));
  const { handle } = require('../src/claude/hook');
  let hookOk = false;
  try { hookOk = JSON.parse(handle('prompt', { prompt: '/devsharp:help', session_id: 'doctor' })).decision === 'block'; } catch { /* no */ }
  lines.push(ok(hookOk, 'Hook handler intercepts /devsharp:* commands locally'));
  lines.push(ok(true, 'LLM calls: none (DevSharp contains no model client)'));
  return lines.join('\n');
}

// Claude Code statusLine command: reads the status JSON on stdin, prints one line.
async function statusline() {
  let raw = '';
  if (!process.stdin.isTTY) {
    raw = await new Promise((resolve) => {
      let d = '';
      process.stdin.on('data', (x) => { d += x; }).on('end', () => resolve(d)).on('error', () => resolve(d));
      setTimeout(() => resolve(d), 300).unref();
    });
  }
  let sid = 'cli';
  try { sid = JSON.parse(raw).session_id || sid; } catch { /* ignore */ }
  const p = paths();
  const { config } = loadConfig(p);
  if (!config.enabled) return '';
  const state = store.loadState(p);
  const key = store.sessionKey(sid);
  const sess = Object.prototype.hasOwnProperty.call(state.sessions, key) ? state.sessions[key] : null;
  if (sess && sess.pending && sess.pending.hasAnswer && !sess.pending.revealed) {
    const it = loadKnowledge(p).find((i) => i.id === sess.pending.id);
    if (it) return `🧠 ${it.title} · /devsharp:reveal`;
  }
  const { computeStats } = require('../src/core/stats');
  const s = computeStats(state, [], Date.now());
  return s.streak ? `🎯 DevSharp · ${s.streak}-day streak` : '🎯 DevSharp';
}

function setupCmd(args) {
  const { setup } = require('../src/hosts/setup');
  const remove = args.includes('--remove');
  const hosts = args.filter((a) => !a.startsWith('--'));
  if (!hosts.length) {
    console.log([
      'Connect DevSharp to another AI coding CLI:',
      '  devsharp setup codex       OpenAI Codex CLI (hooks in ~/.codex/hooks.json)',
      '  devsharp setup gemini      Gemini CLI (hooks in ~/.gemini/settings.json)',
      '  devsharp setup opencode    opencode (plugin in ~/.config/opencode/plugins/)',
      '  add --remove to undo. Claude Code: install the plugin instead.',
      '  Any other CLI (Freebuff, Codebuff, Aider, Copilot, Cursor...): run `devsharp watch` in a split pane.',
    ].join('\n'));
    return;
  }
  for (const h of hosts) {
    try {
      const r = setup(h, { remove });
      console.log(`${c('32', '✓')} ${remove ? 'Removed DevSharp from' : 'Connected DevSharp to'} ${h}: ${r.file || 'nothing to remove'}${!remove && h !== 'opencode' ? ' (backup: .devsharp-backup)' : ''}`);
    } catch (e) {
      console.error(`${c('31', '✗')} ${h}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (!remove) console.log('Restart that CLI. Cards appear while it works; manage DevSharp with `devsharp <command>` in a terminal.');
}

// Universal companion: works next to any AI CLI (tmux/terminal split). Shows a card,
// waits, shows the next one. n = next now, k = known, d = dismiss, q/Esc/Ctrl+C = quit.
function watch(args) {
  const { parseDuration } = require('../src/core/config');
  const i = args.indexOf('--every');
  const every = Math.max(15e3, parseDuration(i >= 0 ? args[i + 1] : '1m') || 60e3);
  const tty = process.stdout.isTTY;
  let timer = null;
  let left = 0;
  const show = () => {
    const { text } = engine.runCommand('next', [], { sessionId: 'watch' });
    if (tty) process.stdout.write('\u001b[2J\u001b[H');
    process.stdout.write(`${colorize(text)}\n`);
    left = Math.round(every / 1000);
    if (tty) process.stdout.write(dim(`\n  next card in ${left}s · n next · k known · d dismiss · q quit\n`));
  };
  const tick = () => { left -= 1; if (left <= 0) show(); };
  show();
  timer = setInterval(tick, 1000);
  if (!tty || !process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (b) => {
    const k = b.toString();
    if (k === 'q' || k === '\u001b' || k === '\u0003') {
      clearInterval(timer);
      process.stdin.setRawMode(false);
      process.stdout.write('\n');
      process.exit(0);
    }
    if (k === 'n') show();
    if (k === 'k' || k === 'd') {
      engine.runCommand(k === 'k' ? 'known' : 'dismiss', [], { sessionId: 'watch' });
      show();
    }
  });
}

async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return console.log(usage());
  if (cmd === '-v' || cmd === '--version') return console.log(require('../package.json').version);
  if (cmd === 'doctor') return console.log(doctor());
  if (cmd === 'statusline') return process.stdout.write(`${await statusline()}\n`);
  if (cmd === 'setup') return setupCmd(args);
  if (cmd === 'watch') return watch(args);
  if (!engine.COMMANDS[cmd]) {
    console.error(`Unknown command "${cmd}".\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  const res = engine.runCommand(cmd, args, { sessionId: 'cli', foreground: true });
  if (cmd === 'next' && res.text && !/No cards available/.test(res.text)) return interactive(res.text);
  if (res.async) {
    process.stdout.write(`${colorize(res.text)}\n`);
    try { console.log(colorize(await res.async)); } catch (e) { console.error(`Update failed: ${e.message}`); process.exitCode = 1; }
    return;
  }
  console.log(colorize(res.text));
}

module.exports = { renderAnswer };
main();
