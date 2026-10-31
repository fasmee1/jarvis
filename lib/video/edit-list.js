'use strict';
// The one edit list that mouse, voice and JARVIS all change. Source files are never touched.
// Every function is pure: it returns a new list. EditHistory adds undo/redo on top.
// A clip plays src[in..out] (seconds of the source) at `speed`; clips play back to back.

const { isFx, isFxOut, isSfx, isLibSfx } = require('./effects');
const { cleanGraphic, GraphicError } = require('./hf-graphics');

const MAX_CLIPS = 500;

class EditError extends Error {}

function emptyList(sources = []) { return { version: 1, sources: sources.map((s) => ({ ...s })), clips: [], nextId: 1, overlays: [], nextOverlay: 1 }; }

function clipLength(c) { return (c.out - c.in) / c.speed; }
function totalLength(list) { return list.clips.reduce((n, c) => n + clipLength(c), 0); }

function validate(list) {
  const errs = [];
  if (!list || list.version !== 1) return ['รูปแบบรายการไม่ถูกต้อง'];
  if (!Array.isArray(list.sources) || !Array.isArray(list.clips)) return ['รูปแบบรายการไม่ถูกต้อง'];
  if (list.clips.length > MAX_CLIPS) errs.push('คลิปมากเกินไป');
  const ids = new Set();
  const srcs = new Map(list.sources.map((s) => [s.id, s]));
  for (const c of list.clips) {
    if (ids.has(c.id)) errs.push(`รหัสคลิปซ้ำ ${c.id}`);
    ids.add(c.id);
    const s = srcs.get(c.src);
    if (!s) { errs.push(`คลิป ${c.id} อ้างไฟล์ที่ไม่มี`); continue; }
    if (![c.in, c.out, c.speed].every(Number.isFinite)) { errs.push(`คลิป ${c.id} มีค่าที่ไม่ใช่ตัวเลข`); continue; }
    if (c.in < 0 || c.out <= c.in) errs.push(`คลิป ${c.id} ช่วงเวลาไม่ถูกต้อง`);
    if (Number.isFinite(s.duration) && c.out > s.duration + 1e-6) errs.push(`คลิป ${c.id} เกินความยาวไฟล์`);
    if (c.speed < 0.25 || c.speed > 4) errs.push(`คลิป ${c.id} ความเร็วต้องอยู่ระหว่าง 0.25 ถึง 4`);
    if (c.fx !== undefined && !isFx(c.fx)) errs.push(`คลิป ${c.id} เอฟเฟกต์ภาพไม่รู้จัก`);
    if (c.fxOut !== undefined && !isFxOut(c.fxOut)) errs.push(`คลิป ${c.id} เอฟเฟกต์ตอนออกไม่รู้จัก`);
    if (c.sfx !== undefined && !isSfx(c.sfx)) errs.push(`คลิป ${c.id} เสียงเอฟเฟกต์ไม่รู้จัก`);
  }
  return errs;
}

function find(list, id) {
  const i = list.clips.findIndex((c) => c.id === id);
  if (i < 0) throw new EditError('ไม่พบคลิปนี้');
  return i;
}

function withClips(list, clips, nextId = list.nextId) { return { ...list, clips, nextId }; }

function addClip(list, { src, in: from, out, speed = 1 }, index = list.clips.length) {
  const clip = { id: `c${list.nextId}`, src, in: from, out, speed };
  const clips = list.clips.slice();
  clips.splice(Math.max(0, Math.min(index, clips.length)), 0, clip);
  const next = withClips(list, clips, list.nextId + 1);
  const errs = validate(next);
  if (errs.length) throw new EditError(errs[0]);
  return next;
}

/** Cuts a clip at a timeline time (seconds from the start of the whole cut). */
function splitAt(list, timelineSec) {
  let t = 0;
  for (let i = 0; i < list.clips.length; i++) {
    const c = list.clips[i];
    const len = clipLength(c);
    if (timelineSec > t + 1e-6 && timelineSec < t + len - 1e-6) {
      const mid = c.in + (timelineSec - t) * c.speed;
      const a = { ...c, out: mid, fxOut: 'none' }; // the way out belongs to the end of the clip: the second half keeps it
      const b = { ...c, id: `c${list.nextId}`, in: mid, fx: 'none', sfx: 'none', fxOut: c.fxOut || 'none' }; // a split is no cut: the second half comes in plain
      const clips = list.clips.slice();
      clips.splice(i, 1, a, b);
      return withClips(list, clips, list.nextId + 1);
    }
    t += len;
  }
  throw new EditError('ตำแหน่งนี้ตัดไม่ได้');
}

/** Moves the edges of a clip. Pass only the sides to change. */
function trim(list, id, { in: from, out } = {}) {
  const i = find(list, id);
  const c = { ...list.clips[i] };
  if (from !== undefined) c.in = from;
  if (out !== undefined) c.out = out;
  const clips = list.clips.slice();
  clips[i] = c;
  const next = withClips(list, clips);
  const errs = validate(next);
  if (errs.length) throw new EditError(errs[0]);
  return next;
}

