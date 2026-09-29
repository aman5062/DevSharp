'use strict';
// Knowledge packs: bundled (knowledge/<category>/<topic>.json) plus user packs
// (~/.config/devsharp/packs/*.json). Every item is validated and sanitised on
// load, so a malformed or hostile custom pack cannot break rendering.
//
// Scaling: knowledge/index.json lists every pack with its topic and item count.
// When the catalogue is small everything is loaded (a few ms). Beyond
// LOAD_ALL_LIMIT items only the packs for the relevant topics plus a rotating
// exploration sample are read, so per-card cost stays flat as packs grow.

const fs = require('fs');
const path = require('path');
const { PKG_ROOT } = require('./paths');
const { readJson, isInside } = require('./fsutil');
const { cleanText, cleanUrl } = require('./sanitize');

const KNOWLEDGE_DIR = path.join(PKG_ROOT, 'knowledge');
const LOAD_ALL_LIMIT = 5000;
const EXPLORE_PACKS = 6;
const TYPES = ['fact', 'think', 'concept', 'why'];
const DIFFS = ['easy', 'medium', 'hard'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,80}$/;
const TOPIC_RE = /^[a-z0-9-]{1,40}$/;
const MAX_CUSTOM_FILE = 2 * 1024 * 1024;

function normaliseItem(raw, pack) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_RE.test(id)) return null;
  const type = TYPES.includes(raw.type) ? raw.type : null;
  if (!type) return null;
  const topic = typeof raw.topic === 'string' && TOPIC_RE.test(raw.topic) ? raw.topic : pack.topic;
  const item = {
    id,
    type,
    topic,
    category: pack.category,
    topicName: cleanText(pack.name || topic, { maxLen: 40, multiline: false }),
    difficulty: DIFFS.includes(raw.difficulty) ? raw.difficulty : 'medium',
    title: cleanText(raw.title, { maxLen: 80, multiline: false }),
    body: cleanText(raw.body, { maxLen: 600 }),
    question: cleanText(raw.question, { maxLen: 400 }),
    answer: cleanText(raw.answer, { maxLen: 800 }),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string' && TOPIC_RE.test(t)).slice(0, 10) : [],
    source: null,
    custom: !!pack.custom,
  };
  if (raw.source && typeof raw.source === 'object') {
    const url = cleanUrl(raw.source.url);
    const name = cleanText(raw.source.name, { maxLen: 80, multiline: false });
    if (name || url) item.source = { name, url };
  }
  if (!item.title) return null;
  if ((type === 'fact' || type === 'concept') && !item.body) return null;
  if ((type === 'think' || type === 'why') && (!item.question || !item.answer)) return null;
  return item;
}

function readPack(file, { custom = false } = {}) {
  const data = readJson(file, null);
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return [];
  const topic = typeof data.topic === 'string' && TOPIC_RE.test(data.topic) ? data.topic : null;
  const category = typeof data.category === 'string' && TOPIC_RE.test(data.category) ? data.category : (custom ? 'custom' : null);
  if (!topic || !category) return [];
  const pack = { topic, category, name: data.name, custom };
  const out = [];
  for (const raw of data.items.slice(0, 20000)) {
    const it = normaliseItem(raw, pack);
    if (it) out.push(it);
  }
  return out;
}

function loadIndex(dir = KNOWLEDGE_DIR) {
  const idx = readJson(path.join(dir, 'index.json'), null);
  if (idx && Array.isArray(idx.packs)) return idx;
  // No index (e.g. during development): scan the tree.
  const packs = [];
  let cats = [];
  try { cats = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* none */ }
  for (const c of cats) {
    for (const f of fs.readdirSync(path.join(dir, c.name))) {
      if (f.endsWith('.json')) packs.push({ file: `${c.name}/${f}`, category: c.name, topic: f.slice(0, -5), count: 0 });
    }
  }
  return { packs, total: 0 };
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// wantTopics: topics relevant right now (project + interests). seed: rotates the exploration sample.
function loadKnowledge(p, { wantTopics = null, seed = '', dir = KNOWLEDGE_DIR } = {}) {
  const idx = loadIndex(dir);
  let packs = idx.packs.filter((pk) => typeof pk.file === 'string' && !pk.file.includes('..'));
  if (wantTopics && (idx.total || 0) > LOAD_ALL_LIMIT) {
    const want = new Set(wantTopics);
    const chosen = packs.filter((pk) => want.has(pk.topic) || want.has(pk.category));
    const rest = packs.filter((pk) => !chosen.includes(pk))
      .sort((a, b) => hash32(seed + a.file) - hash32(seed + b.file))
      .slice(0, EXPLORE_PACKS);
    packs = chosen.concat(rest);
  }
  const items = [];
  const seen = new Set();
  const add = (list) => {
    for (const it of list) {
      if (seen.has(it.id)) continue; // first definition wins; bundled ids cannot be hijacked
      seen.add(it.id);
      items.push(it);
    }
  };
  for (const pk of packs) add(readPack(path.join(dir, pk.file)));
  if (p) add(loadCustomPacks(p));
  return items;
}

function loadCustomPacks(p) {
  let names = [];
  try { names = fs.readdirSync(p.packs); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) continue;
    const file = path.join(p.packs, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_CUSTOM_FILE) continue; // no symlinks, no huge files
      if (!isInside(p.packs, file)) continue;
    } catch { continue; }
    out.push(...readPack(file, { custom: true }));
  }
  return out;
}

module.exports = { loadKnowledge, loadIndex, readPack, normaliseItem, hash32, KNOWLEDGE_DIR, TYPES };
