#!/usr/bin/env node
'use strict';
// Writes knowledge/index.json: one entry per pack so the runtime can load only the
// packs it needs once the catalogue grows past knowledge.LOAD_ALL_LIMIT items.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'knowledge');
const packs = [];
let total = 0;
for (const cat of fs.readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  for (const f of fs.readdirSync(path.join(DIR, cat)).filter((x) => x.endsWith('.json')).sort()) {
    const pack = JSON.parse(fs.readFileSync(path.join(DIR, cat, f), 'utf8'));
    const types = {};
    for (const it of pack.items) types[it.type] = (types[it.type] || 0) + 1;
    packs.push({ file: `${cat}/${f}`, category: pack.category, topic: pack.topic, name: pack.name, count: pack.items.length, types });
    total += pack.items.length;
  }
}
const index = { schema: 1, generatedAt: new Date().toISOString(), total, packs };
fs.writeFileSync(path.join(DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`index: ${packs.length} packs, ${total} items`);
