'use strict';
const fs = require('fs');
const path = require('path');

// Read a JSON file. Missing file -> fallback. Corrupt file -> moved aside and fallback,
// so one bad write can never wedge the hooks.
function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    return fallback;
  }
}

// Atomic write: temp file in the same directory, then rename.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// True when `child` resolves inside `parent` (after symlink resolution).
function isInside(parent, child) {
  let p, c;
  try {
    p = fs.realpathSync(parent);
    c = fs.realpathSync(child);
  } catch {
    return false;
  }
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { readJson, writeJson, isInside };
