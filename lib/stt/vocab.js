'use strict';
// Speech-to-text helpers for technical words:
// - buildWhisperPrompt: an initial prompt (--prompt) listing words whisper should expect.
// - corrections: a "heard=meant" dictionary applied to every final transcript.

// Words whisper often gets wrong in coding talk. ASCII only: the bundled
// whisper-cli reads its arguments in the Windows ANSI code page, so Thai text
// in --prompt arrives garbled. Thai mishearings go in the corrections instead.
const DEFAULT_VOCAB = [
  'Jarvis', 'Claude Code', 'GitHub', 'git commit', 'npm test', 'npm run check',
  'JavaScript', 'Python', 'Node.js', 'Electron', 'Arduino', 'ESP32', 'function', 'bug',
];

// heard=meant, one rule per line
const DEFAULT_CORRECTIONS = [
  'ควักโค้ด=Claude Code',
  'ควัดโค้ด=Claude Code',
  'คล็อดโค้ด=Claude Code',
  'คลอดโค้ด=Claude Code',
  'ดาวิสต์=จาร์วิส',
  'ดาวิส=จาร์วิส',
];

const MAX_PROMPT_CHARS = 400; // whisper allows n_text_ctx/2 tokens; keep it short so it stays fast

const isAscii = (s) => /^[\x20-\x7e]+$/.test(s);

/**
 * @param {string[]} vocab user words (non-ASCII ones are skipped, see above)
 * @param {string} [project] project folder name, also a likely spoken word
 * @returns {string} '' when there is nothing to add
 */
function buildWhisperPrompt(vocab = [], project = '') {
  const words = [];
  const seen = new Set();
  for (const w of [project, ...vocab]) {
    const t = String(w || '').trim();
    if (!t || !isAscii(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    words.push(t);
  }
  let out = '';
  for (const w of words) {
    const next = out ? `${out}, ${w}` : w;
    if (next.length > MAX_PROMPT_CHARS) break;
    out = next;
  }
  return out;
}

/** "heard=meant" lines → [[heard, meant]], longest heard first so "ดาวิสต์" wins over "ดาวิส". */
function parseCorrections(lines = []) {
  const rules = [];
  for (const line of lines) {
    const i = String(line).indexOf('=');
    if (i <= 0) continue;
    const from = line.slice(0, i).trim();
    const to = line.slice(i + 1).trim();
    if (from && from !== to) rules.push([from, to]);
  }
  return rules.sort((a, b) => b[0].length - a[0].length);
}

/** Replace every heard phrase in one pass (a replacement is never re-matched). */
function applyCorrections(text, rules) {
  if (!text || !rules || !rules.length) return text;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const map = new Map(rules.map(([f, t]) => [f.toLowerCase(), t]));
  const re = new RegExp(rules.map(([f]) => esc(f)).join('|'), 'gi');
  return text.replace(re, (m) => map.get(m.toLowerCase()) ?? m);
}

module.exports = { DEFAULT_VOCAB, DEFAULT_CORRECTIONS, buildWhisperPrompt, parseCorrections, applyCorrections };
