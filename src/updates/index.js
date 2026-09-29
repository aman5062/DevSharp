'use strict';
// Technology-update feeds: source loading/validation, cache, refresh, and the
// detached background refresher. Fetched content is only ever stored as
// sanitized plain text + https links; nothing from the network is executed.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PKG_ROOT } = require('../core/paths');
const { readJson, writeJson } = require('../core/fsutil');
const { cleanText, cleanUrl } = require('../core/sanitize');
const { fetchText } = require('./fetch');
const { parseFeed, parseGithubReleases, sourceAllowHosts } = require('./parse');

const BUNDLED_SOURCES = path.join(PKG_ROOT, 'updates', 'sources.json');
const REFRESH_SCRIPT = path.join(__dirname, 'refresh.js');
const CACHE_VERSION = 1;
const MAX_ITEMS = 200;
const PER_SOURCE = 20; // keep chatty feeds from crowding out the rest
const RC_TAG = /\bv?\d+(?:\.\d+)+-?rc\d*\b/i; // release-candidate tags are noise for a headline
const MAX_SOURCES = 50;
const CONCURRENCY = 4;
const LOCK_STALE_MS = 60_000;

const ID_RE = /^[a-z0-9-]{1,40}$/;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ITEM_ID_RE = /^upd-[0-9a-f]{12}$/;
const TYPES = new Set(['github-releases', 'feed']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Returns a normalized source or null when anything is off.
function validateSource(s) {
  if (!isObj(s)) return null;
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) return null;
  if (typeof s.topic !== 'string' || !TOPIC_RE.test(s.topic)) return null;
  if (typeof s.type !== 'string' || !TYPES.has(s.type)) return null;
  if (typeof s.name !== 'string') return null;
  const name = cleanText(s.name, { maxLen: 60, multiline: false });
  if (!name) return null;
  const out = { id: s.id, name, topic: s.topic, type: s.type };
  if (s.type === 'github-releases') {
    if (typeof s.repo !== 'string' || !REPO_RE.test(s.repo) || s.repo.split('/').some((p) => p === '.' || p === '..')) return null;
    out.repo = s.repo;
    out.url = `https://api.github.com/repos/${s.repo}/releases?per_page=10`;
  } else {
    const url = cleanUrl(typeof s.url === 'string' ? s.url : '');
    if (!url) return null;
    out.url = url;
    if (s.allow_hosts !== undefined) {
      if (!Array.isArray(s.allow_hosts) || s.allow_hosts.length > 10) return null;
      if (!s.allow_hosts.every((h) => typeof h === 'string' && HOST_RE.test(h))) return null;
      out.allow_hosts = s.allow_hosts.slice();
    }
  }
  return out;
}

function loadSources(p) {
  const bundled = readJson(BUNDLED_SOURCES, null);
  const user = p && p.sources ? readJson(p.sources, null) : null;
  const byId = new Map();
  const add = (list) => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const s = validateSource(raw);
      if (s) {
        byId.delete(s.id); // user entries replace bundled ones with the same id
        byId.set(s.id, s);
      }
    }
  };
  if (isObj(bundled)) add(bundled.sources);
  if (isObj(user)) {
    add(user.sources);
    if (Array.isArray(user.disable)) {
      for (const id of user.disable) if (typeof id === 'string') byId.delete(id);
    }
  }
  return [...byId.values()].slice(0, MAX_SOURCES);
}

// Re-validate cached items: the cache file is user-writable, treat it as untrusted too.
function validateItem(it) {
  if (!isObj(it)) return null;
  if (typeof it.id !== 'string' || !ITEM_ID_RE.test(it.id)) return null;
  if (typeof it.sourceId !== 'string' || !ID_RE.test(it.sourceId)) return null;
  if (typeof it.topic !== 'string' || !TOPIC_RE.test(it.topic)) return null;
  const title = cleanText(it.title, { maxLen: 160, multiline: false });
  const url = cleanUrl(typeof it.url === 'string' ? it.url : '');
  if (!title || !url) return null;
  return {
    id: it.id,
    sourceId: it.sourceId,
    topic: it.topic,
    name: cleanText(it.name, { maxLen: 60, multiline: false }) || it.sourceId,
    title,
    url,
    published: Number.isFinite(it.published) ? it.published : null,
  };
}

function readCache(p) {
  const c = readJson(p.updates, null);
  if (!isObj(c)) return null;
  return c;
}

function loadUpdates(p) {
  const c = readCache(p);
  if (!c || !Array.isArray(c.items)) return [];
  const out = [];
  for (const it of c.items.slice(0, MAX_ITEMS)) {
    const v = validateItem(it);
    if (v) out.push(v);
  }
  return out;
}

function isStale(p, now = Date.now(), refreshHours = 24) {
  const c = readCache(p);
  if (!c || !Number.isFinite(c.fetchedAt)) return true;
  if (c.fetchedAt > now + 60_000) return true; // clock went backwards / tampered
  const hours = Number.isFinite(refreshHours) && refreshHours > 0 ? refreshHours : 24;
  return now - c.fetchedAt >= hours * 3_600_000;
}

async function fetchSource(source, fetchImpl) {
  const text = await fetchText(source.url, {
    allowHosts: source.type === 'github-releases' ? ['api.github.com', 'github.com'] : sourceAllowHosts(source),
    fetchImpl,
  });
  return source.type === 'github-releases' ? parseGithubReleases(text, source) : parseFeed(text, source);
}

