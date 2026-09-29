'use strict';
// The DevSharp engine: decides when to show a card, picks it, and implements
// every user command. It knows nothing about Claude Code; src/claude/hook.js
// and cli/devsharp.js are thin adapters around it.

const { paths: getPaths } = require('./paths');
const { loadConfig, saveConfigValue, resetConfig, cadence, parseDuration, DEFAULTS, DESCRIPTIONS, CATEGORIES } = require('./config');
const store = require('./store');
const { loadKnowledge } = require('./knowledge');
const { selectCard } = require('./select');
const { renderCard, renderAnswer, renderNotice, hasAnswer } = require('./render');
const { computeStats, formatStats, prettyCat } = require('./stats');
const updates = require('../updates');
const { detectCached } = require('./detect');
const ai = require('../ai');

function ctxFrom(opts = {}) {
  const p = opts.paths || getPaths(opts.env || process.env);
  const { config, warnings } = loadConfig(p);
  return { p, config, warnings, now: opts.now || Date.now(), cwd: opts.cwd || process.cwd(), sessionId: store.sessionKey(opts.sessionId) };
}

function project(ctx) {
  if (!ctx.config.project_awareness) return { techs: [], topics: [] };
  try {
    return detectCached(ctx.cwd, ctx.p, { now: ctx.now }) || { techs: [], topics: [] };
  } catch {
    return { techs: [], topics: [] };
  }
}

function catalogue(ctx, proj) {
  const want = proj.topics.concat(Array.isArray(ctx.config.topics) ? ctx.config.topics : []);
  let items = loadKnowledge(ctx.p, { wantTopics: want, seed: store.dayKey(ctx.now) });
  let ups = [];
  let notes = null;
  if (ctx.config.updates) {
    try { ups = updates.loadUpdates(ctx.p); } catch { ups = []; }
  }
  if (ctx.config.ai) {
    try {
      const names = new Map(items.map((i) => [i.topic, i.topicName]));
      items = items.concat(ai.loadAiCards(ctx.p, ctx.now).map((c) => ({ ...c, topicName: names.get(c.topic) || c.topicName })));
      notes = ai.loadNotes(ctx.p);
    } catch { /* AI cache problems never block static cards */ }
  }
  return { items, ups, notes };
}

function findItem(id, items, ups) {
  const it = items.find((i) => i.id === id);
  if (it) return it;
  const u = ups.find((x) => x.id === id);
  return u ? { id: u.id, type: 'update', topic: u.topic, topicName: u.name, title: u.title, url: u.url, published: u.published, source: { name: u.name, url: u.url } } : null;
}

const renderOpts = (config, extra = {}) => ({ style: config.card_style, width: config.card_width, reveal: config.reveal, ...extra });

function pickAndShow(ctx, state, sess, { mode = null } = {}) {
  const proj = project(ctx);
  const { items, ups, notes } = catalogue(ctx, proj);
  const seed = `${ctx.sessionId}|${store.dayKey(ctx.now)}|${state.events.length}`;
  const pick = selectCard({
    items, updates: ups, notes, state, config: ctx.config, projectTopics: proj.techs, now: ctx.now, seed, mode,
  });
  if (!pick) return null;
  // Leaving an unanswered question behind counts as "skipped".
  if (sess.pending && !sess.pending.revealed && sess.pending.hasAnswer) {
    const prev = findItem(sess.pending.id, items, ups);
    if (prev) store.record(state, 'skipped', prev, ctx.now);
  }
  store.record(state, 'shown', pick.item, ctx.now);
  sess.sinceCard = 0;
  sess.pending = { id: pick.item.id, turn: sess.turns, t: ctx.now, hasAnswer: hasAnswer(pick.item), revealed: false };
  return renderCard(pick.item, renderOpts(ctx.config, { revealHint: hasAnswer(pick.item) }));
}

// ---- lifecycle -----------------------------------------------------------

function onSessionStart(opts) {
  const ctx = ctxFrom(opts);
  if (!ctx.config.enabled) return;
  const state = store.loadState(ctx.p);
  store.pruneSessions(state, ctx.now);
  const sess = store.session(state, ctx.sessionId, ctx.now);
  sess.cwd = ctx.cwd;
  const { turns } = cadence(ctx.config);
  if (Number.isFinite(turns)) sess.sinceCard = Math.max(sess.sinceCard, turns - 1); // first card after the first turn
  store.saveState(ctx.p, state);
  project(ctx); // warm the detection cache so Stop stays fast
  if (ctx.config.updates) {
    try {
      if (updates.isStale(ctx.p, ctx.now, ctx.config.update_refresh_hours)) {
        const pid = updates.spawnBackgroundRefresh(ctx.p);
        if (pid) {
          const st = store.loadState(ctx.p);
          store.session(st, ctx.sessionId, ctx.now).refreshPid = pid;
          store.saveState(ctx.p, st);
        }
      }
    } catch { /* offline-first: never fail a session over updates */ }
  }
}

