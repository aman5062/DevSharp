#!/usr/bin/env node
'use strict';
// Measures what DevSharp costs per hook invocation: wall time, CPU time, peak RSS.
// Usage: node scripts/bench.js [runs=20]

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'src', 'claude', 'hook.js');
const RUNS = Number(process.argv[2]) || 20;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devsharp-bench-'));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ updates: false, ai: false, frequency: 'high', minimum_interval: '0s' }));
const env = { ...process.env, DEVSHARP_HOME: home };
const timeBin = fs.existsSync('/usr/bin/time') ? '/usr/bin/time' : null;

function once(event, input) {
  const t0 = process.hrtime.bigint();
  const args = timeBin ? ['-f', '%e %U %S %M', process.execPath, HOOK, event] : [HOOK, event];
  const r = spawnSync(timeBin || process.execPath, args, { input: JSON.stringify(input), env, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let cpu = null; let rss = null;
  if (timeBin) {
    const [, u, s, m] = r.stderr.trim().split('\n').pop().split(' ').map(Number);
    cpu = (u + s) * 1000; rss = m / 1024;
  }
  return { ms, cpu, rss, out: r.stdout };
}

function stats(xs) {
  const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
  if (!s.length) return 'n/a';
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `p50 ${q(0.5).toFixed(1)}  p95 ${q(0.95).toFixed(1)}  max ${s[s.length - 1].toFixed(1)}`;
}

const base = { session_id: 'bench', cwd: ROOT };
const rows = [
  ['session-start', () => once('session-start', base)],
  ['prompt (normal)', () => once('prompt', { ...base, prompt: 'refactor the parser' })],
  ['prompt (/devsharp:stats)', () => once('prompt', { ...base, prompt: '/devsharp:stats' })],
  ['stop (card shown)', () => once('stop', base)],
  ['session-end', () => once('session-end', base)],
];
const baseline = [];
for (let i = 0; i < RUNS; i += 1) {
  const t0 = process.hrtime.bigint();
  spawnSync(process.execPath, ['-e', '0']);
  baseline.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
console.log(`DevSharp hook benchmark — ${RUNS} runs each, Node ${process.version}, ${os.platform()} ${os.cpus()[0].model}`);
console.log(`${'bare `node -e 0`'.padEnd(26)} wall ms: ${stats(baseline)}`);
for (const [name, fn] of rows) {
  const res = Array.from({ length: RUNS }, fn);
  console.log(`${name.padEnd(26)} wall ms: ${stats(res.map((r) => r.ms))} | cpu ms: ${stats(res.map((r) => r.cpu))} | rss MB: ${stats(res.map((r) => r.rss))}`);
}
const du = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((a, d) => a + (d.isDirectory() ? du(path.join(dir, d.name)) : fs.statSync(path.join(dir, d.name)).size), 0);
console.log(`state on disk after ${RUNS * rows.length} hook calls: ${(du(home) / 1024).toFixed(1)} KB`);
fs.rmSync(home, { recursive: true, force: true });
