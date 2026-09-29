'use strict';
// Deterministic selection engine. No randomness: the same history, project and
// seed always produce the same card, so behaviour is testable and explainable.
//
//   score = relevance + difficulty fit + novelty + diversity + small hash tie-break
//   excluded: dismissed items, items marked known, off-interest topics, seen updates

const { hash32 } = require('./knowledge');

const MODE_SHARES = { think: 0.35, fact: 0.25, concept: 0.2, why: 0.1, update: 0.1 };
const MODE_ORDER = ['think', 'fact', 'concept', 'why', 'update'];
const DIFF_LEVEL = { easy: 1, medium: 2, hard: 3 };
const RECENT_WINDOW = 20;
const DAY = 86400e3;
const UPDATE_MAX_AGE = 45 * DAY;

function recentShown(state, n) {
  const out = [];
  for (let i = state.events.length - 1; i >= 0 && out.length < n; i -= 1) {
    if (state.events[i].e === 'shown') out.push(state.events[i]);
  }
  return out; // newest first
}

// Deficit round-robin over the recent window: pick the mode furthest below its target share.
function chooseMode(state, config, available) {
  if (config.mode !== 'mixed') {
    if (available[config.mode]) return config.mode;
    return MODE_ORDER.find((m) => available[m]) || null;
  }
  const shares = { ...MODE_SHARES };
  if (!config.think_first) shares.think = 0;
  if (!config.updates) shares.update = 0;
  for (const m of MODE_ORDER) if (!available[m]) shares[m] = 0;
  const total = Object.values(shares).reduce((a, b) => a + b, 0);
  if (!total) return MODE_ORDER.find((m) => available[m]) || null;
  const recent = recentShown(state, RECENT_WINDOW);
  const counts = {};
  for (const e of recent) counts[e.type] = (counts[e.type] || 0) + 1;
  const n = recent.length + 1;
  let best = null;
  let bestDeficit = -Infinity;
  for (const m of MODE_ORDER) {
    if (!shares[m]) continue;
    const deficit = (shares[m] / total) * n - (counts[m] || 0);
    if (deficit > bestDeficit + 1e-9) { best = m; bestDeficit = deficit; }
  }
  // Never the same mode three times in a row unless it is the only one.
  if (recent[0] && recent[1] && recent[0].type === best && recent[1].type === best) {
    const alt = MODE_ORDER.find((m) => shares[m] && m !== best);
    if (alt) best = alt;
  }
  return best;
}

function targetLevel(state, config, items, topic) {
  if (config.difficulty !== 'adaptive') return DIFF_LEVEL[config.difficulty] || 2;
  let seen = 0;
  let known = 0;
  for (const it of items) {
    if (it.topic !== topic) continue;
    const st = state.items[it.id];
    if (st && st.shown) seen += 1;
    if (st && st.known) known += 1;
  }
  if (seen < 3) return 1;
  if (known >= 3) return 3;
  return 2;
}

function interestFilter(config) {
  if (config.topics === 'auto' || !Array.isArray(config.topics)) return () => true;
  const set = new Set(config.topics);
  return (it) => set.has(it.topic) || set.has(it.category) || it.custom;
}

function projectWeights(projectTopics) {
  const w = new Map();
  for (const t of projectTopics || []) {
    if (t && typeof t.topic === 'string') w.set(t.topic, Math.max(w.get(t.topic) || 0, Number(t.weight) || 0));
  }
  return w;
}

function scoreItem(it, ctx) {
  const { state, now, weights, recent, levels, seed } = ctx;
  const reasons = [];
  let score = 0;
  const w = weights.get(it.topic) || 0;
  if (w) { score += 45 * w; reasons.push(`project uses ${it.topic}`); }
  let tagBonus = 0;
  for (const t of it.tags || []) if (weights.has(t)) tagBonus += 10;
  if (tagBonus) { score += Math.min(tagBonus, 20); reasons.push('related to project tags'); }

  const st = state.items[it.id];
  if (!st || !st.shown) {
    score += 25;
    reasons.push('new to you');
  } else {
    const days = (now - (st.last || 0)) / DAY;
    score -= 80 * Math.exp(-days / 21) + 5 * st.shown + (st.revealed ? 10 : 0);
    reasons.push(`seen ${st.shown}x`);
  }

  if (it.type !== 'update') {
    const target = levels.get(it.topic) || 2;
    const d = Math.abs((DIFF_LEVEL[it.difficulty] || 2) - target);
    score += d === 0 ? 12 : d === 1 ? 4 : -8;
  } else if (it.published) {
    const age = now - it.published;
    score += age < 7 * DAY ? 20 : age < 30 * DAY ? 10 : 0;
  }

  if (recent[0]) {
    if (recent[0].topic === it.topic) score -= 30;
    else if (recent[0].cat && recent[0].cat === it.category) score -= 6;
  }
  const inRecent = recent.slice(0, 6).filter((e) => e.topic === it.topic).length;
  score -= Math.min(12 * inRecent, 30);
  if (it.custom) score += 5;
  score += hash32(`${seed}|${it.id}`) % 8; // deterministic tie-break
  return { score, reasons };
}

function updateToItem(u, topicCategory) {
  return {
    id: u.id, type: 'update', topic: u.topic, category: topicCategory.get(u.topic) || 'updates',
    topicName: u.name || u.topic, difficulty: 'medium', title: u.title, url: u.url,
    published: u.published || null, source: { name: u.name, url: u.url }, tags: [],
  };
}

// Returns { item, mode, score, reasons } or null when nothing is eligible.
function selectCard({ items, updates = [], state, config, projectTopics = [], now = Date.now(), seed = '', mode = null }) {
  const allowed = interestFilter(config);
  const topicCategory = new Map(items.map((it) => [it.topic, it.category]));
  const pool = { fact: [], think: [], concept: [], why: [], update: [] };
  for (const it of items) {
    const st = state.items[it.id];
    if (st && (st.dismissed || st.known)) continue;
    if (!allowed(it)) continue;
    pool[it.type].push(it);
  }
  if (config.updates) {
    for (const u of updates) {
      const st = state.items[u.id];
      if (st && st.shown) continue; // headlines are shown once
      if (u.published && now - u.published > UPDATE_MAX_AGE) continue;
      const it = updateToItem(u, topicCategory);
      if (allowed(it)) pool.update.push(it);
    }
  }
  const available = Object.fromEntries(Object.entries(pool).map(([k, v]) => [k, v.length > 0]));
  const chosenMode = mode && available[mode] ? mode : chooseMode(state, config, available);
  if (!chosenMode) return null;

  const weights = config.project_awareness ? projectWeights(projectTopics) : new Map();
  const recent = recentShown(state, RECENT_WINDOW);
  const levels = new Map();
  for (const it of pool[chosenMode]) {
    if (!levels.has(it.topic)) levels.set(it.topic, targetLevel(state, config, items, it.topic));
  }
  const ctx = { state, now, weights, recent, levels, seed };
  let best = null;
  for (const it of pool[chosenMode]) {
    const { score, reasons } = scoreItem(it, ctx);
    if (!best || score > best.score || (score === best.score && it.id < best.item.id)) {
      best = { item: it, mode: chosenMode, score, reasons };
    }
  }
  return best;
}

module.exports = { selectCard, chooseMode, scoreItem, targetLevel, recentShown, MODE_SHARES };
