'use strict';
// Counts what the online TTS providers were asked to speak, per day and per
// month, in userData/tts-usage.json. The counts are our own bookkeeping, not the
// provider's: the provider's dashboard stays the source of truth for quota.

const fs = require('fs');
const path = require('path');

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const empty = () => ({ requests: 0, chars: 0 });

class TtsUsage {
  /** now: injectable clock for tests, returns a Date */
  constructor({ file, now = () => new Date() }) {
    this.file = file;
    this.now = now;
    this.data = {};
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) this.data = saved;
    } catch { /* first run or unreadable: start from zero */ }
  }

  _slot(provider) {
    const d = this.now();
    const cur = this.data[provider] || {};
    const day = dayKey(d);
    const month = monthKey(d);
    // A new day / month starts from zero; older periods are dropped.
    return {
      day,
      month,
      dayUse: cur.day === day ? { ...empty(), ...cur.dayUse } : empty(),
      monthUse: cur.month === month ? { ...empty(), ...cur.monthUse } : empty(),
    };
  }

  /** Add one successful request of `chars` characters. */
  record(provider, chars) {
    const s = this._slot(provider);
    const n = Math.max(0, Math.floor(chars) || 0);
    s.dayUse.requests++;
    s.dayUse.chars += n;
    s.monthUse.requests++;
    s.monthUse.chars += n;
    this.data[provider] = { day: s.day, dayUse: s.dayUse, month: s.month, monthUse: s.monthUse };
    this._save();
  }

  /** { day: {requests, chars}, month: {requests, chars} } for the current day / month. */
  snapshot(provider) {
    const s = this._slot(provider);
    return { day: s.dayUse, month: s.monthUse };
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
    } catch { /* a counter that can't be saved must never break speech */ }
  }
}

module.exports = { TtsUsage };
