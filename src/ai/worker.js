#!/usr/bin/env node
'use strict';
// Detached background job for AI cards. Silent, single-instance (lock), budgeted,
// hard-exits after 2 minutes. Usage (internal): node worker.js '<job json>'

const { paths } = require('../core/paths');
const { loadConfig } = require('../core/config');
const { dayKey, loadState } = require('../core/store');
const updates = require('../updates');
const ai = require('./index');
const { collectChanges } = require('./diff');

setTimeout(() => process.exit(0), 120e3).unref();

async function run(job, { now = Date.now(), call = ai.callModel } = {}) {
  const p = paths();
  const { config } = loadConfig(p);
  if (!config.ai) return { skipped: 'ai is off' };
  if (!ai.acquireLock(p, now)) return { skipped: 'locked' };
  try {
    const cache = ai.loadCache(p);
    if (cache.day !== dayKey(now)) { cache.day = dayKey(now); cache.count = 0; }
    if (cache.count >= config.ai_daily_limit) return { skipped: 'daily limit reached' };

    const topics = Array.isArray(job.topics) ? job.topics.filter((t) => /^[a-z0-9-]{1,40}$/.test(t)).slice(0, 12) : [];
    let changes = typeof job.cwd === 'string' ? collectChanges(job.cwd, { now }) : null;
    if (changes && changes.hash === cache.lastDiffHash && !job.force) changes = null; // already taught this diff

    // Headlines for the project's technologies that have no note yet and were not shown.
    const state = loadState(p);
    let headlines = [];
    if (config.updates) {
      const want = new Set(topics);
      headlines = updates.loadUpdates(p)
        .filter((u) => u.summary && (want.size ? want.has(u.topic) : true) && !cache.notes[u.id] && !(state.items[u.id] && state.items[u.id].shown));
      const perSource = new Set();
      headlines = headlines.filter((u) => !perSource.has(u.sourceId) && perSource.add(u.sourceId)).slice(0, 3); // one per project
    }
    if (!changes && !headlines.length) return { skipped: 'nothing new' };

    // Count the call before making it, so a crash or error can never cause a retry loop.
    cache.count += 1;
    cache.lastRunAt = now;
    if (changes) cache.lastDiffHash = changes.hash;
    ai.saveCache(p, cache);

    const prompt = ai.buildPrompt({ changes, headlines, topics });
    let result;
    try {
      result = await call(prompt, { model: config.ai_model });
    } catch (e) {
      cache.lastError = String(e && e.message ? e.message : e).slice(0, 160);
      ai.saveCache(p, cache);
      return { error: cache.lastError };
    }
    const parsed = ai.parseOutput(result.text, {
      topics, headlineIds: new Set(headlines.map((h) => h.id)), origin: changes ? changes.origin : 'recent headlines', model: config.ai_model, now,
    });
    const known = new Set(cache.cards.map((c) => c.id));
    for (const c of parsed.cards) if (!known.has(c.id)) cache.cards.push(c);
    Object.assign(cache.notes, parsed.notes);
    cache.lastError = null;
    cache.lastCost = result.cost;
    ai.saveCache(p, cache);
    return { cards: parsed.cards.length, notes: Object.keys(parsed.notes).length, cost: result.cost };
  } finally {
    ai.releaseLock(p);
  }
}

if (require.main === module) {
  let job = {};
  try { job = JSON.parse(process.argv[2] || '{}'); } catch { job = {}; }
  run(job).catch(() => {}).finally(() => process.exit(0));
}

module.exports = { run };
