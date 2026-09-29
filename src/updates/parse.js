'use strict';
// Hand-written, dependency-free parsers for RSS 2.0 / Atom feeds and the GitHub
// releases API. Everything here is plain string processing: content is never
// evaluated, executed or interpreted beyond extracting text. Every title goes
// through cleanText and every link through cleanUrl (https + host allowlist).

const crypto = require('crypto');
const { cleanText, cleanUrl } = require('../core/sanitize');

const MAX_INPUT = 2_000_000; // characters
const MAX_ITEMS = 50;
const GITHUB_HOSTS = ['github.com', 'api.github.com'];

// Hosts an item's link may point at for a given (already validated) source.
function sourceAllowHosts(source) {
  if (!source) return [];
  if (source.type === 'github-releases') return GITHUB_HOSTS.slice();
  const hosts = [];
  try {
    hosts.push(new URL(source.url).hostname.toLowerCase());
  } catch { /* invalid url -> no hosts */ }
  if (Array.isArray(source.allow_hosts)) {
    for (const h of source.allow_hosts) if (typeof h === 'string') hosts.push(h.toLowerCase());
  }
  return hosts;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•' };

function codePoint(n) {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '';
  return String.fromCodePoint(n);
}

// Single pass, so "&amp;lt;" decodes to the literal text "&lt;" (no double-decoding).
function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,9}|[a-zA-Z][a-zA-Z0-9]{1,15});/g, (m, body) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return codePoint(n);
    }
    const v = NAMED[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const stripTags = (s) => s.replace(/<[^>]*>/g, ' ');

// Text content of an XML element body: CDATA kept literally, markup removed,
// entities decoded once. CDATA bodies usually contain HTML, so they get the same
// tag stripping + entity decoding.
function xmlText(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf('<![CDATA[', i);
    if (start === -1) {
      out += decodeEntities(stripTags(raw.slice(i)));
      break;
    }
    out += decodeEntities(stripTags(raw.slice(i, start)));
    const end = raw.indexOf(']]>', start + 9);
    const cdata = end === -1 ? raw.slice(start + 9) : raw.slice(start + 9, end);
    out += decodeEntities(stripTags(cdata));
    i = end === -1 ? raw.length : end + 3;
  }
  return out.replace(/[ \t\r\n]+/g, ' ');
}

// Atom type="html" text is escaped markup: after decoding, drop real-looking tags.
const htmlToText = (s) => s.replace(/<\/?[a-zA-Z][^<>]{0,200}>/g, ' ').replace(/[ \t\r\n]+/g, ' ');

// ---- linear tag scanner ----------------------------------------------------
// Only indexOf-based scanning (no backtracking regexes over large text), so
// hostile input such as thousands of unclosed tags stays linear-time.

const FIELD_CAP = 4096; // raw chars of a field we are willing to look at
const TAG_CAP = 2048;

// ASCII-only lowercase keeps string length (and therefore indexes) identical.
const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

function isNameEnd(ch) {
  return ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

// Next opening tag <name ...> at or after `from`. Returns {start, bodyStart, tag, selfClosing} or null.
function findOpen(raw, lower, name, from) {
  const needle = '<' + name;
  let i = from;
  for (;;) {
    i = lower.indexOf(needle, i);
    if (i === -1) return null;
    if (isNameEnd(lower[i + needle.length])) {
      const gt = lower.indexOf('>', i);
      if (gt === -1) return null;
      const tag = raw.slice(i + needle.length, Math.min(gt, i + needle.length + TAG_CAP));
      return { start: i, bodyStart: gt + 1, tag, selfClosing: raw[gt - 1] === '/' };
    }
    i += needle.length;
  }
}

// First <name>body</name> in a block.
function firstElement(raw, lower, name) {
  const o = findOpen(raw, lower, name, 0);
  if (!o) return null;
  if (o.selfClosing) return { tag: o.tag, body: '' };
  const close = lower.indexOf('</' + name, o.bodyStart);
  if (close === -1) return null;
  return { tag: o.tag, body: raw.slice(o.bodyStart, Math.min(close, o.bodyStart + FIELD_CAP)) };
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  const src = s.length > TAG_CAP ? s.slice(0, TAG_CAP) : s;
  while ((m = re.exec(src)) !== null) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

function extractLink(raw, lower) {
  // Atom-style <link href="..."/>: prefer rel="alternate" (or no rel), else first href.
  let first = null;
  let pos = 0;
  for (let n = 0; n < 20; n++) {
    const o = findOpen(raw, lower, 'link', pos);
    if (!o) break;
    pos = o.bodyStart;
    const a = parseAttrs(o.tag);
    if (!a.href) continue;
    if (!a.rel || a.rel === 'alternate') return a.href.trim();
    if (first === null) first = a.href.trim();
  }
  if (first) return first;
  // RSS-style <link>url</link>
  const l = firstElement(raw, lower, 'link');
  if (l && l.body) {
    const t = xmlText(l.body).trim();
    if (t) return t;
  }
  // RSS guid used as permalink
  const g = firstElement(raw, lower, 'guid');
  if (g && parseAttrs(g.tag).ispermalink !== 'false') return xmlText(g.body).trim();
  return '';
}

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t || t.length > 64) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

const SUMMARY_MAX = 600;

// Plain-text excerpt of release notes / post body. Kept short: it is only used as
// input for optional AI notes, never executed, and always sanitised again on display.
function toSummary(text) {
  if (typeof text !== 'string' || !text) return '';
  const s = text.slice(0, FIELD_CAP)
    .replace(/<\/?[a-zA-Z][^<>]{0,200}>/g, ' ')
    .replace(/!?\[([^\]\n]{0,200})\]\([^)\n]{0,500}\)/g, '$1') // markdown links/images -> text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[`*_>|]+/g, ' ')
    .replace(/\s+/g, ' ');
  return cleanText(s, { maxLen: SUMMARY_MAX, multiline: false });
}