/** Removes a clip; the ones after it slide up, so no gap is left. */
function remove(list, id) {
  const i = find(list, id);
  return withClips(list, list.clips.filter((_, k) => k !== i));
}

function move(list, id, toIndex) {
  const i = find(list, id);
  const clips = list.clips.slice();
  const [c] = clips.splice(i, 1);
  clips.splice(Math.max(0, Math.min(toIndex, clips.length)), 0, c);
  return withClips(list, clips);
}

function setSpeed(list, id, speed) {
  const i = find(list, id);
  const clips = list.clips.slice();
  clips[i] = { ...clips[i], speed };
  const next = withClips(list, clips);
  const errs = validate(next);
  if (errs.length) throw new EditError(errs[0]);
  return next;
}

/** Sets how a clip comes in. Pass only what changes: { fx, sfx }. */
function setFx(list, id, { fx, sfx, fxOut } = {}) {
  const i = find(list, id);
  const c = { ...list.clips[i] };
  if (fx !== undefined) c.fx = fx;
  if (sfx !== undefined) c.sfx = sfx;
  if (fxOut !== undefined) c.fxOut = fxOut;
  const clips = list.clips.slice();
  clips[i] = c;
  const next = withClips(list, clips);
  const errs = validate(next);
  if (errs.length) throw new EditError(errs[0]);
  return next;
}

/** The same effect on every cut: coming in on every clip but the first, going out on every clip but the last. */
function setFxAll(list, { fx, sfx, fxOut } = {}) {
  if (list.clips.length < 2) throw new EditError('ต้องมีอย่างน้อย 2 ช่วงถึงจะมีรอยต่อ');
  const last = list.clips.length - 1;
  const clips = list.clips.map((c, i) => {
    const n = { ...c };
    if (i > 0 && fx !== undefined) n.fx = fx;
    if (i > 0 && sfx !== undefined) n.sfx = sfx;
    if (i < last && fxOut !== undefined) n.fxOut = fxOut; // the last clip has no cut after it
    return n;
  });
  const next = withClips(list, clips);
  const errs = validate(next);
  if (errs.length) throw new EditError(errs[0]);
  return next;
}

// ---- animations laid over the picture (title, name tag, counting number) ----
// They sit on the timeline by time (seconds from the start of the whole cut), not on a clip.
// 'hf': a graphic designed for HyperFrames (markup + css + tweens as data, see hf-graphics.js)
const OVERLAY_KINDS = Object.freeze(['title', 'lower', 'counter', 'hf']);
const MAX_OVERLAYS = 50;
const OVERLAY_TEXT_MAX = 60;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** A checked, complete overlay from loose fields (throws EditError in Thai). */
function cleanOverlay(o) {
  if (!OVERLAY_KINDS.includes(o.kind)) throw new EditError('ชนิดอนิเมชั่นไม่ถูกต้อง');
  if (o.kind === 'hf') return cleanHf(o);
  const text = String(o.text == null ? '' : o.text).replace(/\s+/g, ' ').trim();
  const text2 = String(o.text2 == null ? '' : o.text2).replace(/\s+/g, ' ').trim();
  const suffix = String(o.suffix == null ? '' : o.suffix).replace(/\s+/g, ' ').trim();
  if (text.length > OVERLAY_TEXT_MAX || text2.length > OVERLAY_TEXT_MAX) throw new EditError(`ข้อความยาวเกินไป (ไม่เกิน ${OVERLAY_TEXT_MAX} ตัวอักษร)`);
  if (suffix.length > 6) throw new EditError('ท้ายตัวเลขยาวเกินไป (ไม่เกิน 6 ตัวอักษร)');
  if (o.kind !== 'counter' && !text) throw new EditError('ข้อความอนิเมชั่นว่างไม่ได้');
  let from = 0;
  let to = 0;
  if (o.kind === 'counter') {
    from = o.from === undefined ? 0 : o.from;
    to = o.to;
    if (!finite(from) || !finite(to) || Math.abs(from) > 1e9 || Math.abs(to) > 1e9) throw new EditError('ตัวเลขต้องเป็นตัวเลขไม่เกินพันล้าน');
  }
  if (!finite(o.start) || !finite(o.end) || o.start < 0) throw new EditError('เวลาอนิเมชั่นไม่ถูกต้อง');
  if (o.end - o.start < 0.5) throw new EditError('อนิเมชั่นต้องอยู่บนจออย่างน้อย 0.5 วินาที');
  if (o.end - o.start > 30) throw new EditError('อนิเมชั่นอยู่บนจอได้ไม่เกิน 30 วินาที');
  const sfx = o.sfx === undefined ? 'none' : o.sfx;
  if (!isSfx(sfx)) throw new EditError('เสียงเอฟเฟกต์ไม่รู้จัก');
  const r = (x) => Math.round(x * 1000) / 1000;
  return { kind: o.kind, sfx, text, text2: o.kind === 'lower' ? text2 : '', from, to, suffix: o.kind === 'counter' ? suffix : '', start: r(o.start), end: r(o.end) };
}

