'use strict';
// Everything DevSharp displays passes through here: bundled packs, custom packs
// and (especially) text fetched from the internet. The goal is that no byte
// sequence from content can move the cursor, recolor, retitle, hyperlink,
// write the clipboard, or visually reorder text in the user's terminal.

// ESC-introduced sequences: CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC, and 2-byte escapes.
const ESC_SEQ = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/g;
// 8-bit C1 equivalents (CSI = U+009B, OSC = U+009D, ...) and the rest of C0/C1 except \n and \t.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Bidi overrides/isolates (Trojan Source), zero-width and other invisible formatting chars.
// ZWJ (U+200D) is kept so composed emoji still render.
const INVISIBLE = /[\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/g;
const LINE_SEP = /[\u2028\u2029\u0085]/g;

function cleanText(input, { maxLen = 2000, multiline = true } = {}) {
  if (input === null || input === undefined) return '';
  let s = String(input);
  if (s.length > maxLen * 4) s = s.slice(0, maxLen * 4);
  s = s.normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(ESC_SEQ, '')
    .replace(LINE_SEP, '\n')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(/\t/g, '  ');
  if (!multiline) s = s.replace(/\s*\n\s*/g, ' ');
  s = s.replace(/[  ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  return s;
}

// Only plain https URLs without credentials, and optionally only on allowed hosts.
function cleanUrl(input, { allowHosts = null } = {}) {
  if (typeof input !== 'string' || input.length > 500) return null;
  const raw = input.trim();
  if (/[\u0000- \u007f-\u009f]/.test(raw)) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (allowHosts && !allowHosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  // Hostnames that are raw IPs are not "public technology sources".
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || host === 'localhost') return null;
  return u.toString();
}

module.exports = { cleanText, cleanUrl };
