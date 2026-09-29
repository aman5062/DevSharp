'use strict';
// Configuration: ~/.config/devsharp/config.json. Every key is validated; a bad
// value falls back to its default and is reported (never crashes a hook).

const { readJson, writeJson } = require('./fsutil');

const CATEGORIES = [
  'languages', 'frontend', 'backend', 'databases', 'devops', 'cloud', 'security',
  'networking', 'distributed-systems', 'system-design', 'ai-ml', 'computer-science',
];

const FREQUENCIES = {
  // turns: completed Claude turns between cards; interval: minimum time between cards.
  off: { turns: Infinity, interval: Infinity },
  low: { turns: 5, interval: 30 * 60e3 },
  medium: { turns: 3, interval: 10 * 60e3 },
  high: { turns: 1, interval: 3 * 60e3 },
};

const MODES = ['mixed', 'fact', 'think', 'concept', 'why', 'update'];

const DEFAULTS = Object.freeze({
  enabled: true,
  frequency: 'medium',
  mode: 'mixed',
  show_after_prompt: true,
  minimum_interval: 'auto',
  topics: 'auto',
  difficulty: 'adaptive',
  updates: true,
  update_refresh_hours: 24,
  think_first: true,
  reveal: 'next-turn',
  project_awareness: true,
  card_style: 'rail',
  card_width: 64,
  telemetry: false,
  ai: false,
  ai_model: 'haiku',
  ai_daily_limit: 25,
  ai_min_interval: '10m',
});

const DESCRIPTIONS = {
  enabled: 'Master switch (true/false)',
  frequency: 'off | low | medium | high',
  mode: MODES.join(' | '),
  show_after_prompt: 'Show cards after Claude finishes a turn (true/false)',
  minimum_interval: 'auto | duration like 10m, 1h (minimum time between cards)',
  topics: `auto | comma list of categories/topics (${CATEGORIES.slice(0, 4).join(', ')}, ...)`,
  difficulty: 'adaptive | easy | medium | hard',
  updates: 'Fetch public technology-update feeds in the background (true/false)',
  update_refresh_hours: 'Hours between update-feed refreshes (1-168)',
  think_first: 'Include Think First questions (true/false)',
  reveal: 'next-turn (answer appears after your next turn) | manual (only /devsharp:reveal)',
  project_awareness: 'Prioritise technologies detected in the current project (true/false)',
  card_style: 'rail | box | plain',
  card_width: 'Card width in columns (40-100)',
  telemetry: 'Always false. DevSharp has no telemetry.',
  ai: 'Opt-in AI cards about your recent code changes + headline notes (uses a small model via your claude CLI login)',
  ai_model: 'Model alias for AI cards (haiku, sonnet, ...)',
  ai_daily_limit: 'Maximum AI generations per day (1-100)',
  ai_min_interval: 'Minimum time between AI generations, e.g. 10m',
};

function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v * 60e3; // minutes
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  const mult = unit.startsWith('s') ? 1e3 : unit.startsWith('h') ? 3600e3 : unit === 'd' ? 86400e3 : 60e3;
  return n * mult;
}

const bool = (v) => (v === true || v === 'true' || v === 'yes' || v === 'on' || v === '1' ? true
  : v === false || v === 'false' || v === 'no' || v === 'off' || v === '0' ? false : undefined);

// Returns the normalised value, or undefined if invalid.
function coerce(key, v) {
  switch (key) {
    case 'enabled': case 'ai': case 'show_after_prompt': case 'updates': case 'think_first': case 'project_awareness':
      return bool(v);
    case 'telemetry':
      return bool(v) === false ? false : undefined; // cannot be enabled: nothing to send
    case 'frequency':
      return typeof v === 'string' && FREQUENCIES[v.toLowerCase()] ? v.toLowerCase() : undefined;
    case 'mode':
      return typeof v === 'string' && MODES.includes(v.toLowerCase()) ? v.toLowerCase() : undefined;
    case 'difficulty':
      return ['adaptive', 'easy', 'medium', 'hard'].includes(v) ? v : undefined;
    case 'reveal':
      return ['next-turn', 'manual'].includes(v) ? v : undefined;
    case 'card_style':
      return ['rail', 'box', 'plain'].includes(v) ? v : undefined;
    case 'ai_model':
      return typeof v === 'string' && /^[a-z0-9][a-z0-9.-]{1,59}$/i.test(v.trim()) ? v.trim() : undefined;
    case 'ai_daily_limit': {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 100 ? n : undefined;
    }
    case 'ai_min_interval': {
      const ms = parseDuration(v);
      return ms !== null && ms >= 60e3 ? String(v).trim() : undefined;
    }
    case 'minimum_interval':
      if (v === 'auto') return 'auto';
      return parseDuration(v) !== null ? (typeof v === 'number' ? `${v}m` : String(v).trim()) : undefined;
    case 'card_width': {
      const n = Number(v);
      return Number.isInteger(n) && n >= 40 && n <= 100 ? n : undefined;
    }
    case 'update_refresh_hours': {
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 && n <= 168 ? n : undefined;
    }
    case 'topics': {
      if (v === 'auto') return 'auto';
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
      if (!list) return undefined;
      const clean = list.map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-z0-9-]{1,40}$/.test(s));
      return clean.length ? [...new Set(clean)] : undefined;
    }
    default:
      return undefined;
  }
}

function loadConfig(p) {
  const raw = readJson(p.config, {});
  const config = { ...DEFAULTS };
  const warnings = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('$') || k.startsWith('//')) continue; // allow "$schema" / comments
      if (!(k in DEFAULTS)) { warnings.push(`unknown key "${k}" ignored`); continue; }
      const c = coerce(k, v);
      if (c === undefined) warnings.push(`invalid value for "${k}", using default ${JSON.stringify(DEFAULTS[k])}`);
      else config[k] = c;
    }
  } else if (raw !== undefined) {
    warnings.push('config.json is not an object; using defaults');
  }
  return { config, warnings };
}

function saveConfigValue(p, key, value) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting "${key}". Known: ${Object.keys(DEFAULTS).join(', ')}`);
  const c = coerce(key, value);
  if (c === undefined) throw new Error(`Invalid value for ${key}. Expected: ${DESCRIPTIONS[key]}`);
  const raw = readJson(p.config, {});
  const next = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  next[key] = c;
  writeJson(p.config, next);
  return c;
}

function resetConfig(p) {
  writeJson(p.config, {});
}

// Effective cadence from frequency + minimum_interval.
function cadence(config) {
  const f = FREQUENCIES[config.frequency] || FREQUENCIES.medium;
  const interval = config.minimum_interval === 'auto' ? f.interval : parseDuration(config.minimum_interval);
  return { turns: f.turns, interval: interval ?? f.interval };
}

module.exports = {
  DEFAULTS, DESCRIPTIONS, CATEGORIES, FREQUENCIES, MODES,
  loadConfig, saveConfigValue, resetConfig, cadence, parseDuration, coerce,
};
