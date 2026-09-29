'use strict';
// Local learning history. One small JSON file, bounded in size:
//   items    per-item progress (shown count, revealed, dismissed, known, last shown)
//   events   append-only log, capped (for stats, diversity and mode balancing)
//   sessions per-Claude-session state (turn counter, pending card), pruned after 24h
//   days     active learning days (for the streak), capped
//
// Concurrency: several Claude sessions may share this file. Writes are atomic
// (temp + rename); a lost update in a race costs at most one history event.

const { readJson, writeJson } = require('./fsutil');

const MAX_EVENTS = 3000;
const MAX_DAYS = 400;
const SESSION_TTL = 24 * 3600e3;
const EVENT_TYPES = ['shown', 'revealed', 'dismissed', 'known', 'skipped'];

function emptyState() {
  return { version: 1, lastShownAt: 0, snoozeUntil: 0, items: {}, events: [], sessions: {}, days: [] };
}

function loadState(p) {
  const s = readJson(p.state, null);
  if (!s || typeof s !== 'object' || s.version !== 1) return emptyState();
  const base = emptyState();
  for (const k of Object.keys(base)) {
    if (s[k] === undefined || typeof s[k] !== typeof base[k] || Array.isArray(s[k]) !== Array.isArray(base[k])) s[k] = base[k];
  }
  return s;
}

function saveState(p, state) {
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  if (state.days.length > MAX_DAYS) state.days = state.days.slice(-MAX_DAYS);
  writeJson(p.state, state);
}

function dayKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function itemState(state, id) {
  if (!/^[a-z0-9]/.test(id)) throw new Error('invalid item id');
  if (!Object.prototype.hasOwnProperty.call(state.items, id)) {
    state.items[id] = { shown: 0, last: 0, revealed: false, dismissed: false, known: false };
  }
  return state.items[id];
}

function record(state, event, item, now, extra = {}) {
  if (!EVENT_TYPES.includes(event)) throw new Error(`unknown event ${event}`);
  const st = itemState(state, item.id);
  if (event === 'shown') {
    st.shown += 1;
    st.last = now;
    state.lastShownAt = now;
    const d = dayKey(now);
    if (state.days[state.days.length - 1] !== d) state.days.push(d);
  }
  if (event === 'revealed') st.revealed = true;
  if (event === 'dismissed') st.dismissed = true;
  if (event === 'known') st.known = true;
  state.events.push({
    t: now, e: event, id: item.id, topic: item.topic, type: item.type, cat: item.category, diff: item.difficulty, ...extra,
  });
}

function sessionKey(sid) {
  return typeof sid === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sid) ? sid : 'cli';
}

function session(state, sid, now) {
  const key = sessionKey(sid);
  if (!Object.prototype.hasOwnProperty.call(state.sessions, key)) {
    state.sessions[key] = { startedAt: now, seen: now, turns: 0, sinceCard: 0, pending: null, cwd: null };
  }
  const s = state.sessions[key];
  s.seen = now;
  return s;
}

function pruneSessions(state, now) {
  for (const [k, s] of Object.entries(state.sessions)) {
    if (!s || now - (s.seen || 0) > SESSION_TTL) delete state.sessions[k];
  }
}

// The most recent card shown in any session (fallback for /devsharp:reveal after /clear).
function lastShown(state) {
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    if (state.events[i].e === 'shown') return state.events[i];
  }
  return null;
}

module.exports = {
  loadState, saveState, emptyState, record, session, sessionKey, pruneSessions, itemState, lastShown, dayKey,
  MAX_EVENTS, EVENT_TYPES,
};
