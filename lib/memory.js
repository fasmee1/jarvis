'use strict';
// Long-term voice memory: short facts the user asked JARVIS to remember (userData/memory.json).
// Kept small on purpose: it is sent to Claude as text, so every item costs tokens in every conversation.

const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 20;
const MAX_TEXT = 120; // characters per item
const MAX_RENDER = 900; // characters sent to Claude in total

class MemoryStore {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'memory.json') : null;
    this.items = [];
    this.version = 0; // bumps on every change, so a core can tell whether its conversation is out of date
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(data)) this.items = data.filter((x) => x && typeof x.text === 'string').slice(-MAX_ITEMS);
    } catch { /* missing or corrupt file: start empty */ }
  }

  _save() {
    this.version++;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    } catch { /* read-only: keep it in memory */ }
  }

  list() {
    return this.items.map((x) => x.text);
  }

  /** @returns {boolean} true when something was added */
  add(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!t || this.items.some((x) => x.text === t)) return false;
    this.items.push({ text: t, at: new Date().toISOString() });
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    this._save();
    return true;
  }

  /** Remove items containing `query` (case-insensitive). @returns {number} how many were removed */
  forget(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return 0;
    const before = this.items.length;
    this.items = this.items.filter((x) => !x.text.toLowerCase().includes(q));
    const n = before - this.items.length;
    if (n) this._save();
    return n;
  }

  /** Apply a ```jarvis-memory block. @returns {boolean} true when anything changed */
  apply({ add = [], forget = [] } = {}) {
    let changed = false;
    for (const q of forget) if (this.forget(q)) changed = true;
    for (const t of add) if (this.add(t)) changed = true;
    return changed;
  }

  /** The text sent to Claude: newest items first so the cap drops the oldest. '' when empty. */
  render() {
    let out = '';
    for (const x of [...this.items].reverse()) {
      const line = `- ${x.text}\n`;
      if (out.length + line.length > MAX_RENDER) break;
      out += line;
    }
    return out.trim();
  }
}

module.exports = { MemoryStore, MAX_ITEMS, MAX_TEXT, MAX_RENDER };
