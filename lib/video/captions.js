'use strict';
// Fixing the words of a transcript, as pure functions (no I/O):
//   cleanText: what a hand-typed caption may be.
//   buildFixPrompt: the request for Claude — numbered lines plus what the user says it is about.
//   parseFixes: Claude's JSON answer → [{ i, text }], checked line by line (a line that
//   changed too much is dropped: this is a spelling fix, not a rewrite).

const { extractJson } = require('./planner');

const TEXT_MAX = 300;
const MAX_LINES = 400;
const HINT_MAX = 500;

class CaptionError extends Error {}

/** A caption typed by hand: one line, trimmed, 1..300 characters. */
function cleanText(text) {
  const t = String(text == null ? '' : text).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!t) throw new CaptionError('ข้อความซับว่างไม่ได้');
  if (t.length > TEXT_MAX) throw new CaptionError(`ข้อความซับยาวเกินไป (ไม่เกิน ${TEXT_MAX} ตัวอักษร)`);
  return t;
}

const SYSTEM = [
  'คุณช่วยตรวจซับไตเติลภาษาไทยที่โปรแกรมถอดเสียงจากเสียงพูด',
  'โปรแกรมถอดเสียงมักเขียนคำอังกฤษ ชื่อผลิตภัณฑ์ และศัพท์เทคนิคที่พูดทับศัพท์เป็นคำไทยที่ผิด เช่น "คอร์ดโค้ด" ที่จริงคือ Claude Code, "ไอดีอี" คือ IDE',
  'หน้าที่ของคุณคือแก้เฉพาะคำที่ผิดชัดเจนตามบริบท: เขียนศัพท์อังกฤษให้ถูกสะกด และแก้คำไทยที่ฟังผิด',
  'ห้ามเรียบเรียงใหม่ ห้ามเพิ่มหรือตัดเนื้อหา ห้ามรวมหรือแยกบรรทัด ถ้าไม่แน่ใจให้ปล่อยบรรทัดนั้นไว้เหมือนเดิม ไม่ต้องใส่ในคำตอบ',
  'ตอบเป็น JSON อย่างเดียว ไม่ต้องอธิบาย',
].join('\n');

/** segments: [{ text }] · hint: what the clip is about / words to expect (free text from the user). */
function buildFixPrompt(segments, hint = '') {
  const lines = segments.slice(0, MAX_LINES).map((s, i) => `${i}: ${s.text}`);
  const h = String(hint || '').trim().slice(0, HINT_MAX);
  return [
    h ? `เรื่องของคลิปและคำที่น่าจะมี (จากผู้ใช้): ${h}` : 'ผู้ใช้ไม่ได้บอกเรื่องของคลิป ให้เดาจากเนื้อหาในบรรทัดทั้งหมด',
    '',
    'บรรทัดซับ (เลขบรรทัด: ข้อความ):',
    ...lines,
    '',
    'ตอบเป็น JSON รูปแบบนี้ เฉพาะบรรทัดที่ต้องแก้เท่านั้น:',
    '{"fixes":[{"i":0,"text":"ข้อความที่แก้แล้วทั้งบรรทัด"}]}',
    'ถ้าไม่มีอะไรต้องแก้ ตอบ {"fixes":[]}',
  ].join('\n');
}

const norm = (s) => String(s).replace(/\s+/g, '');

/**
 * Claude's answer → [{ i, text }] for lines that really changed. Throws CaptionError when the
 * answer is not JSON. A fix is dropped when its line is unknown, empty, too long, unchanged,
 * or so different in length that it is a rewrite rather than a spelling fix.
 */
function parseFixes(answer, segments) {
  let data;
  try {
    data = extractJson(answer);
  } catch {
    throw new CaptionError('คำตอบของ JARVIS ไม่ใช่ JSON ที่อ่านได้');
  }
  if (!data || !Array.isArray(data.fixes)) throw new CaptionError('คำตอบของ JARVIS ไม่มีรายการที่แก้');
  const out = [];
  const seen = new Set();
  for (const f of data.fixes) {
    if (!f || !Number.isInteger(f.i) || typeof f.text !== 'string' || seen.has(f.i)) continue;
    const seg = segments[f.i];
    if (!seg) continue;
    let text;
    try {
      text = cleanText(f.text);
    } catch {
      continue;
    }
    if (norm(text) === norm(seg.text)) continue;
    const a = norm(seg.text).length || 1;
    const b = norm(text).length;
    if (b < a * 0.5 || b > a * 2) continue;
    seen.add(f.i);
    out.push({ i: f.i, text });
  }
  return out;
}

module.exports = { CaptionError, cleanText, buildFixPrompt, parseFixes, SYSTEM, TEXT_MAX, MAX_LINES };
