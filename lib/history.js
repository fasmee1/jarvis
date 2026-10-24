'use strict';
// Conversation history: reads the transcripts Claude Code already keeps in
// ~/.claude/projects/<project folder, non-alphanumerics → '-'>/<sessionId>.jsonl.
// Read-only — JARVIS never writes or deletes these files.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 256 * 1024; // enough to find the first question of a session
const MAX_MESSAGES = 400;
const MAX_TEXT = 8000;
const MAX_RESULT = 3000;
const MAX_INPUT = 2000;
const MAX_DIFF = 200;

const defaultBase = () => path.join(os.homedir(), '.claude', 'projects');
const encode = (cwd) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/** The transcript folder of a project, or null when it has none yet. */
function projectDir(cwd, base = defaultBase()) {
  if (!cwd) return null;
  const dir = path.join(base, encode(cwd));
  return fs.existsSync(dir) ? dir : null;
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a cut-off last line */ }
  }
  return out;
}

// What JARVIS puts in front of the user's words (mode notes, attachments,
// carried-over context, image notes) — not what the user said.
function cleanUserText(t) {
  let s = String(t || '');
  s = s.replace(/\[บริบทจาก session ก่อนหน้า\][\s\S]*?\[จบบริบท\]\s*/g, '');
  s = s.replace(/\[ผู้ใช้แนบไฟล์\/โฟลเดอร์[^\]]*\]\n((?:- [^\n]*\n?)*)\n?/g, (_m, list) => {
    const names = list.split('\n').filter(Boolean).map((l) => path.basename(l.replace(/^- [^:]*:\s*/, '')));
    return names.length ? `📎 ${names.join(', ')}\n` : '';
  });
  s = s.replace(/\[JARVIS: [\s\S]*?\]\n/g, '');
  s = s.replace(/\[แนบภาพ[^\]]*\]\n/g, '📷 ');
  return s.trim();
}

/** Screen blocks (```jarvis-…```) are shown as a short note in the history. */
function cleanAssistantText(t) {
  return String(t || '')
    .replace(/```(jarvis-[\w-]+)[\s\S]*?```/g, (_m, kind) => `[แสดงบนจอ: ${kind.replace(/^jarvis-/, '')}]`)
    .trim();
}

function userText(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain || !o.message) return null;
  const c = o.message.content;
  let text = '';
  let images = 0;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return null; // a tool's output, not the user
    text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    images = c.filter((b) => b.type === 'image').length;
  }
  if (/^\s*<(command-|local-command|system-reminder)/.test(text)) return null;
  text = cleanUserText(text);
  if (images && !text.startsWith('📷')) text = `📷 ${text}`.trim();
  return text || null;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

// Long strings in a tool's input (a whole file written) are cut so the IPC payload stays small.
function slimInput(v) {
  if (typeof v === 'string') return clip(v, MAX_INPUT);
  if (Array.isArray(v)) return v.slice(0, 50).map(slimInput);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, slimInput(x)]));
  return v;
}

/** Same Thai one-liner and diff the live conversation shows for a tool call. */
function toolPart(b) {
  const { toolSummary } = require('./jarvis-core');
  const { lineDiff } = require('./diff');
  const input = b.input || {};
  let preview = null;
  try {
    if (b.name === 'Edit') preview = { file: input.file_path, diff: lineDiff(input.old_string, input.new_string) };
    else if (b.name === 'MultiEdit') {
      preview = { file: input.file_path, diff: (input.edits || []).flatMap((e, i) => [{ op: '@', line: `แก้ไขที่ ${i + 1}` }, ...lineDiff(e.old_string, e.new_string)]) };
    } else if (b.name === 'Write') preview = { file: input.file_path, diff: lineDiff('', String(input.content ?? '')) };
    if (preview) preview.diff = preview.diff.slice(0, MAX_DIFF).map((d) => ({ op: d.op, line: clip(String(d.line), 300) }));
  } catch { /* preview is best effort */ }
  return { type: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, input), input: slimInput(input), preview, parent: false, result: null };
}

/** Text and tool calls of one assistant line, in order. */
function assistantParts(o) {
  if (o.type !== 'assistant' || o.isSidechain || !o.message || !Array.isArray(o.message.content)) return [];
  const out = [];
  for (const b of o.message.content) {
    if (b.type === 'text') {
      const t = cleanAssistantText(b.text);
      if (t) out.push({ type: 'text', text: t });
    } else if (b.type === 'tool_use' && b.name !== 'TodoWrite') out.push(toolPart(b));
  }
  return out;
}

const MAX_TOOL_STR = 4000;
const MAX_RESULT = 3000;

