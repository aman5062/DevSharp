'use strict';
// Learning statistics, derived entirely from local history.

const { dayKey } = require('./store');

function streak(days, now) {
  if (!days.length) return 0;
  const set = new Set(days);
  let d = new Date(now);
  // A streak is still alive if today has no card yet but yesterday did.
  if (!set.has(dayKey(d.getTime()))) d = new Date(d.getTime() - 86400e3);
  let n = 0;
  while (set.has(dayKey(d.getTime()))) {
    n += 1;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12);
  }
  return n;
}

function computeStats(state, items, now = Date.now()) {
  const byId = new Map(items.map((it) => [it.id, it]));
  let seen = 0; let revealed = 0; let known = 0; let dismissed = 0; let thinks = 0; let updates = 0;
  const topicScore = new Map();
  const topics = new Set();
  const catSeen = new Map();
  for (const [id, st] of Object.entries(state.items)) {
    const it = byId.get(id);
    if (id.startsWith('upd-')) { if (st.shown) updates += 1; continue; }
    if (!st.shown) continue;
    seen += 1;
    if (st.revealed) revealed += 1;
    if (st.known) known += 1;
    if (st.dismissed) dismissed += 1;
    if (!it) continue;
    topics.add(it.topic);
    catSeen.set(it.category, (catSeen.get(it.category) || 0) + 1);
    if (it.type === 'think' || it.type === 'why') thinks += 1;
    topicScore.set(it.topicName || it.topic, (topicScore.get(it.topicName || it.topic) || 0) + 1 + (st.known ? 2 : 0) + (st.revealed ? 1 : 0));
  }
  const strong = [...topicScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
  const allCats = [...new Set(items.filter((i) => !i.custom).map((i) => i.category))];
  const explore = allCats.sort((a, b) => (catSeen.get(a) || 0) - (catSeen.get(b) || 0) || a.localeCompare(b)).slice(0, 3);
  return {
    seen, revealed, known, dismissed, thinks, updates,
    topics: topics.size,
    streak: streak(state.days, now),
    strong, explore,
    catalogue: items.length,
  };
}

const prettyCat = (c) => c.split('-').map((w) => (w === 'ai' ? 'AI' : w === 'ml' ? 'ML' : w[0].toUpperCase() + w.slice(1))).join(' ').replace('AI ML', 'AI/ML');

function formatStats(s) {
  const lines = [
    `Cards seen:        ${s.seen} of ${s.catalogue}`,
    `Answers revealed:  ${s.revealed}`,
    `Marked known:      ${s.known}`,
    `Think questions:   ${s.thinks}`,
    `Topics explored:   ${s.topics}`,
    `Tech updates read: ${s.updates}`,
    `Current streak:    ${s.streak} day${s.streak === 1 ? '' : 's'}`,
  ];
  if (s.strong.length) lines.push('', 'Strong areas:', ...s.strong.map((t) => `  ${t}`));
  if (s.explore.length) lines.push('', 'Explore more:', ...s.explore.map((c) => `  ${prettyCat(c)}`));
  return lines;
}

module.exports = { computeStats, formatStats, streak, prettyCat };
