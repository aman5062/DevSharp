'use strict';
// Tiny per-session "next mid-run card due at" map, read on EVERY tool call.
// Kept separate from state.json and dependency-free so the common case
// (not due yet) costs one small file read and no engine load.

const fs = require('fs');
const path = require('path');

function midrunPath(p) {
  return path.join(p.cache, 'midrun.json');
}

function isDue(p, sessionId, now = Date.now()) {
  let map;
  try { map = JSON.parse(fs.readFileSync(midrunPath(p), 'utf8')); } catch { return false; }
  if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, sessionId)) return false;
  const due = map[sessionId];
  return Number.isFinite(due) && now >= due;
}

module.exports = { midrunPath, isDue };
