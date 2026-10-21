'use strict';
// Reminders: "remind me in 10 minutes" / "at 08:00". Stored in userData/reminders.json and fired by
// one timer aimed at the next due item. No Electron here: main.js passes `onDue` (notification + speech).

const fs = require('fs');
const path = require('path');

const MAX_REMINDERS = 50;
const MAX_TEXT = 200;
const MAX_DELAY = 2 ** 31 - 1; // setTimeout limit (~24.8 days): longer waits re-arm after this

/** "HH:MM" (+ optional "YYYY-MM-DD") as a local time: the next such moment after `now`. NaN when invalid. */
function timeToEpoch(time, date, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return NaN;
  const base = new Date(now);
  if (date) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date).trim());
    if (!d) return NaN;
    const t = new Date(+d[1], +d[2] - 1, +d[3], +m[1], +m[2], 0, 0).getTime();
    return t > now ? t : NaN; // an explicit date in the past is a mistake, not "tomorrow"
  }
  let t = new Date(base.getFullYear(), base.getMonth(), base.getDate(), +m[1], +m[2], 0, 0).getTime();
  if (t <= now) t += 24 * 3600 * 1000;
  return t;
}

class ReminderStore {
  /** @param {{dir?: string, onDue: (r: {id: string, text: string, late: boolean}) => void, now?: () => number}} o */
  constructor({ dir, onDue, now = Date.now } = {}) {
    this.file = dir ? path.join(dir, 'reminders.json') : null;
    this.onDue = onDue || (() => {});
    this.now = now;
    this.items = []; // [{id, text, at}] sorted by `at`
    this.timer = null;
    this.seq = 0;
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(data)) {
        this.items = data.filter((x) => x && typeof x.text === 'string' && Number.isFinite(x.at)).slice(0, MAX_REMINDERS);
      }
    } catch { /* missing or corrupt file: start empty */ }
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    } catch { /* read-only: keep it in memory */ }
  }

  list() {
    return this.items.map((x) => ({ ...x }));
  }

  /**
   * @param {{text: string, inSeconds?: number, time?: string, date?: string}} spec
   * @returns {object|null} the reminder, or null when the text or the time is unusable
   */
  add({ text, inSeconds, time, date } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!t || this.items.length >= MAX_REMINDERS) return null;
    const now = this.now();
    let at = NaN;
    if (Number.isFinite(inSeconds) && inSeconds > 0) at = now + Math.round(inSeconds * 1000);
    else if (time) at = timeToEpoch(time, date, now);
    if (!Number.isFinite(at)) return null;
    const r = { id: `r${now.toString(36)}${(this.seq++).toString(36)}`, text: t, at };
    this.items.push(r);
    this.items.sort((a, b) => a.at - b.at);
    this._save();
    this._arm();
    return { ...r };
  }

  /** Remove reminders whose text contains `query`. @returns {number} how many */
  cancel(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return 0;
    const before = this.items.length;
    this.items = this.items.filter((x) => !x.text.toLowerCase().includes(q));
    const n = before - this.items.length;
    if (n) {
      this._save();
      this._arm();
    }
    return n;
  }

  /** Apply a ```jarvis-reminder block. @returns {number} how many reminders were added */
  apply({ add = [], cancel = [] } = {}) {
    for (const q of cancel) this.cancel(q);
    let n = 0;
    for (const spec of add) if (this.add(spec)) n++;
    return n;
  }

  /** Fire what is overdue (a reminder that came due while the app was closed is `late`), then wait for the next. */
  start() {
    this._arm();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  _arm() {
    clearTimeout(this.timer);
    this.timer = null;
    const next = this.items[0];
    if (!next) return;
    const wait = next.at - this.now();
    if (wait <= 0) return this._fire();
    this.timer = setTimeout(() => this._arm(), Math.min(wait, MAX_DELAY));
    if (this.timer.unref) this.timer.unref();
  }

  _fire() {
    const now = this.now();
    const due = this.items.filter((x) => x.at <= now);
    if (!due.length) return;
    this.items = this.items.filter((x) => x.at > now);
    this._save();
    for (const r of due) {
      try {
        this.onDue({ id: r.id, text: r.text, late: now - r.at > 60 * 1000 });
      } catch { /* a failing notification must not stop the others */ }
    }
    this._arm();
  }
}

module.exports = { ReminderStore, timeToEpoch, MAX_REMINDERS, MAX_TEXT };
