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

function assistantText(o) {
  if (o.type !== 'assistant' || o.isSidechain || !o.message || !Array.isArray(o.message.content)) return null;
  const t = o.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return cleanAssistantText(t) || null;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

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
 * The messages of one conversation (text only: tool calls and screen blocks are summarised).
 * @returns {{role:'user'|'assistant', text:string, at:string|null}[]|null} null when it doesn't exist
 */
function readSession(cwd, id, { base = defaultBase() } = {}) {
  if (!ID.test(String(id))) return null;
  const dir = projectDir(cwd, base);
  if (!dir) return null;
  const file = path.join(dir, `${id}.jsonl`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const msgs = [];
  for (const o of parseLines(text)) {
    const u = userText(o);
    if (u) { msgs.push({ role: 'user', text: clip(u, MAX_TEXT), at: o.timestamp || null }); continue; }
    const a = assistantText(o);
    if (!a) continue;
    const last = msgs[msgs.length - 1];
    // one reply is stored as several lines (text, tool call, text …): join them
    if (last && last.role === 'assistant') last.text = clip(`${last.text}\n\n${a}`, MAX_TEXT);
    else msgs.push({ role: 'assistant', text: clip(a, MAX_TEXT), at: o.timestamp || null });
  }
  return msgs.slice(-MAX_MESSAGES);
}

module.exports = { listSessions, readSession, projectDir, cleanUserText, cleanAssistantText, encode };
