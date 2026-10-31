'use strict';
// Word timing for subtitles that appear one word at a time (pure, no I/O):
//   thaiWords(text)                     text → words, Thai-aware; spaces stay on the word before
//   alignWords(text, start, end, toks)  words with times from whisper's token times when they are
//                                       trustworthy, else spread over the line by letters
//   isKeyWord(word)                     AI, CODE, ERROR, numbers… the words a caption highlights
// Every result says how its times were found: timing 'tokens' (heard) or 'estimated' (spread).

const r3 = (x) => Math.round(x * 1000) / 1000;
const visible = (s) => s.replace(/\s+/g, '').length;
const squash = (s) => String(s).replace(/\s+/g, '');

/** Words of a line, Thai-aware ("สวัสดีครับ" → สวัสดี | ครับ); spaces stay attached to the word before. */
function thaiWords(text) {
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
  const parts = seg ? [...seg.segment(String(text))].map((s) => s.segment) : String(text).split(/(\s+)/);
  const out = [];
  for (const p of parts) {
    if (/^\s+$/.test(p) && out.length) out[out.length - 1] += p;
    else if (p && !/^\s+$/.test(p)) out.push(p);
  }
  return out;
}

/** Spread over [start, end] in proportion to letters (a word never gets less than a sliver). */
function spread(ws, start, end) {
  const total = ws.reduce((n, w) => n + Math.max(1, visible(w)), 0) || 1;
  let t = start;
  return ws.map((w) => {
    const len = (end - start) * (Math.max(1, visible(w)) / total);
    const row = { text: w, start: r3(t), end: r3(t + len) };
    t += len;
    return row;
  });
}

/**
 * Token times are only used when they add up to the text, never go backwards, stay inside the
 * line, and are not mostly the same number (whisper repeats one time for Thai sometimes).
 */
function trustedTokens(text, start, end, tokens) {
  if (!Array.isArray(tokens) || tokens.length < 2) return null;
  if (squash(tokens.map((t) => t.text).join('')) !== squash(text)) return null;
  let last = -Infinity;
  for (const t of tokens) {
    if (!Number.isFinite(t.start) || t.start < last - 1e-6 || t.start < start - 0.15 || t.start > end + 0.15) return null;
    last = t.start;
  }
  const distinct = new Set(tokens.map((t) => Math.round(t.start * 20))).size;
  if (distinct < tokens.length * 0.6) return null;
  return tokens;
}

/**
 * text: the line · start/end: its time (seconds) · tokens: [{ text, start }] absolute seconds, optional.
 * Returns { timing, words: [{ text, start, end }] } — words in order, end of one = start of next
 * (the last one ends at `end`). Empty text gives no words.
 */
function alignWords(text, start, end, tokens) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || !(end > start)) return { timing: 'estimated', words: [] };
  const ws = thaiWords(clean);
  const good = trustedTokens(clean, start, end, tokens);
  if (!good) return { timing: 'estimated', words: spread(ws, start, end) };
  // a word starts where the first token with one of its letters starts
  const starts = [];
  let ti = 0;
  let seen = 0; // letters of tokens passed
  let offset = 0; // letters before the current word
  for (const w of ws) {
    while (ti < good.length - 1 && offset >= seen + squash(good[ti].text).length) {
      seen += squash(good[ti].text).length;
      ti++;
    }
    starts.push(Math.min(end, Math.max(start, good[ti].start)));
    offset += visible(w);
  }
  // keep them strictly in order, and each word at least a little long
  for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i], starts[i - 1] + 0.04);
  const out = ws.map((w, i) => {
    const s = Math.min(starts[i], Math.max(start, end - 0.04 * (ws.length - i)));
    const e = i + 1 < ws.length ? Math.min(starts[i + 1], end) : end;
    return { text: w, start: r3(s), end: r3(Math.max(s + 0.03, e)) };
  });
  return { timing: 'tokens', words: out };
}

const KEY = /^(?:[A-Z]{2,}[0-9]*|[A-Za-z]*[0-9]+[A-Za-z0-9]*|AI|API|UI|UX|CODE|ERROR|BUG|APP|VIBE|CLAUDE|GPT)$/;
const KEY_LOWER = new Set(['ai', 'api', 'code', 'error', 'bug', 'app', 'vibe', 'prompt', 'claude', 'chatgpt', 'github', 'python', 'javascript']);

/** Words a caption highlights: acronyms, numbers, and a short list of programming words. */
function isKeyWord(word) {
  const w = String(word).replace(/[^\p{L}\p{N}]/gu, '');
  if (!w) return false;
  return KEY.test(w) || KEY_LOWER.has(w.toLowerCase());
}

/** Cuts words into phrases of at most `maxWords` words and `maxChars` letters, for the screen. */
function phrases(words, { maxWords = 4, maxChars = 16 } = {}) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const w of words) {
    const n = visible(w.text);
    if (cur.length && (cur.length >= maxWords || chars + n > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The stored words of a transcript line, only while they still match its text and times; else null. */
function validWords(seg) {
  const w = seg && seg.words;
  if (!Array.isArray(w) || !w.length) return null;
  if (squash(w.map((x) => x.text).join('')) !== squash(seg.text)) return null;
  if (Math.abs(w[0].start - seg.start) > 0.01 || Math.abs(w[w.length - 1].end - seg.end) > 0.01) return null;
  return w.map((x) => ({ text: x.text, start: x.start, end: x.end }));
}

module.exports = { validWords, thaiWords, alignWords, isKeyWord, phrases, spread };
