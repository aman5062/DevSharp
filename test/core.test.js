'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpHome, item, baseConfig } = require('./helpers');
const { paths } = require('../src/core/paths');
const config = require('../src/core/config');
const store = require('../src/core/store');
const { selectCard, chooseMode } = require('../src/core/select');
const { renderCard, renderAnswer, wrap, displayWidth } = require('../src/core/render');
const { computeStats, streak } = require('../src/core/stats');
const { loadKnowledge, normaliseItem } = require('../src/core/knowledge');

const NOW = Date.UTC(2026, 8, 29, 12);
const DAY = 86400e3;

// ---------------------------------------------------------------- config
test('config: defaults when file missing', () => {
  const t = tmpHome();
  const { config: c, warnings } = config.loadConfig(paths(t.env));
  assert.deepEqual(c, config.DEFAULTS);
  assert.equal(warnings.length, 0);
  t.cleanup();
});

test('config: invalid values fall back per key with warnings, unknown keys ignored', () => {
  const t = tmpHome();
  const p = paths(t.env);
  fs.writeFileSync(p.config, JSON.stringify({ frequency: 'ludicrous', card_width: 5000, enabled: false, rm: 'rf', telemetry: true, topics: 'databases, Networking' }));
  const { config: c, warnings } = config.loadConfig(p);
  assert.equal(c.frequency, 'medium');
  assert.equal(c.card_width, 64);
  assert.equal(c.enabled, false);
  assert.equal(c.telemetry, false, 'telemetry can never be switched on');
  assert.deepEqual(c.topics, ['databases', 'networking']);
  assert.ok(warnings.some((w) => w.includes('rm')));
  t.cleanup();
});

test('config: malformed JSON and non-object roots never throw', () => {
  const t = tmpHome();
  const p = paths(t.env);
  for (const bad of ['{nope', '[]', '"str"', 'null', '\u0000\u0001']) {
    fs.writeFileSync(p.config, bad);
    const { config: c } = config.loadConfig(p);
    assert.equal(c.frequency, 'medium');
  }
  t.cleanup();
});

test('config: set validates and persists', () => {
  const t = tmpHome();
  const p = paths(t.env);
  assert.equal(config.saveConfigValue(p, 'frequency', 'high'), 'high');
  assert.equal(config.saveConfigValue(p, 'minimum_interval', '15m'), '15m');
  assert.throws(() => config.saveConfigValue(p, 'frequency', 'always'));
  assert.throws(() => config.saveConfigValue(p, '__proto__', 'x'));
  const { config: c } = config.loadConfig(p);
  assert.equal(c.frequency, 'high');
  assert.equal(config.cadence(c).interval, 15 * 60e3);
  t.cleanup();
});

test('config: durations', () => {
  assert.equal(config.parseDuration('10m'), 600e3);
  assert.equal(config.parseDuration('1h'), 3600e3);
  assert.equal(config.parseDuration('30s'), 30e3);
  assert.equal(config.parseDuration('2d'), 2 * DAY);
  assert.equal(config.parseDuration('soon'), null);
});

// ---------------------------------------------------------------- store
test('store: corrupt state recovers to empty and is moved aside', () => {
  const t = tmpHome();
  const p = paths(t.env);
  fs.writeFileSync(p.state, '{"version":1,"items":');
  const s = store.loadState(p);
  assert.deepEqual(s.items, {});
  assert.ok(fs.readdirSync(t.home).some((f) => f.startsWith('state.json.corrupt-')));
  t.cleanup();
});

test('store: event log is bounded', () => {
  const t = tmpHome();
  const p = paths(t.env);
  const s = store.emptyState();
  for (let i = 0; i < store.MAX_EVENTS + 500; i += 1) store.record(s, 'shown', item(`redis-x-${i % 50}`), NOW + i);
  store.saveState(p, s);
  assert.equal(store.loadState(p).events.length, store.MAX_EVENTS);
  t.cleanup();
});

test('store: history tracks shown/revealed/dismissed/known', () => {
  const s = store.emptyState();
  const it = item('redis-a-001');
  store.record(s, 'shown', it, NOW);
  store.record(s, 'revealed', it, NOW + 1);
  store.record(s, 'known', it, NOW + 2);
  assert.deepEqual(
    { shown: s.items[it.id].shown, revealed: s.items[it.id].revealed, known: s.items[it.id].known },
    { shown: 1, revealed: true, known: true },
  );
  assert.equal(s.lastShownAt, NOW);
  assert.deepEqual(s.events.map((e) => e.e), ['shown', 'revealed', 'known']);
});