// Called when Claude finishes a turn. Returns card text or null.
function onTurnEnd(opts) {
  const ctx = ctxFrom(opts);
  const { config } = ctx;
  if (!config.enabled || !config.show_after_prompt || config.frequency === 'off') return null;
  const state = store.loadState(ctx.p);
  const sess = store.session(state, ctx.sessionId, ctx.now);
  sess.turns += 1;
  sess.sinceCard += 1;
  let out = null;

  const pend = sess.pending;
  if (ctx.now < state.snoozeUntil) {
    // snoozed: stay completely silent
  } else if (pend && pend.hasAnswer && !pend.revealed && config.reveal === 'next-turn' && sess.turns > pend.turn) {
    const proj = project(ctx);
    const { items, ups } = catalogue(ctx, proj);
    const item = findItem(pend.id, items, ups);
    pend.revealed = true;
    if (item) {
      store.record(state, 'revealed', item, ctx.now, { auto: true });
      out = renderAnswer(item, renderOpts(config, { auto: true }));
    }
  } else {
    const { turns, interval } = cadence(config);
    if (sess.sinceCard >= turns && ctx.now - state.lastShownAt >= interval) {
      out = pickAndShow(ctx, state, sess);
    }
  }
  store.saveState(ctx.p, state);
  if (config.ai) {
    // Opt-in: maybe start ONE budgeted background generation about what just changed.
    try { ai.maybeSchedule({ ...ctx, topics: project(ctx).topics }); } catch { /* never block the turn */ }
  }
  return out;
}

function onSessionEnd(opts) {
  const ctx = ctxFrom(opts);
  const state = store.loadState(ctx.p);
  const sess = Object.prototype.hasOwnProperty.call(state.sessions, ctx.sessionId) ? state.sessions[ctx.sessionId] : null;
  const refreshPid = sess && sess.refreshPid;
  if (sess) {
    if (sess.pending && sess.pending.hasAnswer && !sess.pending.revealed) {
      state.events.push({ t: ctx.now, e: 'skipped', id: sess.pending.id });
    }
    delete state.sessions[ctx.sessionId];
  }
  store.pruneSessions(state, ctx.now);
  store.saveState(ctx.p, state);
  // Stop the background refresh only if this session started it and it is still running.
  if (refreshPid) {
    try { updates.stopBackgroundRefresh(ctx.p, refreshPid); } catch { /* ignore */ }
  }
}

// ---- commands ------------------------------------------------------------

const COMMANDS = {
  reveal: 'Show the answer to the current Think First / Why card',
  next: 'Show a learning card right now  [fact|think|concept|why|update]',
  known: 'Mark the current card as known (it will not come back)',
  dismiss: 'Never show the current card again',
  stats: 'Your learning statistics',
  status: 'Whether DevSharp is active, what it detected, when the next card is due',
  config: 'Show settings · config set <key> <value> · config reset',
  topics: 'Technologies detected in this project',
  snooze: 'Pause cards for a while  [30m|2h|1d]  (default 1h)',
  enable: 'Turn DevSharp on',
  disable: 'Turn DevSharp off',
  update: 'Refresh technology-update feeds now',
  ai: 'Opt-in AI cards from your recent code changes  [on|off|now]',
  reset: 'Erase learning history (config is kept)  — requires "confirm"',
  help: 'This list',
};

function currentCard(ctx, state, sess) {
  const id = (sess && sess.pending && sess.pending.id) || (store.lastShown(state) || {}).id;
  if (!id) return null;
  const { items, ups } = catalogue(ctx, project(ctx));
  return findItem(id, items, ups);
}