function makeItem(source, rawTitle, rawLink, published, rawSummary = '') {
  const title = cleanText(rawTitle, { maxLen: 160, multiline: false });
  const url = cleanUrl(typeof rawLink === 'string' ? rawLink : '', { allowHosts: sourceAllowHosts(source) });
  if (!title || !url) return null;
  const id = 'upd-' + crypto.createHash('sha1').update(String(source.id) + url + title).digest('hex').slice(0, 12);
  return {
    id,
    sourceId: source.id,
    topic: source.topic,
    name: cleanText(source.name, { maxLen: 60, multiline: false }),
    title,
    url,
    published: Number.isFinite(published) ? published : null,
    summary: toSummary(rawSummary),
  };
}

function parseFeed(xmlString, source) {
  if (typeof xmlString !== 'string' || !source) return [];
  const xml = xmlString.length > MAX_INPUT ? xmlString.slice(0, MAX_INPUT) : xmlString;
  const lower = asciiLower(xml);
  const items = [];
  const seen = new Set();
  const next = { item: undefined, entry: undefined }; // cached next opening per element name
  let pos = 0;
  while (items.length < MAX_ITEMS) {
    for (const name of ['item', 'entry']) {
      if (next[name] !== null && (next[name] === undefined || next[name].start < pos)) {
        next[name] = findOpen(xml, lower, name, pos);
      }
    }
    const a = next.item;
    const b = next.entry;
    if (!a && !b) break;
    const name = a && (!b || a.start <= b.start) ? 'item' : 'entry';
    const open = next[name];
    const close = open.selfClosing ? -1 : lower.indexOf('</' + name, open.bodyStart);
    if (close === -1) {
      // unclosed: nothing after this point can close it either; stop looking for this element
      if (open.selfClosing) { pos = open.bodyStart; continue; }
      next[name] = null;
      continue;
    }
    pos = close + 1;
    const block = xml.slice(open.bodyStart, close);
    const blockLower = lower.slice(open.bodyStart, close);
    const t = firstElement(block, blockLower, 'title');
    let title = t ? xmlText(t.body) : '';
    if (t && /\btype\s*=\s*["'](?:html|xhtml)["']/i.test(t.tag)) title = htmlToText(title);
    const link = extractLink(block, blockLower);
    let published = null;
    for (const field of ['pubdate', 'published', 'updated', 'dc:date']) {
      const d = firstElement(block, blockLower, field);
      if (d) {
        published = parseDate(xmlText(d.body.slice(0, 200)));
        if (published !== null) break;
      }
    }
    let summary = '';
    for (const field of ['description', 'summary', 'content']) {
      const d = firstElement(block, blockLower, field);
      if (d) { summary = htmlToText(xmlText(d.body)); if (summary.trim()) break; }
    }
    const item = makeItem(source, title, link.slice(0, 2048), published, summary);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

function parseGithubReleases(jsonString, source) {
  if (typeof jsonString !== 'string' || !source) return [];
  if (jsonString.length > MAX_INPUT) throw new Error('response too large');
  const data = JSON.parse(jsonString); // throws on garbage; callers treat that as a failed fetch
  if (!Array.isArray(data)) throw new Error('unexpected GitHub response');
  const items = [];
  const seen = new Set();
  for (const r of data) {
    if (items.length >= MAX_ITEMS) break;
    if (!r || typeof r !== 'object' || r.draft === true || r.prerelease === true) continue;
    const title = typeof r.name === 'string' && r.name.trim() ? r.name : typeof r.tag_name === 'string' ? r.tag_name : '';
    const published = parseDate(typeof r.published_at === 'string' ? r.published_at : r.created_at);
    const item = makeItem(source, title, r.html_url, published, typeof r.body === 'string' ? r.body : '');
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

module.exports = { parseFeed, parseGithubReleases, toSummary, sourceAllowHosts, decodeEntities, xmlText, MAX_INPUT, MAX_ITEMS };