// Long strings in a tool input (file contents, patches) are cut so one message stays small.
function slimInput(v) {
  if (typeof v === 'string') return clip(v, MAX_TOOL_STR);
  if (Array.isArray(v)) return v.slice(0, 50).map(slimInput);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, slimInput(x)]));
  return v;
}

function resultToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return '';
}

// Same summary and diff the live conversation shows (lazy: jarvis-core is heavy).
function toolPart(b) {
  const { toolSummary, previewFor } = require('./jarvis-core');
  const input = b.input || {};
  let preview = null;
  if (b.name === 'Write') {
    // the file already exists now, so the live diff against the disk would be empty
    preview = { file: input.file_path, isNew: true, diff: require('./diff').lineDiff('', String(input.content || '')) };
  } else {
    preview = previewFor(b.name, input);
  }
  if (preview && preview.diff) preview = { ...preview, diff: preview.diff.slice(0, 400).map((d) => ({ ...d, line: clip(String(d.line), 400) })) };
  return { type: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, input), input: slimInput(input), preview, result: null };
}

/** Tool calls of an assistant line (sub-agent lines and the to-do list are left out, as on screen). */
function assistantTools(o) {
  if (o.type !== 'assistant' || o.isSidechain || !o.message || !Array.isArray(o.message.content)) return [];
  return o.message.content.filter((b) => b.type === 'tool_use' && b.name !== 'TodoWrite').map(toolPart);
}

function toolResults(o) {
  if (o.type !== 'user' || o.isSidechain || !o.message || !Array.isArray(o.message.content)) return [];
  return o.message.content.filter((b) => b.type === 'tool_result');
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Past conversations of a project, newest first.
 * @returns {{id:string, title:string, startedAt:string|null, updatedAt:string, sizeKb:number}[]}
 */
function listSessions(cwd, { base = defaultBase(), limit = 200 } = {}) {
  const dir = projectDir(cwd, base);
  if (!dir) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const id = name.replace(/\.jsonl$/, '');
    if (!name.endsWith('.jsonl') || !ID.test(id)) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    let title = null;
    let startedAt = null;
    try {
      for (const o of parseLines(readHead(file))) {
        if (!startedAt && o.timestamp) startedAt = o.timestamp;
        if (o.type === 'custom-title' && o.customTitle) title = String(o.customTitle);
        if (!title) title = userText(o);
        if (title && startedAt) break;
      }
    } catch { continue; }
    if (!title) continue; // nothing was ever asked (a warmed-up process)
    out.push({ id, title: clip(title.replace(/\s+/g, ' '), 120), startedAt, updatedAt: st.mtime.toISOString(), sizeKb: Math.ceil(st.size / 1024) });
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out.slice(0, limit);
}

/**
 * The messages of one conversation. An assistant message has `text` (all its words) and `parts`
 * (text and tool calls in order, each tool with its result) so the screen can replay it.
 * @returns {{role:'user'|'assistant', text:string, at:string|null, parts?:object[]}[]|null} null when it doesn't exist
 */
function readSession(cwd, id, { base = defaultBase() } = {}) {
  if (!ID.test(String(id))) return null;
  const dir = projectDir(cwd, base);
  if (!dir) return null;
  const file = path.join(dir, `${id}.jsonl`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const msgs = [];
  const tools = new Map(); // tool_use id -> part, so a later tool_result can fill it in
  for (const o of parseLines(text)) {
    if (o.type === 'user' && !o.isSidechain && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        const part = b.type === 'tool_result' && tools.get(b.tool_use_id);
        if (part) part.result = { text: clip(resultText(b.content), MAX_RESULT), isError: !!b.is_error };
      }
    }
    const u = userText(o);
    if (u) { msgs.push({ role: 'user', text: clip(u, MAX_TEXT), at: o.timestamp || null }); continue; }
    const parts = assistantParts(o);
    if (!parts.length) continue;
    for (const p of parts) if (p.type === 'tool') tools.set(p.id, p);
    const a = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const last = msgs[msgs.length - 1];
    // one reply is stored as several lines (text, tool call, text …): join them
    if (last && last.role === 'assistant') {
      if (a) last.text = clip(`${last.text}\n\n${a}`.trim(), MAX_TEXT);
      last.parts.push(...parts);
    } else msgs.push({ role: 'assistant', text: clip(a, MAX_TEXT), parts, at: o.timestamp || null });
  }
  return msgs.slice(-MAX_MESSAGES);
}

module.exports = { listSessions, readSession, projectDir, cleanUserText, cleanAssistantText, encode };