test('store: sessions are pruned after 24h', () => {
  const s = store.emptyState();
  store.session(s, 'old', NOW - 2 * DAY);
  store.session(s, 'new', NOW);
  store.pruneSessions(s, NOW);
  assert.deepEqual(Object.keys(s.sessions), ['new']);
});

test('store: hostile session ids are normalised', () => {
  const s = store.emptyState();
  store.session(s, '../../etc/passwd', NOW);
  store.session(s, '__proto__', NOW);
  assert.ok(!Object.keys(s.sessions).includes('../../etc/passwd'));
  assert.equal(Object.getPrototypeOf(s.sessions), Object.prototype);
});

// ---------------------------------------------------------------- selection
const pool = () => [
  item('redis-a-001', { topic: 'redis' }),
  item('redis-b-001', { topic: 'redis' }),
  item('go-a-001', { topic: 'go', category: 'languages' }),
  item('go-b-001', { topic: 'go', category: 'languages' }),
  item('tcp-a-001', { topic: 'tcp', category: 'networking' }),
  item('tcp-think-001', { topic: 'tcp', category: 'networking', type: 'think', question: 'Q?', answer: 'A.' }),
];
const factOnly = () => ({ ...baseConfig(), mode: 'fact' });

test('select: deterministic for identical inputs', () => {
  const a = selectCard({ items: pool(), state: store.emptyState(), config: factOnly(), now: NOW, seed: 's' });
  const b = selectCard({ items: pool(), state: store.emptyState(), config: factOnly(), now: NOW, seed: 's' });
  assert.equal(a.item.id, b.item.id);
});

test('select: project relevance wins', () => {
  const r = selectCard({ items: pool(), state: store.emptyState(), config: factOnly(), projectTopics: [{ topic: 'go', weight: 1 }], now: NOW, seed: 's' });
  assert.equal(r.item.topic, 'go');
  assert.ok(r.reasons.includes('project uses go'));
});

test('select: project awareness off ignores project', () => {
  const cfg = { ...factOnly(), project_awareness: false };
  const picks = new Set();
  for (let i = 0; i < 10; i += 1) picks.add(selectCard({ items: pool(), state: store.emptyState(), config: cfg, projectTopics: [{ topic: 'go', weight: 1 }], now: NOW, seed: `s${i}` }).item.topic);
  assert.ok(picks.size > 1);
});

test('select: dismissed and known items are never picked', () => {
  const s = store.emptyState();
  for (const id of ['redis-a-001', 'redis-b-001', 'go-a-001', 'tcp-a-001']) store.record(s, 'dismissed', item(id), NOW);
  store.record(s, 'known', item('go-b-001'), NOW);
  const r = selectCard({ items: pool(), state: s, config: factOnly(), now: NOW, seed: 's' });
  assert.equal(r.item.id, 'tcp-think-001', 'falls back to another mode when the fixed mode is exhausted');
  store.record(s, 'dismissed', item('tcp-think-001'), NOW);
  assert.equal(selectCard({ items: pool(), state: s, config: factOnly(), now: NOW, seed: 's' }), null);
});

test('select: anti-repetition — cycles through every item before repeating', () => {
  const s = store.emptyState();
  const items = pool().filter((i) => i.type === 'fact');
  const seen = [];
  for (let i = 0; i < items.length; i += 1) {
    const r = selectCard({ items, state: s, config: factOnly(), now: NOW + i * 60e3, seed: 'x' });
    seen.push(r.item.id);
    store.record(s, 'shown', r.item, NOW + i * 60e3);
  }
  assert.equal(new Set(seen).size, items.length, `repeated: ${seen}`);
});

test('select: topic diversity — does not show the same topic twice in a row when alternatives exist', () => {
  const s = store.emptyState();
  const items = pool().filter((i) => i.type === 'fact');
  let prev = null;
  for (let i = 0; i < 4; i += 1) {
    const r = selectCard({ items, state: s, config: factOnly(), projectTopics: [{ topic: 'redis', weight: 0.5 }], now: NOW + i, seed: 'y' });
    if (prev) assert.notEqual(r.item.topic, prev);
    prev = r.item.topic;
    store.record(s, 'shown', r.item, NOW + i);
  }
});

test('select: interest filter restricts topics/categories', () => {
  const cfg = { ...factOnly(), topics: ['networking'] };
  const r = selectCard({ items: pool(), state: store.emptyState(), config: cfg, now: NOW, seed: 's' });
  assert.equal(r.item.category, 'networking');
});

