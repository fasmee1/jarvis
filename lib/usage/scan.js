'use strict';
// Token usage from Claude Code's own transcripts (~/.claude/projects/**/*.jsonl):
// every assistant reply line carries message.usage. Covers everything Claude Code
// did on this machine (JARVIS, the terminal, subagents), not just this app.
//
// Transcripts are append-only, so each file is read from where the last scan
// stopped (cache: offset + entries). One reply is written as several lines with
// the same message id → counted once (the last line has the final numbers).

const fs = require('fs');
const path = require('path');

const KEEP_MS = 8 * 24 * 3600 * 1000; // entries older than this are dropped

/** All *.jsonl under dir (subagent transcripts live in <session>/subagents/). */
function listJsonl(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** usage line → [ms, input, output, cacheWrite, cacheRead, model, key] or null */
function entryOf(o) {
  if (o.type !== 'assistant' || !o.message || !o.message.usage) return null;
  const u = o.message.usage;
  const ms = Date.parse(o.timestamp);
  if (!Number.isFinite(ms)) return null;
  const model = String(o.message.model || '');
  if (model === '<synthetic>') return null; // local error notes, not API calls
  const key = `${o.message.id || o.uuid}:${o.requestId || ''}`;
  return [ms, u.input_tokens || 0, u.output_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, model, key];
}

/** Read new bytes of one file (complete lines only) and fold them into its cache record. */
function scanFile(file, rec, now) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (rec && rec.size === st.size && rec.mtimeMs === st.mtimeMs) return rec;
  if (!rec || st.size < rec.offset) rec = { offset: 0, entries: [] }; // new or rewritten
  if (st.mtimeMs < now - KEEP_MS && rec.offset === 0) return { size: st.size, mtimeMs: st.mtimeMs, offset: st.size, entries: [] };
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const len = st.size - rec.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, rec.offset);
    const end = buf.lastIndexOf(0x0a) + 1; // a line still being written waits for the next scan
    text = buf.subarray(0, end).toString('utf8');
    rec.offset += end;
  } finally {
    fs.closeSync(fd);
  }
  const index = new Map(rec.entries.map((e, i) => [e[6], i]));
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const e = entryOf(o);
    if (!e) continue;
    const i = index.get(e[6]);
    if (i === undefined) { index.set(e[6], rec.entries.length); rec.entries.push(e); }
    else rec.entries[i] = e;
  }
  rec.entries = rec.entries.filter((e) => e[0] >= now - KEEP_MS);
  rec.size = st.size;
  rec.mtimeMs = st.mtimeMs;
  return rec;
}

/**
 * @param {string} base ~/.claude/projects
 * @param {object} cache {files: {path: rec}} from the previous scan
 * @returns {{cache: object, entries: any[][]}} entries deduplicated across files
 */
function scanAll(base, cache = { files: {} }, now = Date.now()) {
  const files = {};
  for (const f of listJsonl(base)) {
    const rec = scanFile(f, cache.files && cache.files[f], now);
    if (rec) files[f] = rec;
  }
  const seen = new Map();
  for (const rec of Object.values(files)) for (const e of rec.entries) seen.set(e[6], e); // resumed / forked sessions repeat old lines
  return { cache: { files }, entries: [...seen.values()] };
}

/**
 * Totals per window.
 * @param {any[][]} entries
 * @param {Record<string, number>} windows name → start (ms)
 */
function totals(entries, windows) {
  const out = {};
  for (const [name, since] of Object.entries(windows)) {
    const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, requests: 0, byModel: {} };
    for (const e of entries) {
      if (e[0] < since) continue;
      t.input += e[1];
      t.output += e[2];
      t.cacheWrite += e[3];
      t.cacheRead += e[4];
      t.requests += 1;
      const m = shortModel(e[5]);
      t.byModel[m] = (t.byModel[m] || 0) + e[1] + e[2] + e[3] + e[4];
    }
    t.total = t.input + t.output + t.cacheWrite + t.cacheRead;
    out[name] = t;
  }
  return out;
}

/** claude-opus-5-5-20261001 → Opus 5.5 */
function shortModel(id) {
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(id || '');
  if (!m) return id || 'อื่น ๆ';
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return m[3] && m[3].length <= 2 ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

module.exports = { scanAll, scanFile, totals, entryOf, shortModel, listJsonl, KEEP_MS };
