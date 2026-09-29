#!/usr/bin/env node
'use strict';
// Detached background refresher. Silent: never writes to stdout/stderr.
// Hard-capped at 25 s so a hung network can never leave a process behind.

const { paths } = require('../core/paths');
const { refresh, acquireLock, releaseLock } = require('./index');

const p = paths(process.env);

setTimeout(() => {
  try { releaseLock(p); } catch { /* ignore */ }
  process.exit(0);
}, 25_000).unref();

process.on('uncaughtException', () => {
  try { releaseLock(p); } catch { /* ignore */ }
  process.exit(0);
});
process.on('unhandledRejection', () => { /* swallowed; refresh() handles per-source errors */ });
process.on('SIGTERM', () => {
  try { releaseLock(p); } catch { /* ignore */ }
  process.exit(0);
});

async function main() {
  let locked = false;
  try {
    locked = acquireLock(p);
    if (!locked) return;
    await refresh(p, {});
  } catch {
    /* silent */
  } finally {
    if (locked) {
      try { releaseLock(p); } catch { /* ignore */ }
    }
  }
}

main().then(() => process.exit(0), () => process.exit(0));
