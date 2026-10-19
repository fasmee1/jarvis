// Main window → Floating Orb. Sends only what changed (coalesced), and the live
// mic / voice level at ~30 fps while the orb is on screen. Levels are polled on a
// timer, not animation frames, because the minimized window gets no frames.

const FLUSH_MS = 50;
const LEVEL_MS = 33;

export class OrbBridge {
  /** level(): current 0..1 level for the orb ring (mic while listening, voice while speaking). */
  constructor(api, { level }) {
    this.api = api;
    this.levelOf = level;
    this.cur = {};
    this.pending = {};
    this.timer = null;
    this.poll = null;
    this.visible = false;
  }

  set(partial) {
    for (const [k, v] of Object.entries(partial)) {
      if (this.cur[k] === v) continue;
      this.cur[k] = v;
      this.pending[k] = v;
    }
    if (!this.timer && Object.keys(this.pending).length) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    this.timer = null;
    const p = this.pending;
    this.pending = {};
    if (Object.keys(p).length) this.api.invoke('orb:sync', p).catch(() => {});
  }

  setVisible(on) {
    this.visible = on;
    clearInterval(this.poll);
    this.poll = null;
    if (!on) return;
    let last = -1;
    this.poll = setInterval(() => {
      const s = this.cur.state;
      if (s !== 'listening' && s !== 'speaking') { last = -1; return; }
      const v = Math.round(Math.max(0, Math.min(1, this.levelOf() || 0)) * 100) / 100;
      if (v === last) return;
      last = v;
      this.api.invoke('orb:level', v).catch(() => {});
    }, LEVEL_MS);
  }
}