test('select: adaptive difficulty targets easy for a new topic', () => {
  const items = [item('go-e-001', { topic: 'go', difficulty: 'easy' }), item('go-h-001', { topic: 'go', difficulty: 'hard' })];
  const r = selectCard({ items, state: store.emptyState(), config: factOnly(), now: NOW, seed: 'z' });
  assert.equal(r.item.difficulty, 'easy');
  const hard = selectCard({ items, state: store.emptyState(), config: { ...factOnly(), difficulty: 'hard' }, now: NOW, seed: 'z' });
  assert.equal(hard.item.difficulty, 'hard');
});

test('select: mixed mode balances types over time (think gets the largest share)', () => {
  const items = [];
  for (const type of ['fact', 'think', 'concept', 'why']) {
    for (let i = 0; i < 30; i += 1) {
      items.push(item(`t-${type}-${i}`, { type, topic: `topic${i % 6}`, question: 'Q?', answer: 'A.' }));
    }
  }
  const s = store.emptyState();
  const counts = {};
  for (let i = 0; i < 40; i += 1) {
    const r = selectCard({ items, state: s, config: { ...baseConfig(), updates: false, ai: false }, now: NOW + i, seed: 'm' });
    counts[r.mode] = (counts[r.mode] || 0) + 1;
    store.record(s, 'shown', r.item, NOW + i);
  }
  assert.ok(counts.think >= counts.fact && counts.fact >= counts.why, JSON.stringify(counts));
  assert.ok(Object.keys(counts).length === 4);
});

test('select: think_first=false never picks think', () => {
  const s = store.emptyState();
  const cfg = { ...baseConfig(), think_first: false, updates: false, ai: false };
  for (let i = 0; i < 10; i += 1) {
    const r = selectCard({ items: pool(), state: s, config: cfg, now: NOW + i, seed: 'q' });
    if (!r) break;
    assert.notEqual(r.mode, 'think');
    store.record(s, 'shown', r.item, NOW + i);
  }
});

test('select: updates are shown once and old ones are skipped', () => {
  const ups = [
    { id: 'upd-aaaaaaaaaaaa', sourceId: 'go', topic: 'go', name: 'Go', title: 'Go 1.99 released', url: 'https://go.dev/blog/x', published: NOW - DAY },
    { id: 'upd-bbbbbbbbbbbb', sourceId: 'go', topic: 'go', name: 'Go', title: 'Ancient', url: 'https://go.dev/blog/y', published: NOW - 400 * DAY },
  ];
  const s = store.emptyState();
  const cfg = { ...baseConfig(), mode: 'update' };
  const r = selectCard({ items: pool(), updates: ups, state: s, config: cfg, now: NOW, seed: 'u' });
  assert.equal(r.item.id, 'upd-aaaaaaaaaaaa');
  store.record(s, 'shown', r.item, NOW);
  const r2 = selectCard({ items: pool(), updates: ups, state: s, config: cfg, now: NOW, seed: 'u' });
  assert.notEqual(r2 && r2.item.type, 'update');
});

test('select: chooseMode never repeats a mode three times when others exist', () => {
  const s = store.emptyState();
  store.record(s, 'shown', item('a-think-1', { type: 'think' }), NOW);
  store.record(s, 'shown', item('a-think-2', { type: 'think' }), NOW);
  const m = chooseMode(s, { ...baseConfig(), updates: false, ai: false }, { think: true, fact: true, concept: true, why: true, update: false });
  assert.notEqual(m, 'think');
});

// ---------------------------------------------------------------- render
test('render: wrap respects width and hard-breaks long urls', () => {
  const lines = wrap(`word ${'x'.repeat(100)} end`, 20);
  for (const l of lines) assert.ok(displayWidth(l) <= 20, l);
});

test('render: emoji are two columns wide', () => {
  assert.equal(displayWidth('🧠'), 2);
  assert.equal(displayWidth('ab'), 2);
});

test('render: every style renders a think card and hides the answer', () => {
  const it = item('tcp-think-001', { type: 'think', title: 'Handshake', question: 'Why three steps?', answer: 'SECRET ANSWER' });
  for (const style of ['rail', 'box', 'plain']) {
    const out = renderCard(it, { style, width: 64, reveal: 'next-turn' });
    assert.ok(out.includes('THINK FIRST'));
    assert.ok(out.includes('Why three steps?'));
    assert.ok(!out.includes('SECRET ANSWER'), 'answer must not leak before reveal');
    for (const line of out.split('\n')) assert.ok(displayWidth(line) <= 66, `${style}: ${line}`);
  }
  assert.ok(renderAnswer(it, {}).includes('SECRET ANSWER'));
});

