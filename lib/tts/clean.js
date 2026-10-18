'use strict';
// Turn a prose segment into something safe and natural to speak:
// no markdown syntax, URLs, inline code ticks, table rows, emoji, or JSON.

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

function looksLikeJson(s) {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return /^[[{]\s*"/.test(t); // partial JSON object/array
  }
}

function cleanForSpeech(input) {
  if (!input) return '';
  const lines = String(input).split('\n').filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^\|.*\|$/.test(t) || /^[-:| ]{3,}$/.test(t)) return false; // table rows / separators
    if (/^(`{3,}|~{3,})/.test(t)) return false; // stray fence
    if (looksLikeJson(t)) return false;
    return true;
  });
  let s = lines.join(' ');
  s = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/<?\bhttps?:\/\/[^\s>)]+>?/gi, '') // bare URLs
    .replace(/\bwww\.[^\s)]+/gi, '')
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/`/g, '')
    .replace(/(^|\s)#{1,6}\s+/g, '$1') // headings
    .replace(/(^|\s)>\s+/g, '$1') // blockquote
    .replace(/(^|\s)[-*+•]\s+/g, '$1') // bullets
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2') // emphasis
    .replace(/[*#|<>{}[\]\\]/g, ' ')
    .replace(EMOJI, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s;
}

module.exports = { cleanForSpeech, looksLikeJson };
