'use strict';
// Collects the developer's latest edits for AI cards: `git diff HEAD` (or the last
// commit if the tree is clean and the commit is recent), filtered and redacted,
// capped at a few KB. Only runs when the user has enabled `ai`.
//
// Never included: .env*, keys/certs, lockfiles, minified/generated/vendored files,
// binaries, and paths that look secret. Secret-looking values are redacted.

const { execFileSync } = require('child_process');
const crypto = require('crypto');

const MAX_BYTES_DEFAULT = 5 * 1024;
const RECENT_COMMIT_MS = 6 * 3600e3;

const SKIP_PATH = [
  /(^|\/)\.env(\.|$)/i, /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx|gpg|asc)$/i, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)/i,
  /(secret|credential|password|passwd|token)s?[^/]*$/i, /(^|\/)\.npmrc$/i, /(^|\/)\.netrc$/i, /(^|\/)\.pypirc$/i,
  /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock|bun\.lockb?)$/i,
  /\.(min\.js|min\.css|map|snap|svg|png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|wasm)$/i,
  /(^|\/)(node_modules|dist|build|out|vendor|target|\.next|coverage|__generated__|generated)\//i,
];

const REDACT = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<redacted private key>'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '<redacted>'],
  [/\b(sk|rk|pk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}\b/g, '<redacted>'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '<redacted>'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '<redacted>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<redacted jwt>'],
  [/([a-z][a-z0-9+.-]*:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1<redacted>@'],
  [/((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|client[_-]?secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^"'`\s,;)]{4,})/gi, '$1<redacted>'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '<redacted>'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g, '<redacted>'],
];

function redact(text) {
  let s = text;
  for (const [re, rep] of REDACT) s = s.replace(re, rep);
  return s;
}

function git(cwd, args, maxBuffer = 4 * 1024 * 1024) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 4000, maxBuffer, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

// Split a unified diff into per-file chunks.
function splitFiles(diff) {
  const out = [];
  for (const part of diff.split(/^(?=diff --git )/m)) {
    if (!part.startsWith('diff --git ')) continue;
    const m = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(part);
    out.push({ path: m ? m[2] : '?', text: part });
  }
  return out;
}

function filterDiff(diff, maxBytes = MAX_BYTES_DEFAULT) {
  const kept = [];
  const skipped = [];
  let size = 0;
  for (const f of splitFiles(diff)) {
    if (SKIP_PATH.some((re) => re.test(f.path)) || /^Binary files /m.test(f.text) || /^GIT binary patch/m.test(f.text)) {
      skipped.push(f.path);
      continue;
    }
    // Drop the noisy header lines; keep the file name and hunks.
    let text = f.text.replace(/^(index |similarity |rename |new file mode|deleted file mode|old mode|new mode).*\n/gm, '');
    text = redact(text);
    const lines = text.split('\n').map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
    text = lines.join('\n');
    if (size + text.length > maxBytes) {
      const room = maxBytes - size;
      if (room > 400) { kept.push({ path: f.path, text: `${text.slice(0, room)}\n… (truncated)` }); size = maxBytes; }
      else skipped.push(f.path);
      continue;
    }
    kept.push({ path: f.path, text });
    size += text.length;
  }
  return { files: kept.map((k) => k.path), skipped, text: kept.map((k) => k.text).join('\n') };
}

// Returns null when there is nothing (recent) to learn from or git is unavailable.
function collectChanges(cwd, { now = Date.now(), maxBytes = MAX_BYTES_DEFAULT } = {}) {
  try {
    git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return null;
  }
  let diff = '';
  let origin = 'uncommitted changes';
  try { diff = git(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--unified=2', '--diff-filter=AMR']); } catch { diff = ''; }
  if (!diff.trim()) {
    try {
      const ts = Number(git(cwd, ['log', '-1', '--format=%ct']).trim()) * 1000;
      if (!ts || now - ts > RECENT_COMMIT_MS) return null;
      diff = git(cwd, ['show', 'HEAD', '--no-color', '--no-ext-diff', '--unified=2', '--diff-filter=AMR', '--format=']);
      origin = 'the latest commit';
    } catch {
      return null;
    }
  }
  const filtered = filterDiff(diff, maxBytes);
  if (!filtered.text.trim()) return null;
  const hash = crypto.createHash('sha1').update(filtered.text).digest('hex').slice(0, 16);
  return { ...filtered, origin, hash };
}

module.exports = { collectChanges, filterDiff, redact, SKIP_PATH };