function cleanHf(o) {
  if (!finite(o.start) || !finite(o.end) || o.start < 0) throw new EditError('เวลากราฟิกไม่ถูกต้อง');
  if (o.end - o.start < 0.5) throw new EditError('กราฟิกต้องอยู่บนจออย่างน้อย 0.5 วินาที');
  if (o.end - o.start > 30) throw new EditError('กราฟิกอยู่บนจอได้ไม่เกิน 30 วินาที');
  const sfx = o.sfx === undefined ? 'none' : o.sfx;
  if (!isSfx(sfx)) throw new EditError('เสียงเอฟเฟกต์ไม่รู้จัก');
  let g;
  try {
    g = cleanGraphic(o, o.end - o.start);
  } catch (err) {
    if (err instanceof GraphicError) throw new EditError(err.message);
    throw err;
  }
  const r = (x) => Math.round(x * 1000) / 1000;
  return { kind: 'hf', sfx, text: g.name, ...g, start: r(o.start), end: r(o.end) };
}

/** New values for a graphic's variables: { id: value }; other variables keep theirs. */
function setOverlayVars(list, id, values) {
  const o = (list.overlays || []).find((x) => x.id === id);
  if (!o || o.kind !== 'hf') throw new EditError('ไม่พบกราฟิกนี้');
  const vars = o.vars.map((v) => (typeof values[v.id] === 'string' ? { ...v, value: values[v.id] } : v));
  return updateOverlay(list, id, { vars });
}

function addOverlay(list, o) {
  const overlays = list.overlays || [];
  if (overlays.length >= MAX_OVERLAYS) throw new EditError('อนิเมชั่นมากเกินไป');
  const n = list.nextOverlay || 1;
  return { ...list, overlays: [...overlays, { id: `o${n}`, ...cleanOverlay(o) }], nextOverlay: n + 1 };
}

function updateOverlay(list, id, patch) {
  const overlays = list.overlays || [];
  const i = overlays.findIndex((x) => x.id === id);
  if (i < 0) throw new EditError('ไม่พบอนิเมชั่นนี้');
  const next = overlays.slice();
  next[i] = { id, ...cleanOverlay({ ...overlays[i], ...patch }) };
  return { ...list, overlays: next };
}

function removeOverlay(list, id) {
  const overlays = list.overlays || [];
  if (!overlays.some((x) => x.id === id)) throw new EditError('ไม่พบอนิเมชั่นนี้');
  return { ...list, overlays: overlays.filter((x) => x.id !== id) };
}

const MIN_CLIP = 0.1; // shortest piece (seconds of source) a trim may leave

/**
 * One edit from the mouse, the voice or JARVIS, as plain data (validated by the caller):
 *   { op: 'split', at } · { op: 'trim', id, in?, out? } · { op: 'remove', id }
 *   { op: 'move', id, to } · { op: 'speed', id, speed }
 */
function applyOp(list, o) {
  switch (o.op) {
    case 'split': return splitAt(list, o.at);
    case 'trim': {
      const c = list.clips[find(list, o.id)];
      const from = o.in !== undefined ? o.in : c.in;
      const out = o.out !== undefined ? o.out : c.out;
      if (out - from < MIN_CLIP - 1e-9) throw new EditError('สั้นเกินไป — คลิปต้องยาวอย่างน้อย 0.1 วินาที');
      return trim(list, o.id, { in: from, out });
    }
    case 'remove': return remove(list, o.id);
    case 'move': return move(list, o.id, o.to);
    case 'speed': return setSpeed(list, o.id, o.speed);
    case 'overlay-add': return addOverlay(list, o.overlay);
    case 'overlay-update': return updateOverlay(list, o.id, o.overlay);
    case 'overlay-remove': return removeOverlay(list, o.id);
    case 'overlay-vars': return setOverlayVars(list, o.id, o.values || {});
    case 'fx': return setFx(list, o.id, { fx: o.fx, sfx: o.sfx, fxOut: o.fxOut });
    case 'fx-all': return setFxAll(list, { fx: o.fx, sfx: o.sfx, fxOut: o.fxOut });
    default: throw new EditError('คำสั่งตัดต่อนี้ไม่รู้จัก');
  }
}

/** Snapshot history: undo and redo restore whole lists, which stay small. */
class EditHistory {
  constructor(list = emptyList()) { this.now = list; this.past = []; this.future = []; }
  get list() { return this.now; }
  apply(fn, ...args) {
    const next = fn(this.now, ...args); // throws EditError and leaves the history as it was
    this.past.push(this.now);
    if (this.past.length > 200) this.past.shift();
    this.now = next;
    this.future = [];
    return next;
  }
  undo() { if (!this.past.length) return null; this.future.push(this.now); this.now = this.past.pop(); return this.now; }
  redo() { if (!this.future.length) return null; this.past.push(this.now); this.now = this.future.pop(); return this.now; }
}

module.exports = { EditError, emptyList, validate, clipLength, totalLength, addClip, splitAt, trim, remove, move, setSpeed, setFx, setFxAll, addOverlay, updateOverlay, removeOverlay, cleanOverlay, OVERLAY_KINDS, applyOp, MIN_CLIP, EditHistory };
