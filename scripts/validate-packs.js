#!/usr/bin/env node
'use strict';
// Validates every bundled pack against docs/CONTRACT.md. Exit 1 with a list of errors.
//   node scripts/validate-packs.js [dir]   (default: knowledge/)

const fs = require('fs');
const path = require('path');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'knowledge'));
const CATEGORIES = {
  languages: ['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'bash'],
  frontend: ['react', 'nextjs', 'css', 'browser'],
  backend: ['nodejs', 'http', 'auth', 'api-design'],
  databases: ['sql', 'postgresql', 'mysql', 'redis', 'mongodb', 'sqlite', 'prisma'],
  devops: ['docker', 'kubernetes', 'git', 'linux', 'ci-cd'],
  cloud: ['aws'],
  security: ['web-security', 'tls', 'cryptography'],
  networking: ['tcp', 'dns'],
  'distributed-systems': ['distributed-systems'],
  'system-design': ['system-design', 'caching'],
  'ai-ml': ['ai-ml', 'llm'],
  'computer-science': ['algorithms', 'data-structures', 'memory', 'concurrency'],
};
const TYPES = ['fact', 'think', 'concept', 'why'];
const DIFFS = ['easy', 'medium', 'hard'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,80}$/;
const LIMITS = { title: 60, body: 400, question: 300, answer: 600 };
// Anything that would render as markup or control a terminal.
const BAD_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069]|`|<\/?[a-z]+>/;

const errors = [];
const ids = new Set();
let total = 0;
const err = (file, msg) => errors.push(`${file}: ${msg}`);

for (const [cat, topics] of Object.entries(CATEGORIES)) {
  for (const topic of topics) {
    const rel = `${cat}/${topic}.json`;
    const file = path.join(DIR, rel);
    if (!fs.existsSync(file)) { err(rel, 'missing pack'); continue; }
    let pack;
    try { pack = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { err(rel, `invalid JSON: ${e.message}`); continue; }
    if (pack.schema !== 1) err(rel, 'schema must be 1');
    if (pack.topic !== topic) err(rel, `topic must be "${topic}"`);
    if (pack.category !== cat) err(rel, `category must be "${cat}"`);
    if (typeof pack.name !== 'string' || !pack.name) err(rel, 'name required');
    if (!Array.isArray(pack.items) || pack.items.length < 5) { err(rel, 'needs at least 5 items'); continue; }
    const counts = {};
    for (const it of pack.items) {
      total += 1;
      const where = `${rel} ${it.id || '(no id)'}`;
      if (typeof it.id !== 'string' || !ID_RE.test(it.id)) err(where, 'bad id');
      else if (!it.id.startsWith(`${topic}-`)) err(where, `id must start with "${topic}-"`);
      if (ids.has(it.id)) err(where, 'duplicate id');
      ids.add(it.id);
      if (!TYPES.includes(it.type)) err(where, `bad type ${it.type}`);
      counts[it.type] = (counts[it.type] || 0) + 1;
      if (!DIFFS.includes(it.difficulty)) err(where, `bad difficulty ${it.difficulty}`);
      if (it.topic !== undefined && it.topic !== topic) err(where, 'item topic differs from pack');
      for (const [k, max] of Object.entries(LIMITS)) {
        if (it[k] === undefined) continue;
        if (typeof it[k] !== 'string' || !it[k].trim()) err(where, `${k} must be a non-empty string`);
        else if (it[k].length > max) err(where, `${k} is ${it[k].length} chars (max ${max})`);
        else if (BAD_TEXT.test(it[k])) err(where, `${k} contains markup or control characters`);
      }
      if (!it.title) err(where, 'title required');
      if ((it.type === 'fact' || it.type === 'concept') && !it.body) err(where, `${it.type} needs body`);
      if ((it.type === 'think' || it.type === 'why') && (!it.question || !it.answer)) err(where, `${it.type} needs question and answer`);
      if ((it.question && !it.answer) || (!it.question && it.answer)) err(where, 'question and answer go together');
      if (!Array.isArray(it.tags) || it.tags.some((t) => typeof t !== 'string' || !/^[a-z0-9-]{1,40}$/.test(t))) err(where, 'tags must be lowercase strings');
      if (!it.source || typeof it.source.name !== 'string' || !it.source.name) err(where, 'source.name required');
      else {
        try {
          const u = new URL(it.source.url);
          if (u.protocol !== 'https:') err(where, 'source.url must be https');
        } catch { err(where, 'source.url invalid'); }
      }
    }
    if ((counts.think || 0) < 2) err(rel, 'needs at least 2 think items');
    for (const t of ['fact', 'concept', 'why']) if (!counts[t]) err(rel, `needs at least 1 ${t} item`);
  }
}

// Stray files not in the canonical table.
for (const cat of fs.existsSync(DIR) ? fs.readdirSync(DIR, { withFileTypes: true }) : []) {
  if (!cat.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(DIR, cat.name))) {
    const topic = f.replace(/\.json$/, '');
    if (!(CATEGORIES[cat.name] || []).includes(topic)) err(`${cat.name}/${f}`, 'not a canonical topic (see docs/CONTRACT.md)');
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} error(s) in ${total} items`);
  process.exit(1);
}
console.log(`OK: ${total} items in ${Object.values(CATEGORIES).flat().length} packs`);
