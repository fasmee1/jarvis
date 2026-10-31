'use strict';
// The editing skills the user picks from: the four built-ins (editable, can be reset)
// plus skills the user uploads (SKILL.md, see skills.js) or writes. Saved in userData/video/styles.json.
// Input comes from the renderer, so every field is checked here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PACES, BUILTIN_STYLES, builtin } = require('./presets');
const { MAX_SKILL } = require('./skills');

const MAX_NAME = 40;
const MAX_PROMPT = MAX_SKILL;
const MAX_CUSTOM = 50;
const MAX_TARGET_SEC = 600;

class StyleError extends Error {}

/** Checks and trims the editable fields; throws a Thai message on bad input. */
function cleanStyle(input) {
  if (!input || typeof input !== 'object') throw new StyleError('ข้อมูลสกิลไม่ถูกต้อง');
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.replace(/\r\n?/g, '\n').trim() : '';
  if (!name) throw new StyleError('ใส่ชื่อสกิลก่อน');
  if (name.length > MAX_NAME) throw new StyleError(`ชื่อสกิลยาวได้ไม่เกิน ${MAX_NAME} ตัวอักษร`);
  if (!prompt) throw new StyleError('ใส่คำแนะนำของสกิลก่อน — JARVIS ใช้ข้อความนี้ตัดต่อ');
  if (prompt.length > MAX_PROMPT) throw new StyleError(`คำแนะนำยาวได้ไม่เกิน ${MAX_PROMPT.toLocaleString()} ตัวอักษร`);
  if (!Object.prototype.hasOwnProperty.call(PACES, input.pace)) throw new StyleError('เลือกจังหวะ เร็ว ปานกลาง หรือ ช้า');
  const targetSec = Number(input.targetSec === undefined || input.targetSec === '' ? 0 : input.targetSec);
  if (!Number.isInteger(targetSec) || targetSec < 0 || targetSec > MAX_TARGET_SEC) {
    throw new StyleError(`ความยาวเป้าหมายต้องเป็นวินาที 0–${MAX_TARGET_SEC} (0 = ไม่จำกัด)`);
  }
  const description = typeof input.description === 'string' ? input.description.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { name, prompt, pace: input.pace, targetSec, description, skill: input.skill === true };
}

class StyleStore {
  constructor({ file }) {
    this.file = file;
    this.data = this._load();
  }

  _load() {
    const empty = { version: 1, custom: [], overrides: {}, last: 'viral' };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return empty;
    }
    const out = { ...empty };
    // keep only entries that still pass the checks (the file may have been edited by hand)
    for (const c of Array.isArray(raw.custom) ? raw.custom.slice(0, MAX_CUSTOM) : []) {
      try {
        if (typeof c.id === 'string' && /^u[0-9a-f]{8}$/.test(c.id)) out.custom.push({ id: c.id, ...cleanStyle(c) });
      } catch { /* dropped */ }
    }
    for (const [id, o] of Object.entries(raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {})) {
      try {
        if (builtin(id)) out.overrides[id] = cleanStyle(o);
      } catch { /* dropped */ }
    }
    if (typeof raw.last === 'string') out.last = raw.last;
    return out;
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Built-ins first (with the user's edits), then the user's own styles. */
  list() {
    const built = BUILTIN_STYLES.map((b) => {
      const o = this.data.overrides[b.id];
      return { id: b.id, ...(o || { name: b.name, prompt: b.prompt, pace: b.pace, targetSec: b.targetSec }), builtin: true, edited: !!o };
    });
    const own = this.data.custom.map((c) => ({ ...c, builtin: false, edited: false }));
    return [...built, ...own];
  }

  get(id) {
    return this.list().find((s) => s.id === id) || null;
  }

  /** The style picked last time (falls back to the first one). */
  last() {
    return this.get(this.data.last) || this.list()[0];
  }

  setLast(id) {
    if (!this.get(id)) throw new StyleError('ไม่พบสกิลนี้');
    if (this.data.last !== id) {
      this.data.last = id;
      this._save();
    }
    return this.get(id);
  }

  /** Adds a style (no id) or changes one (built-in or own). Returns the saved style. */
  save(input) {
    const fields = cleanStyle(input);
    const id = input.id;
    if (id === undefined || id === null || id === '') {
      if (this.data.custom.length >= MAX_CUSTOM) throw new StyleError(`เพิ่มสกิลได้ไม่เกิน ${MAX_CUSTOM} สกิล`);
      const style = { id: `u${crypto.randomBytes(4).toString('hex')}`, ...fields };
      this.data.custom.push(style);
      this._save();
      return this.get(style.id);
    }
    if (builtin(id)) {
      this.data.overrides[id] = fields;
      this._save();
      return this.get(id);
    }
    const i = this.data.custom.findIndex((c) => c.id === id);
    if (i < 0) throw new StyleError('ไม่พบสกิลนี้');
    this.data.custom[i] = { id, ...fields, skill: fields.skill || this.data.custom[i].skill === true, description: fields.description || this.data.custom[i].description || '' };
    this._save();
    return this.get(id);
  }

  /** Adds an uploaded skill; one with the same name is replaced (uploading a newer version). */
  importSkill(skill) {
    const same = this.data.custom.find((c) => c.skill && c.name === skill.name);
    return this.save({ ...skill, skill: true, id: same ? same.id : undefined });
  }

  /** Deletes one of the user's styles. Built-ins can only be reset. */
  remove(id) {
    if (builtin(id)) throw new StyleError('สกิลสำเร็จรูปลบไม่ได้ แต่คืนค่าเดิมได้');
    const i = this.data.custom.findIndex((c) => c.id === id);
    if (i < 0) throw new StyleError('ไม่พบสกิลนี้');
    this.data.custom.splice(i, 1);
    if (this.data.last === id) this.data.last = 'viral';
    this._save();
    return { ok: true };
  }

  /** Puts a built-in back to how it came. */
  reset(id) {
    if (!builtin(id)) throw new StyleError('คืนค่าเดิมได้เฉพาะสกิลสำเร็จรูป');
    delete this.data.overrides[id];
    this._save();
    return this.get(id);
  }
}

module.exports = { StyleStore, StyleError, cleanStyle, MAX_NAME, MAX_PROMPT, MAX_CUSTOM, MAX_TARGET_SEC };