function fmtAgo(ms, now) {
  if (!ms) return 'never';
  const m = Math.round((now - ms) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return 'never';
  const m = Math.round(ms / 60e3);
  return m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : `${+(m / 60).toFixed(1)} hours`;
}

// Returns { text, async?: Promise<string> }. Never throws for user errors.
function runCommand(name, args = [], opts = {}) {
  const ctx = ctxFrom(opts);
  const { p, config, now } = ctx;
  const ro = renderOpts(config);
  const note = (title, lines) => ({ text: renderNotice(title, lines, ro) });
  const state = store.loadState(p);
  const sess = Object.prototype.hasOwnProperty.call(state.sessions, ctx.sessionId) ? state.sessions[ctx.sessionId] : null;

  switch (name) {
    case 'reveal': {
      const item = currentCard(ctx, state, sess);
      if (!item) return note('Nothing to reveal', ['No card has been shown yet. Try /devsharp:next']);
      if (!hasAnswer(item)) return note('Nothing to reveal', [`"${item.title}" has no hidden answer.`, 'Try /devsharp:next for another card.']);
      store.record(state, 'revealed', item, now);
      if (sess && sess.pending && sess.pending.id === item.id) sess.pending.revealed = true;
      store.saveState(p, state);
      return { text: renderAnswer(item, { ...ro, auto: true }) };
    }
    case 'next': {
      const mode = ['fact', 'think', 'concept', 'why', 'update'].includes(args[0]) ? args[0] : null;
      const s = store.session(state, ctx.sessionId, now);
      const text = pickAndShow(ctx, state, s, { mode });
      store.saveState(p, state);
      return text ? { text } : note('No cards available', ['Everything eligible has been dismissed or marked known.', 'Widen `topics` or add a pack in ~/.config/devsharp/packs/.']);
    }
    case 'known':
    case 'dismiss': {
      const item = currentCard(ctx, state, sess);
      if (!item) return note('No card', ['No card has been shown yet.']);
      store.record(state, name === 'known' ? 'known' : 'dismissed', item, now);
      if (sess && sess.pending && sess.pending.id === item.id) sess.pending.revealed = true;
      store.saveState(p, state);
      return note(name === 'known' ? 'Marked as known' : 'Dismissed', [
        `"${item.title}" won't be shown again.`,
        name === 'known' ? 'Nice. Difficulty for this topic adapts as you mark cards known.' : 'Use /devsharp:config set topics ... to steer what you see.',
      ]);
    }
    case 'stats': {
      const { items } = catalogue(ctx, { topics: [] });
      return note('Stats', formatStats(computeStats(state, items, now)));
    }
    case 'topics': {
      const proj = project(ctx);
      if (!config.project_awareness) return note('Project awareness is off', ['Enable with: config set project_awareness true']);
      if (!proj.techs.length) return note('No technologies detected', [`Looked in ${ctx.cwd}`, 'DevSharp will show general cards.']);
      return note('Detected in this project', proj.techs.slice(0, 15).map((t) => `${t.topic.padEnd(18)} ${Math.round(t.weight * 100)}%  ${(t.evidence || []).slice(0, 2).join(', ')}`));
    }
    case 'status': {
      const { turns, interval } = cadence(config);
      const proj = project(ctx);
      let upd = 'off';
      if (config.updates) {
        try {
          const n = updates.loadUpdates(p).length;
          const cache = require('./fsutil').readJson(p.updates, {});
          upd = `${n} headlines cached, refreshed ${fmtAgo(cache.fetchedAt, now)}`;
        } catch { upd = 'no cache yet'; }
      }
      const due = Math.max(0, state.lastShownAt + interval - now);
      const lines = [
        `Active:            ${config.enabled ? 'yes' : 'no (/devsharp:enable)'}`,
        `Frequency:         ${config.frequency} (every ${Number.isFinite(turns) ? turns : '∞'} turns, at most every ${fmtDuration(interval)})`,
        `Snoozed:           ${state.snoozeUntil > now ? `until ${new Date(state.snoozeUntil).toLocaleTimeString()}` : 'no'}`,
        `Last card:         ${fmtAgo(state.lastShownAt, now)}${due ? ` · next eligible in ${fmtDuration(due)}` : ''}`,
        `Project topics:    ${proj.topics.slice(0, 8).join(', ') || 'none detected'}`,
        `Tech updates:      ${upd}`,
        `Data directory:    ${p.home}`,
        'Claude tokens:     0 (cards never touch the model)',
      ];
      for (const w of ctx.warnings) lines.push(`⚠ config: ${w}`);
      return note('Status', lines);
    }
    case 'config': {
      if (args[0] === 'set') {
        const [, key, ...rest] = args;
        try {
          const v = saveConfigValue(p, key, rest.join(' '));
          return note('Config updated', [`${key} = ${JSON.stringify(v)}`]);
        } catch (e) {
          return note('Config error', [e.message]);
        }
      }
      if (args[0] === 'reset') { resetConfig(p); return note('Config reset', ['All settings are back to defaults.']); }
      const yn = (b) => (b ? 'Yes' : 'No');
      const { interval } = cadence(config);
      const topics = config.topics === 'auto' ? CATEGORIES.map((c) => `  ✓ ${prettyCat(c)}`) : config.topics.map((t) => `  ✓ ${t}`);
      return note('Configuration', [
        `Enabled:              ${yn(config.enabled)}`,
        `Frequency:            ${config.frequency}`,
        `Mode:                 ${config.mode}`,
        `Think First:          ${yn(config.think_first)}`,
        `Reveal answers:       ${config.reveal}`,
        `Technology Updates:   ${yn(config.updates)}`,
        `Difficulty:           ${config.difficulty}`,
        `Project Awareness:    ${yn(config.project_awareness)}`,
        `Minimum Interval:     ${fmtDuration(interval)}${config.minimum_interval === 'auto' ? ' (auto)' : ''}`,
        `Card style:           ${config.card_style}, ${config.card_width} cols`,
        'Telemetry:            None',
        '',
        `Topics${config.topics === 'auto' ? ' (auto: project first, then everything)' : ''}:`,
        ...topics,
        '',
        `File: ${p.config}`,
        'Change: /devsharp:config set <key> <value>',
      ]);
    }
    case 'snooze': {
      const ms = parseDuration(args[0] || '1h');
      if (ms === null) return note('Snooze', ['Usage: snooze 30m | 2h | 1d   (snooze 0 to resume)']);
      state.snoozeUntil = ms > 0 ? now + ms : 0;
      store.saveState(p, state);
      if (!ms) return note('Resumed', ['Snooze cleared. Cards are back on.']);
      return note('Snoozed', [`No cards for ${fmtDuration(ms)}. /devsharp:snooze 0 to resume.`]);
    }
    case 'enable':
    case 'disable':
      saveConfigValue(p, 'enabled', name === 'enable');
      if (name === 'enable') { state.snoozeUntil = 0; store.saveState(p, state); }
      return note(name === 'enable' ? 'Enabled' : 'Disabled', [name === 'enable' ? 'Cards will appear after Claude finishes a turn.' : 'No cards, no background refresh. /devsharp:enable to turn back on.']);
    case 'update': {
      if (!config.updates) return note('Updates are off', ['Enable with: config set updates true']);
      if (opts.foreground) {
        return {
          text: renderNotice('Updating', ['Fetching public technology feeds…'], ro),
          async: updates.refresh(p, { now }).then(() => {
            const n = updates.loadUpdates(p).length;
            return renderNotice('Updates refreshed', [`${n} headlines cached.`], ro);
          }),
        };
      }
      const pid = updates.spawnBackgroundRefresh(p);
      return note('Updating', [pid ? 'Refreshing feeds in the background (a few seconds). New headlines appear in upcoming cards.' : 'A refresh is already running.']);
    }
    case 'ai': {
      const sub = args[0];
      if (sub === 'on' || sub === 'off') {
        saveConfigValue(p, 'ai', sub === 'on');
        return note(sub === 'on' ? 'AI cards on' : 'AI cards off', sub === 'on' ? [
          `After a turn DevSharp may ask ${config.ai_model} (through your claude CLI login) for cards about`,
          'your latest git changes, in a separate background call that never touches this conversation.',
          `Budget: at most ${config.ai_daily_limit} calls/day, one per ${config.ai_min_interval}. Typically ~3k input + ~0.5k output tokens per call (~$0.005 at Haiku list price).`,
          'Secrets, .env, keys and lockfiles are never sent; secret-looking values are redacted.',
        ] : ['DevSharp is back to zero model usage.']);
      }
      if (sub === 'now') {
        if (!config.ai) return note('AI cards are off', ['Turn on with: /devsharp:ai on']);
        const r = ai.maybeSchedule({ ...ctx, topics: project(ctx).topics }, { force: true });
        return note('AI cards', [r.started ? 'Generating in the background; the card shows up after a coming turn (or /devsharp:next).' : `Not started: ${r.why}.`]);
      }
      const b = ai.budgetState(p, config, now);
      return note('AI cards', [
        `Enabled:           ${config.ai ? 'yes' : 'no (/devsharp:ai on)'}`,
        `Model:             ${config.ai_model} via your claude CLI login`,
        `Used today:        ${b.used} of ${b.limit} calls`,
        `Last run:          ${fmtAgo(b.lastRunAt, now)}${b.lastCost ? ` (~$${b.lastCost.toFixed(4)} at list price)` : ''}`,
        `Cards waiting:     ${b.pending}`,
        ...(b.lastError ? [`Last error:        ${b.lastError}`] : []),
        '',
        'Card display stays zero-token; only generation uses the model, in a separate call.',
      ]);
    }
    case 'reset': {
      if (args[0] !== 'confirm' && args[0] !== '--yes') {
        return note('Reset', ['This erases your learning history (cards seen, known, dismissed, streak).', 'Settings are kept. Run again with "confirm" to proceed.']);
      }
      store.saveState(p, store.emptyState());
      try { require('fs').rmSync(p.projects, { force: true }); } catch { /* ignore */ }
      return note('Reset', ['Learning history erased.']);
    }
    case 'help':
    default: {
      const lines = Object.entries(COMMANDS).map(([k, v]) => `/devsharp:${k.padEnd(8)} ${v}`);
      if (name !== 'help') lines.unshift(`Unknown command "${String(name).slice(0, 30)}".`, '');
      return note('Commands', lines);
    }
  }
}

module.exports = { onSessionStart, onTurnEnd, onSessionEnd, runCommand, COMMANDS, DEFAULTS, DESCRIPTIONS };
