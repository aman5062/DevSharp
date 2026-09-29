#!/usr/bin/env node
'use strict';
// Claude Code hook adapter.   node hook.js <session-start|prompt|stop|session-end>
//
// ZERO-TOKEN RULES (verified against Claude Code docs and by test/zero-token.test.js):
//   * SessionStart / UserPromptSubmit: plain stdout and `additionalContext` are ADDED TO
//     CLAUDE'S CONTEXT. So these handlers print nothing — except the documented
//     `{"decision":"block","reason":...}` for /devsharp:* commands, which stops the
//     prompt before any model request and shows `reason` to the user only.
//   * Stop: `systemMessage` is shown to the user and is not sent to Claude. We never
//     return `decision`, `reason` or `additionalContext` there (those would make
//     Claude continue and spend tokens).
//   * Never `async: true` hooks: an async hook's systemMessage IS delivered to Claude.
//   * Any failure exits 0 silently (details to stderr = debug log only).

// Loaded lazily: an ordinary prompt only needs the regex check below, so it pays for
// Node start-up and nothing else before Claude starts working.
let engineModule = null;
const engine = () => engineModule || (engineModule = require('../core/engine'));

const MAX_INPUT = 1024 * 1024;
const COMMAND_RE = /^\s*\/devsharp:([a-z-]{1,20})(?:\s+([\s\S]*))?$/;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
      if (data.length > MAX_INPUT) { data = data.slice(0, MAX_INPUT); process.stdin.destroy(); resolve(data); }
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function parse(raw) {
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

// Pure function: hook event + input -> stdout string ('' for none). Exported for tests.
function handle(event, input, env = process.env, now = Date.now()) {
  // Set by DevSharp's own background model call, so its child process never re-enters DevSharp.
  if (env.DEVSHARP_DISABLE === '1') return '';
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : env.CLAUDE_PROJECT_DIR || process.cwd();
  const opts = { env, now, cwd, sessionId: typeof input.session_id === 'string' ? input.session_id : 'unknown' };
  switch (event) {
    case 'session-start':
      engine().onSessionStart(opts);
      return '';
    case 'prompt': {
      const m = COMMAND_RE.exec(typeof input.prompt === 'string' ? input.prompt : '');
      if (!m) return '';
      const args = (m[2] || '').trim().split(/\s+/).filter(Boolean).slice(0, 10);
      const { text } = engine().runCommand(m[1], args, opts);
      return JSON.stringify({ decision: 'block', reason: `\n${text}`, suppressOriginalPrompt: true });
    }
    case 'stop': {
      if (input.stop_hook_active) return '';
      const text = engine().onTurnEnd(opts);
      // Leading newline: Claude Code prefixes the message with "Stop says:"; keep the card's header on its own line.
      return text ? JSON.stringify({ systemMessage: `\n${text}` }) : '';
    }
    case 'session-end':
      engine().onSessionEnd(opts);
      return '';
    default:
      return '';
  }
}

async function main() {
  const event = process.argv[2];
  try {
    const input = parse(await readStdin());
    const out = handle(event, input);
    if (out) process.stdout.write(out);
  } catch (err) {
    process.stderr.write(`devsharp: ${event}: ${err && err.stack ? err.stack : err}\n`);
  }
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = { handle, COMMAND_RE };