async function pool(list, n, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      await fn(list[i], i);
    }
  });
  await Promise.all(workers);
}

async function refresh(p, { now = Date.now(), fetchImpl = globalThis.fetch, sources, log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const srcs = Array.isArray(sources) ? sources.map(validateSource).filter(Boolean) : loadSources(p);
  const prev = readCache(p);
  const prevItems = loadUpdates(p);
  const prevMeta = prev && isObj(prev.sources) ? prev.sources : {};

  const status = {};
  const collected = [];
  await pool(srcs, CONCURRENCY, async (src) => {
    let items = null;
    let error = null;
    try {
      items = (await fetchSource(src, fetchImpl))
        .filter((it) => !RC_TAG.test(it.title))
        .sort((a, b) => (b.published ?? -Infinity) - (a.published ?? -Infinity))
        .slice(0, PER_SOURCE);
      if (items.length === 0) error = 'no items';
    } catch (err) {
      error = cleanText(err && err.message ? err.message : 'fetch failed', { maxLen: 120, multiline: false }) || 'fetch failed';
    }
    if (error) {
      // Offline-safe: keep what we had for this source.
      const kept = prevItems.filter((it) => it.sourceId === src.id);
      collected.push(...kept);
      const old = isObj(prevMeta[src.id]) ? prevMeta[src.id] : {};
      status[src.id] = {
        fetchedAt: Number.isFinite(old.fetchedAt) ? old.fetchedAt : null,
        ok: false,
        error,
        count: kept.length,
      };
      say(`${src.id}: ${error} (kept ${kept.length})`);
    } else {
      collected.push(...items);
      status[src.id] = { fetchedAt: now, ok: true, error: null, count: items.length };
      say(`${src.id}: ${items.length} items`);
    }
  });

  const seen = new Set();
  const seenUrlTitle = new Set();
  const deduped = [];
  for (const it of collected) {
    const k2 = `${it.url}\n${it.title}`;
    if (seen.has(it.id) || seenUrlTitle.has(k2)) continue;
    seen.add(it.id);
    seenUrlTitle.add(k2);
    deduped.push(it);
  }
  deduped.sort((a, b) => (b.published ?? -Infinity) - (a.published ?? -Infinity));

  const cache = { version: CACHE_VERSION, fetchedAt: now, sources: status, items: deduped.slice(0, MAX_ITEMS) };
  writeJson(p.updates, cache);
  return cache;
}

// ---- background refresh lock ----

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function readLock(p) {
  let raw;
  try {
    raw = fs.readFileSync(p.refreshLock, 'utf8');
  } catch {
    return null;
  }
  try {
    const l = JSON.parse(raw);
    return isObj(l) ? l : {};
  } catch {
    return {};
  }
}

function lockIsLive(lock, now = Date.now()) {
  if (!lock || !Number.isInteger(lock.pid) || !Number.isFinite(lock.startedAt)) return false;
  if (now - lock.startedAt > LOCK_STALE_MS || lock.startedAt > now + LOCK_STALE_MS) return false;
  return pidAlive(lock.pid);
}

// Take the lock for `pid` (default: this process). An existing lock held by the same pid
// counts as ours (the spawner pre-writes the lock with the child's pid).
function acquireLock(p, pid = process.pid, now = Date.now()) {
  fs.mkdirSync(path.dirname(p.refreshLock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(p.refreshLock, JSON.stringify({ pid, startedAt: now }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
    }
    const lock = readLock(p);
    if (lock && lock.pid === pid) return true;
    if (lockIsLive(lock, now)) return false;
    try { fs.unlinkSync(p.refreshLock); } catch { /* raced */ }
  }
  return false;
}

function releaseLock(p, pid = process.pid) {
  const lock = readLock(p);
  if (lock && lock.pid !== undefined && lock.pid !== pid) return;
  try { fs.unlinkSync(p.refreshLock); } catch { /* ignore */ }
}

function spawnBackgroundRefresh(p) {
  try {
    if (lockIsLive(readLock(p))) return null;
    fs.mkdirSync(p.home, { recursive: true });
    const child = spawn(process.execPath, [REFRESH_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: p.home,
      env: { ...process.env, DEVSHARP_HOME: p.home },
    });
    child.on('error', () => { /* never surface */ });
    if (!child.pid) return null;
    try {
      writeJson(p.refreshLock, { pid: child.pid, startedAt: Date.now() });
    } catch { /* child will take the lock itself */ }
    child.unref();
    return child.pid;
  } catch {
    return null;
  }
}

// ownerPid: only stop the refresh if it is the one this caller started (another
// Claude session may have started the current one).
function stopBackgroundRefresh(p, ownerPid = null) {
  const lock = readLock(p);
  if (lock === null) return false;
  if (ownerPid !== null && lock.pid !== ownerPid) return false;
  let killed = false;
  // Only kill a fresh lock's pid: an old lock's pid may have been reused by another process.
  if (lockIsLive(lock) && lock.pid !== process.pid) {
    try {
      process.kill(lock.pid, 'SIGTERM');
      killed = true;
    } catch { /* already gone */ }
  }
  try { fs.unlinkSync(p.refreshLock); } catch { /* ignore */ }
  return killed;
}

module.exports = {
  loadSources,
  validateSource,
  loadUpdates,
  isStale,
  refresh,
  spawnBackgroundRefresh,
  stopBackgroundRefresh,
  acquireLock,
  releaseLock,
  BUNDLED_SOURCES,
  MAX_ITEMS,
};
