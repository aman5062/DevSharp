'use strict';
// Card rendering. Output is plain text (no ANSI) because it is shown inside
// Claude Code's own UI; the CLI adds colour separately when stdout is a TTY.
//
// Default style is "rail": a left border only. Unlike a closed box it cannot
// be misaligned by emoji-width differences between terminals, and it survives
// the host UI re-wrapping long lines on narrow terminals.

const { cleanText } = require('./sanitize');

const HEADERS = {
  fact: ['⚡', 'QUICK FACT'],
  think: ['🧠', 'THINK FIRST'],
  concept: ['📘', 'CONCEPT'],
  why: ['❓', 'WHY?'],
  update: ['📰', 'TECH UPDATE'],
  answer: ['💡', 'ANSWER'],
};

function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0;
  if (cp >= 0x1f000) return 2;
  if ([0x231a, 0x231b, 0x23f0, 0x23f3, 0x26a1, 0x2705, 0x274c, 0x2753, 0x2754, 0x2755, 0x2757, 0x2b50].includes(cp)) return 2;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)) return 2;
  return 1;
}

function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

// Greedy word wrap by display width; hard-breaks words longer than the line (e.g. URLs).
// pre: keep lines (and their column alignment) as-is unless they are too long.
function wrap(text, width, { pre = false } = {}) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    if (pre && displayWidth(para) <= width) { out.push(para.trimEnd()); continue; }
    let line = '';
    for (let word of para.split(/ +/)) {
      while (displayWidth(word) > width) {
        if (line) { out.push(line); line = ''; }
        let cut = '';
        for (const ch of word) {
          // Always take at least one character, or a character wider than the line loops forever.
          if (cut && displayWidth(cut + ch) > width) break;
          cut += ch;
        }
        out.push(cut);
        word = word.slice(cut.length);
      }
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (displayWidth(next) > width) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

function frame(header, blocks, footer, { style = 'rail', width = 64, pre = false } = {}) {
  const inner = Math.max(30, width - 4);
  const body = [];
  blocks.forEach((b, i) => {
    if (i) body.push('');
    body.push(...wrap(cleanText(b), inner, { pre }));
  });
  const foot = footer ? wrap(cleanText(footer, { multiline: false }), inner) : [];
  if (style === 'plain') {
    return [header, '', ...body, ...(foot.length ? ['', ...foot] : [])].join('\n');
  }
  if (style === 'box') {
    const w = inner + 2;
    const pad = (s) => `│ ${s}${' '.repeat(Math.max(0, inner - displayWidth(s)))} │`;
    const top = `╭─ ${header} ${'─'.repeat(Math.max(1, w - displayWidth(header) - 3))}╮`;
    return [top, pad(''), ...body.map(pad), ...(foot.length ? [pad(''), ...foot.map(pad)] : []), `╰${'─'.repeat(w)}╯`].join('\n');
  }
  const lines = [`╭─ ${header}`, '│', ...body.map((l) => (l ? `│  ${l}` : '│'))];
  if (foot.length) {
    lines.push('│');
    foot.forEach((l, i) => lines.push(i === foot.length - 1 ? `╰─ ${l}` : `│  ${l}`));
  } else lines.push('╰─');
  return lines.join('\n');
}

function sourceLine(item) {
  if (!item.source) return '';
  const { name, url } = item.source;
  return [name, url].filter(Boolean).join(' · ');
}

function fmtDate(ms) {
  if (!ms) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

// A freshly selected card.
function renderCard(item, opts = {}) {
  const { reveal = 'inline' } = opts;
  const inline = reveal === 'inline' && hasAnswer(item);
  const revealHint = !inline && opts.revealHint !== false;
  const [icon, label] = HEADERS[item.type] || HEADERS.fact;
  const header = `${icon} ${label} · ${item.topicName || item.topic}${item.ai ? ' · ✨ from your code' : ''}`;
  const later = reveal === 'next-turn' ? ' (or wait: it appears when Claude finishes)' : '';
  const blocks = [];
  switch (item.type) {
    case 'think':
      blocks.push(item.title, item.question);
      if (inline) blocks.push(`💡 ${item.answer}`);
      if (revealHint) blocks.push(`💭 Think it through first. /devsharp:reveal shows the answer${later}.`);
      break;
    case 'why':
      blocks.push(item.question);
      if (inline) blocks.push(`💡 ${item.answer}`);
      if (revealHint) blocks.push(`💭 Have a guess. /devsharp:reveal shows the answer${later}.`);
      break;
    case 'update':
      blocks.push(item.title, [fmtDate(item.published), item.url].filter(Boolean).join(' · '));
      if (item.note) blocks.push(`✨ In short: ${item.note}`);
      blocks.push(item.note ? 'Headline from a public feed; the note above is AI-generated.' : 'Headline from a public feed, shown as-is.');
      break;
    case 'concept':
    case 'fact':
    default:
      blocks.push(item.title, item.body);
      if (inline) {
        blocks.push(`🤔 ${item.question}`, `💡 ${item.answer}`);
      } else if (item.question && item.answer) {
        blocks.push(`💡 Think: ${item.question}${revealHint ? ` (/devsharp:reveal${later ? ' or next turn' : ''})` : ''}`);
      }
  }
  let footer = item.type === 'update' ? `Source: ${item.source && item.source.name ? item.source.name : item.topic}` : sourceLine(item);
  if (item.ai) footer = `${footer} · verify`;
  return frame(header, blocks, footer, opts);
}

function hasAnswer(item) {
  return !!(item && item.answer && item.type !== 'update');
}

// The answer to a Think First / Why / "Think:" prompt.
function renderAnswer(item, opts = {}) {
  const [icon, label] = HEADERS.answer;
  const when = opts.done ? ' · Claude is done' : opts.still ? ' · Claude is still working' : '';
  const header = `${icon} ${label} · ${item.topicName || item.topic}${item.ai ? ' · ✨ from your code' : ''}${when}`;
  const blocks = [item.title];
  if (item.question) blocks.push(`Q: ${item.question}`);
  blocks.push(item.answer);
  if (opts.auto) blocks.push('Knew it? /devsharp:known · Not for you? /devsharp:dismiss');
  return frame(header, blocks, sourceLine(item), opts);
}

function renderNotice(title, lines, opts = {}) {
  return frame(`🎯 DevSharp · ${title}`, [Array.isArray(lines) ? lines.join('\n') : lines], '', { ...opts, pre: true });
}

module.exports = { renderCard, renderAnswer, renderNotice, wrap, displayWidth, hasAnswer, frame };
