'use strict';
// Background projects report to the user by voice, and sum up what happened while the user was away.
// Pure (no Electron): main.js feeds it 'project:status' payloads and window focus changes.

const DONE_STATES = new Set(['done', 'error', 'awaiting-approval']);
const MIN_AWAY_MS = 3 * 60 * 1000;

const short = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

class AwayDigest {
  /** @param {{minAwayMs?: number}} [o] */
  constructor({ minAwayMs = MIN_AWAY_MS } = {}) {
    this.minAwayMs = minAwayMs;
    this.last = new Map(); // projectId -> last status seen, so a status that repeats is spoken once
    this.items = new Map(); // projectId -> what happened, until the user has seen it
    this.awaySince = null;
  }

  /**
   * A 'project:status' payload. Returns the line to speak, or null.
   * Spoken: a task finished, failed, or is waiting for a decision. Stopping is the user's own doing.
   */
  record(p, now = Date.now()) {
    if (!p || typeof p.projectId !== 'string') return null;
    const before = this.last.get(p.projectId);
    this.last.set(p.projectId, p.status);
    if (p.status === 'removed') {
      this.items.delete(p.projectId);
      this.last.delete(p.projectId);
      return null;
    }
    if (!DONE_STATES.has(p.status)) {
      if (p.status === 'running') this.items.delete(p.projectId); // new work: the old result no longer matters
      return null;
    }
    this.items.set(p.projectId, {
      projectId: p.projectId,
      name: String(p.name || ''),
      status: p.status,
      filesChanged: Number(p.filesChanged) || 0,
      branch: p.branch || null,
      error: p.status === 'error' ? short(p.error || p.lastText, 200) : '',
      at: now,
    });
    if (before === p.status) return null;
    const name = p.name || 'งานเบื้องหลัง';
    if (p.status === 'done') return `โปรเจกต์ ${name} เสร็จแล้วครับ${p.filesChanged ? ` แก้ ${p.filesChanged} ไฟล์` : ''}`;
    if (p.status === 'error') return `โปรเจกต์ ${name} ติดครับ ${short(p.error || p.lastText, 80)}`.trim();
    return `โปรเจกต์ ${name} รอให้คุณตัดสินใจครับ`;
  }

  /** The user left the window. */
  away(now = Date.now()) {
    if (this.awaySince == null) this.awaySince = now;
  }

  /** The user is back: a summary if they were gone long enough and something happened, else null. */
  back(now = Date.now()) {
    const since = this.awaySince;
    this.awaySince = null;
    if (since == null || now - since < this.minAwayMs || !this.items.size) return null;
    const items = [...this.items.values()];
    this.items.clear();
    const count = (s) => items.filter((i) => i.status === s).length;
    const d = { done: count('done'), error: count('error'), waiting: count('awaiting-approval'), awayMs: now - since, items };
    return { ...d, text: digestText(d) };
  }

  /** The user looked at the projects themselves. */
  seen() {
    this.items.clear();
  }
}

/** "ระหว่างที่คุณไม่อยู่ ทำเสร็จ 2 งาน ติด 1 งาน". */
function digestText({ done, error, waiting }) {
  const parts = [];
  if (done) parts.push(`ทำเสร็จ ${done} งาน`);
  if (error) parts.push(`ติด ${error} งาน`);
  if (waiting) parts.push(`รอคุณตัดสินใจ ${waiting} งาน`);
  return parts.length ? `ระหว่างที่คุณไม่อยู่ ${parts.join(' ')}` : '';
}

module.exports = { AwayDigest, digestText, MIN_AWAY_MS };
