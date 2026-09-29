'use strict';
// Minimal, locked-down HTTP GET for public feeds. Sends nothing but the URL and a
// User-Agent: no cookies, no credentials, no local or project data. Redirects are
// followed by hand so every hop is checked against the host allowlist.

const { cleanUrl } = require('../core/sanitize');

const USER_AGENT = 'devsharp (+https://github.com/aman5062/DevSharp)';
const MAX_REDIRECTS = 5;

function header(res, name) {
  try {
    if (res.headers && typeof res.headers.get === 'function') return res.headers.get(name);
    if (res.headers && typeof res.headers === 'object') return res.headers[name] || res.headers[name.toLowerCase()] || null;
  } catch { /* ignore */ }
  return null;
}

async function readCapped(res, maxBytes, abortP) {
  const len = Number(header(res, 'content-length'));
  if (Number.isFinite(len) && len > maxBytes) throw new Error('response too large');
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let total = 0;
    let out = '';
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abortP]);
      if (done) break;
      const chunk = typeof value === 'string' ? Buffer.from(value) : value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        try { reader.cancel(); } catch { /* ignore */ }
        throw new Error('response too large');
      }
      out += decoder.decode(chunk, { stream: true });
    }
    return out + decoder.decode();
  }
  if (typeof res.text === 'function') {
    const text = await Promise.race([res.text(), abortP]);
    if (Buffer.byteLength(String(text), 'utf8') > maxBytes) throw new Error('response too large');
    return String(text);
  }
  throw new Error('unreadable response');
}

async function fetchText(url, { timeoutMs = 8000, maxBytes = 2_000_000, allowHosts, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  let current = cleanUrl(url, { allowHosts });
  if (!current) throw new Error('blocked url');

  const ac = new AbortController();
  let timer;
  const abortP = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  abortP.catch(() => { /* handled by races */ });

  try {
    for (let hop = 0; ; hop++) {
      const res = await Promise.race([
        fetchImpl(current, {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5' },
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: ac.signal,
        }),
        abortP,
      ]);
      if (!res || typeof res.status !== 'number') throw new Error('bad response');

      // Whatever the implementation did, the URL we actually got content from must be allowed.
      if (typeof res.url === 'string' && res.url && !cleanUrl(res.url, { allowHosts })) {
        throw new Error('redirected to disallowed host');
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = header(res, 'location');
        if (!loc) throw new Error(`HTTP ${res.status}`);
        if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
        let next;
        try {
          next = new URL(loc, current).toString();
        } catch {
          throw new Error('bad redirect');
        }
        const safe = cleanUrl(next, { allowHosts });
        if (!safe) throw new Error('redirected to disallowed host');
        try { if (res.body && typeof res.body.cancel === 'function') res.body.cancel(); } catch { /* ignore */ }
        current = safe;
        continue;
      }
      if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`);
      return await readCapped(res, maxBytes, abortP);
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchText, USER_AGENT };
