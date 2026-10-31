'use strict';
// AskUserQuestion: Claude asks the user to choose. The HUD shows the options as check boxes
// (plus a text box) and the answer goes back to the CLI as updatedInput { questions, answers },
// where answers maps each question's text to the chosen labels joined with ", " (and any typed text).

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;
const MAX_TEXT = 1000;
const MAX_LABEL = 200;

const clip = (x, n) => (typeof x === 'string' ? x.trim().slice(0, n) : '');

/**
 * Questions from the tool input, cleaned for display. null when there is nothing askable.
 * @returns {{question:string, header:string, multiSelect:boolean, options:{label:string, description:string}[]}[]|null}
 */
function normalizeQuestions(input) {
  const raw = input && Array.isArray(input.questions) ? input.questions : null;
  if (!raw || !raw.length) return null;
  const out = [];
  for (const q of raw.slice(0, MAX_QUESTIONS)) {
    if (!q || typeof q !== 'object') return null;
    const question = clip(q.question, 500);
    if (!question) return null;
    const options = [];
    for (const o of (Array.isArray(q.options) ? q.options : []).slice(0, MAX_OPTIONS)) {
      const label = clip(o && o.label, MAX_LABEL);
      if (label && !options.some((x) => x.label === label)) options.push({ label, description: clip(o.description, 500) });
    }
    out.push({ question, header: clip(q.header, 40), multiSelect: q.multiSelect === true, options });
  }
  return out;
}

/**
 * The user's choices → the CLI's updatedInput.
 * @param {object} input the original tool input
 * @param {{picked?:string[], text?:string}[]} answers one entry per question, in order
 * @returns {{ok:true, updatedInput:object, summary:string}|{ok:false, error:string}}
 */
function buildAnswer(input, answers) {
  const qs = normalizeQuestions(input);
  if (!qs) return { ok: false, error: 'คำถามผิดรูปแบบ' };
  if (!Array.isArray(answers) || answers.length !== qs.length) return { ok: false, error: 'ตอบไม่ครบทุกข้อ' };
  const map = {};
  const lines = [];
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const a = answers[i] && typeof answers[i] === 'object' ? answers[i] : {};
    const picked = Array.isArray(a.picked) ? a.picked : [];
    const labels = new Set(q.options.map((o) => o.label));
    if (picked.some((p) => typeof p !== 'string' || !labels.has(p))) return { ok: false, error: `ตัวเลือกข้อ ${i + 1} ไม่ถูกต้อง` };
    if (new Set(picked).size !== picked.length) return { ok: false, error: `ตัวเลือกข้อ ${i + 1} ซ้ำกัน` };
    if (!q.multiSelect && picked.length > 1) return { ok: false, error: `ข้อ ${i + 1} เลือกได้ข้อเดียว` };
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (text.length > MAX_TEXT) return { ok: false, error: `ข้อความข้อ ${i + 1} ยาวเกิน ${MAX_TEXT}` };
    const parts = [...picked, ...(text ? [text] : [])];
    if (!parts.length) return { ok: false, error: `ยังไม่ได้ตอบข้อ ${i + 1}` };
    map[q.question] = parts.join(', ');
    lines.push(`${q.question} → ${map[q.question]}`);
  }
  return { ok: true, updatedInput: { ...input, questions: input.questions, answers: map }, summary: lines.join(' | ').slice(0, 1000) };
}

const CONTEXT_MAX = 6000;

/**
 * What Claude wrote just before asking, as plain text for the question popup (the popup covers the
 * chat, so the plan it asks about must be inside it). jarvis-steps and result blocks become readable
 * lines, other code blocks are dropped, a half-written block at the end is cut off.
 */
/** A displayed block as plain text: steps and text / table results are readable, anything else is '' (null = not a plan-like block). */
function blockToText(kind, data) {
  if (!data || typeof data !== 'object') return null;
  const head = data.title ? `${data.title}\n` : '';
  if (kind === 'steps' && Array.isArray(data.steps)) {
    const rows = data.steps.slice(0, 40).map((s, i) => `${s.done ? '✔' : `${i + 1}.`} ${s.title || ''}${s.detail ? ` — ${s.detail}` : ''}`);
    return `${head}${rows.join('\n')}`;
  }
  if (kind === 'result') {
    if (typeof data.markdown === 'string') return `${head}${data.markdown}`;
    if (Array.isArray(data.columns) && Array.isArray(data.rows)) {
      return `${head}${data.columns.join(' | ')}\n${data.rows.slice(0, 30).map((r) => (Array.isArray(r) ? r.join(' | ') : '')).join('\n')}`;
    }
  }
  return null;
}

function contextFromText(raw) {
  let text = String(raw || '');
  const open = text.lastIndexOf('```');
  if (open >= 0 && (text.slice(0, open).match(/```/g) || []).length % 2 === 0) text = text.slice(0, open); // unclosed fence
  text = text.replace(/```([\w-]*)[^\n]*\n([\s\S]*?)```/g, (_m, lang, body) => {
    let data;
    try { data = JSON.parse(body); } catch { return '\n'; }
    const t = lang.startsWith('jarvis-') ? blockToText(lang.slice(7), data) : null;
    return t ? `\n${t}\n` : '\n';
  });
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text.length > CONTEXT_MAX ? '…' + text.slice(-CONTEXT_MAX) : text;
}

/**
 * The text for the question popup: the plan last shown on screen (when it is not already in this
 * turn's text) first, then what Claude wrote this turn.
 */
function buildContext(turnText, shownPlan) {
  const turn = contextFromText(turnText);
  const plan = shownPlan ? String(shownPlan).trim().slice(0, CONTEXT_MAX) : '';
  if (!plan || turn.includes(plan)) return turn;
  return turn ? `${plan}\n\n${turn}` : plan;
}

module.exports = { normalizeQuestions, buildAnswer, contextFromText, blockToText, buildContext, MAX_QUESTIONS, MAX_OPTIONS, MAX_TEXT };