test('render: box style lines are all equal width', () => {
  const out = renderCard(item('redis-a-001', { body: 'Redis 🧠 persistence uses RDB snapshots and AOF logs, 日本語 too.' }), { style: 'box', width: 50 });
  const widths = new Set(out.split('\n').map(displayWidth));
  assert.equal(widths.size, 1, out);
});

// ---------------------------------------------------------------- stats
test('stats: streak counts consecutive days including yesterday', () => {
  const d = (n) => store.dayKey(NOW - n * DAY);
  assert.equal(streak([d(3), d(2), d(1), d(0)], NOW), 4);
  assert.equal(streak([d(2), d(1)], NOW), 2);
  assert.equal(streak([d(5)], NOW), 0);
});

test('stats: counts', () => {
  const s = store.emptyState();
  const items = pool();
  store.record(s, 'shown', items[5], NOW);
  store.record(s, 'revealed', items[5], NOW);
  store.record(s, 'shown', items[0], NOW);
  store.record(s, 'known', items[0], NOW);
  const st = computeStats(s, items, NOW);
  assert.equal(st.seen, 2);
  assert.equal(st.revealed, 1);
  assert.equal(st.known, 1);
  assert.equal(st.thinks, 1);
  assert.equal(st.streak, 1);
  assert.equal(st.topics, 2);
});

// ---------------------------------------------------------------- knowledge
test('knowledge: bundled packs load and every item is valid', () => {
  const items = loadKnowledge(null);
  assert.ok(items.length >= 100, `only ${items.length} items`);
  const ids = new Set();
  for (const it of items) {
    assert.ok(!ids.has(it.id), `dup ${it.id}`);
    ids.add(it.id);
    assert.ok(it.source && it.source.url && it.source.url.startsWith('https://'), `source ${it.id}`);
  }
  for (const type of ['fact', 'think', 'concept', 'why']) assert.ok(items.some((i) => i.type === type), type);
});

test('knowledge: custom packs load; invalid items and symlinks are skipped; bundled ids cannot be overridden', () => {
  const t = tmpHome();
  const p = paths(t.env);
  fs.mkdirSync(p.packs, { recursive: true });
  const bundled = loadKnowledge(null)[0];
  fs.writeFileSync(path.join(p.packs, 'team.json'), JSON.stringify({
    schema: 1, topic: 'acme', category: 'custom', name: 'Acme',
    items: [
      { id: 'acme-deploy-001', type: 'fact', title: 'Deploys', body: 'We deploy with Argo.' },
      { id: bundled.id, type: 'fact', title: 'HIJACK', body: 'x' },
      { id: '../evil', type: 'fact', title: 'x', body: 'x' },
      { id: 'acme-bad-001', type: 'think', title: 'no question' },
    ],
  }));
  const outside = path.join(t.home, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ topic: 'x', category: 'custom', items: [{ id: 'x-evil-001', type: 'fact', title: 'E', body: 'E' }] }));
  try { fs.symlinkSync(outside, path.join(p.packs, 'link.json')); } catch { /* windows without privilege */ }
  const items = loadKnowledge(p);
  assert.ok(items.some((i) => i.id === 'acme-deploy-001' && i.custom));
  assert.ok(!items.some((i) => i.title === 'HIJACK'));
  assert.ok(!items.some((i) => i.id === 'x-evil-001'));
  assert.ok(!items.some((i) => i.id === 'acme-bad-001'));
  t.cleanup();
});

test('knowledge: item text is sanitised on load', () => {
  const it = normaliseItem({ id: 'x-ansi-001', type: 'fact', title: '\u001b[31mRed\u001b[0m', body: 'a\u001b]52;c;ZXZpbA==\u0007b\u202e', source: { name: 'S', url: 'javascript:alert(1)' } }, { topic: 'x', category: 'custom' });
  assert.equal(it.title, 'Red');
  assert.equal(it.body, 'ab');
  assert.equal(it.source.url, null);
});

test('render: wrap terminates when a character is wider than the line', () => {
  assert.deepEqual(wrap('日本', 1), ['日', '本']);
  assert.deepEqual(wrap('ab', 0), ['a', 'b']);
});
