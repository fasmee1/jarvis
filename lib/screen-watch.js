'use strict';
// Screen watching: keep an eye on the whole screen or one window, remember only the latest frame
// that actually changed (in memory, never on disk), and hand it over when the user asks.
// Nothing is sent to Claude from here. The caller decides when a frame is used.
// No Electron: main.js passes `grab(target)` that returns { dataUrl, thumb }.

const THUMB_W = 32;
const THUMB_H = 18;
const CELL_DELTA = 16; // brightness change (0..255) for a thumbnail cell to count as changed
const CHANGED_CELLS = 0.02; // share of changed cells that counts as "the picture changed"
const MAX_ERRORS = 3;

// Spoken window kinds -> title patterns. Anything else is matched as words in the title.
const WINDOW_CLASSES = {
  terminal: /terminal|powershell|command prompt|cmd\.exe|\bbash\b|\bwsl\b|ubuntu|mintty|konsole/i,
  browser: /chrome|edge|firefox|brave|opera|safari/i,
  editor: /visual studio code|\bcode\b|cursor|sublime|notepad\+\+|intellij|webstorm|pycharm|vim/i,
  arduino: /arduino/i,
};

/** BGRA bitmap (as from nativeImage.toBitmap) -> brightness cells. */
function grayThumb(bgra, w = THUMB_W, h = THUMB_H) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = (bgra[o + 2] * 77 + bgra[o + 1] * 150 + bgra[o] * 29) >> 8;
  }
  return out;
}

/** Did the picture change between two thumbnails? A blinking cursor or clock tick does not count. */
function changed(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > CELL_DELTA) n++;
  return n / a.length > CHANGED_CELLS;
}

/**
 * Windows whose title fits the spoken hint ("terminal", "chrome", "arduino ide").
 * @param {{id: string, name: string}[]} windows
 * @returns {{id: string, name: string}[]}
 */
function matchWindows(windows, hint) {
  const h = String(hint || '').trim().toLowerCase();
  if (!h) return [];
  const cls = WINDOW_CLASSES[h];
  if (cls) return windows.filter((w) => cls.test(w.name));
  const words = h.split(/\s+/).filter(Boolean);
  return windows.filter((w) => {
    const n = w.name.toLowerCase();
    return words.every((x) => n.includes(x));
  });
}

class ScreenWatcher {
  /**
   * @param {{grab: (target: object) => Promise<{dataUrl: string, thumb: Uint8Array}>,
   *   onState?: (s: object) => void, now?: () => number,
   *   setTimer?: Function, clearTimer?: Function}} o
   */
  constructor({ grab, onState = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.grab = grab;
    this.onState = onState;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this._reset();
  }

  _reset() {
    this.on = false;
    this.target = null; // { kind: 'screen' | 'window', id?, name?, displayId? }
    this.frame = null; // { dataUrl, at } the latest changed picture
    this.thumb = null;
    this.checkedAt = 0;
    this.changedAt = 0;
    this.expiresAt = 0;
    this.intervalMs = 0;
    this.errors = 0;
    this.timer = null;
    this.gen = 0;
  }

  get state() {
    return {
      on: this.on,
      target: this.target ? { kind: this.target.kind, name: this.target.name || '' } : null,
      changedAt: this.changedAt,
      expiresAt: this.expiresAt,
    };
  }

  /** Start (or retarget) watching. Resolves after the first frame so the caller knows it works. */
  async start(target, { intervalMs = 5000, maxMs = 600000 } = {}) {
    this.stop('restart', { silent: true });
    this.on = true;
    this.target = target;
    this.intervalMs = Math.max(1000, intervalMs);
    this.expiresAt = this.now() + Math.max(this.intervalMs, maxMs);
    const gen = ++this.gen;
    await this._tick(gen, true);
    if (this.on && this.gen === gen) this.onState(this.state);
    return this.state;
  }

  stop(reason = 'manual', { silent = false } = {}) {
    const was = this.on;
    if (this.timer) this.clearTimer(this.timer);
    const gen = this.gen;
    this._reset();
    this.gen = gen + 1; // a tick in flight sees the new generation and drops its result
    if (was && !silent) this.onState({ ...this.state, reason });
    return was;
  }

  /** The latest changed frame, only while checks are still running (so it still shows what is on screen). */
  latest() {
    if (!this.on || !this.frame) return null;
    if (this.now() - this.checkedAt > this.intervalMs * 3) return null;
    return this.frame;
  }

  async _tick(gen, first = false) {
    if (!this.on || this.gen !== gen) return;
    if (this.now() >= this.expiresAt) {
      this.stop('timeout');
      return;
    }
    try {
      const f = await this.grab(this.target);
      if (!this.on || this.gen !== gen) return;
      this.errors = 0;
      this.checkedAt = this.now();
      if (changed(this.thumb, f.thumb)) {
        this.thumb = f.thumb;
        this.frame = { dataUrl: f.dataUrl, at: this.checkedAt };
        this.changedAt = this.checkedAt;
        if (!first) this.onState(this.state);
      }
    } catch (err) {
      if (!this.on || this.gen !== gen) return;
      this.errors++;
      if (first || this.errors >= MAX_ERRORS) {
        this.stop('error', { silent: first });
        if (first) throw err;
        return;
      }
    }
    this.timer = this.setTimer(() => this._tick(gen), this.intervalMs);
    if (this.timer && this.timer.unref) this.timer.unref();
  }
}

module.exports = { ScreenWatcher, matchWindows, grayThumb, changed, THUMB_W, THUMB_H };
