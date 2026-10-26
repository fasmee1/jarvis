'use strict';
// The one edit list that mouse, voice and JARVIS all change. Source files are never touched.
// Every function is pure: it returns a new list. EditHistory adds undo/redo on top.
// A clip plays src[in..out] (seconds of the source) at `speed`; clips play back to back.

const MAX_CLIPS = 500;

class EditError extends Error {}

function emptyList(sources = []) { return { version: 1, sources: sources.map((s) => ({ ...s })), clips: [], nextId: 1 }; }

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
      const a = { ...c, out: mid };
      const b = { ...c, id: `c${list.nextId}`, in: mid };
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

module.exports = { EditError, emptyList, validate, clipLength, totalLength, addClip, splitAt, trim, remove, move, setSpeed, EditHistory };
