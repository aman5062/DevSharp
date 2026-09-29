'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpHome(prefix = 'devsharp-test-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = { ...process.env, DEVSHARP_HOME: home };
  return { home, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function item(id, extra = {}) {
  return {
    id, type: 'fact', topic: 'redis', category: 'databases', topicName: 'Redis', difficulty: 'easy',
    title: `Title ${id}`, body: `Body ${id}`, question: '', answer: '', tags: [], source: null, custom: false, ...extra,
  };
}

const baseConfig = () => ({ ...require('../src/core/config').DEFAULTS });

module.exports = { tmpHome, item, baseConfig };
