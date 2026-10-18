// The reactor — a calm, precise instrument drawn on Canvas 2D.
// Hairline rings, one slowly rotating accent arc, a ring of 60 thin radial
// lines that light up with the real mic / voice level or activity, connector
// nodes, and a small flat logo with one soft glow that breathes slowly.
// Every moving value is driven by a real signal fed in through setSignals().

const TAU = Math.PI * 2;
const D = 720; // design size of the core box
const C = D / 2;
const R = {
  outer: 292, // hairline under the tick ring (ticks.js)
  node: 276, // connector nodes sit on this hairline
  arc: 250, // the one accent arc
  linesOut: 206, linesIn: 196, // 60 radial lines, 10px long
  inner: 150, // inner hairline
  mic: 44, // thin orange arc around the logo while the mic is live
};
const LINES = 60;

const PAL = {
  accent: [91, 225, 240],
  white: [230, 237, 243],
  orange: [255, 154, 61],
  red: [255, 92, 108],
};
// Boot parameters (tweened by ui/boot.js). FULL = normal operation.
const FULL = { rings: 1, arc: 1, lines: null, nodes: 99, order: [], logo: 1 };
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const deg = (d) => ((d - 90) * Math.PI) / 180; // 0° at 12 o'clock, clockwise

export class Core {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'STANDBY';
    this.prevState = 'STANDBY';
    this.stateAt = performance.now();
    this.blend = 1; // 0→1 after a state change
    this.rot = 0; // accent arc angle
    this.sweep = 0; // indeterminate sweep head (0..1)
    this.arcLen = 70; // degrees, smoothed
    this.level = 0; // smoothed real level (mic / tts)
    this.bands = null;
    this.progress = null; // 0..1 real progress (e.g. spoken / total segments)
    this.activity = 0; // stream activity, decays
    this.nodes = []; // [{deg, flashAt, holdAt, dock}]
    this.quality = 'high';
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.err = 0;
    this.mini = false;
    this.lineRipples = [];
  }

  resize(scale) {
    const dpr = window.devicePixelRatio || 1;
    this.k = scale * dpr;
    const px = Math.round(D * this.k);
    this.canvas.width = px;
    this.canvas.height = px;
  }

  /** Enter boot mode with every element off. */
  beginBoot(order) {
    this.boot = { rings: 0, arc: 0, lines: 0, nodes: 0, order, logo: 0 };
    return this.boot;
  }

  endBoot() {
    this.boot = null;
  }

  setNodes(list) {
    const prev = new Map(this.nodes.map((n) => [n.deg, n.dock]));
    this.nodes = list.map((d) => ({ deg: d, flashAt: -1e9, holdAt: -1e9, dock: prev.get(d) || 0 }));
  }

  /** Docked look for a node: 0 = normal, 1 = accent dot + thin ring. */
  setDocked(d, v) {
    const n = this.nodes.find((x) => x.deg === d);
    if (n) n.dock = v;
  }

  /** A soft brightness wave around the line ring, starting at angle d (deg). */
  ripple(d) {
    this.lineRipples.push({ t: performance.now(), a: d });
  }

  /** One soft pulse on a node (value changed, card docked). */
  flashNode(d) {
    const n = this.nodes.find((x) => x.deg === d);
    if (n) n.flashAt = performance.now();
  }

  /** Keep a node in its active (accent) look this frame — hover, live camera. */
  holdNode(d) {
    const n = this.nodes.find((x) => x.deg === d);
    if (n) n.holdAt = performance.now();
  }

  setState(s) {
    if (s === this.state) return;
    this.prevState = this.state;
    this.state = s;
    this.stateAt = performance.now();
    this.blend = 0;
  }

  /** Real signals: level 0..1, bands (Float32Array 0..1), progress 0..1|null */
  setSignals({ level, bands, progress }) {
    if (level != null) this.level += (level - this.level) * 0.35;
    if (bands) this.bands = bands;
    if (progress !== undefined) this.progress = progress;
  }

  pulseActivity() {
    this.activity = Math.min(1, this.activity + 0.25);
  }

  frame(now, dt) {
    const s = this.state;
    this.blend = Math.min(1, this.blend + dt / 0.5);
    this.activity *= Math.pow(0.25, dt);
    if (s !== 'LISTENING' && s !== 'SPEAKING') this.level *= Math.pow(0.08, dt);
    this.err += ((s === 'ERROR' ? 1 : 0) - this.err) * Math.min(1, dt * 4);
    this.mini = !!(this.canvas.parentElement && this.canvas.parentElement.classList.contains('mini'));

    // the accent arc turns slowly; a little faster while working, still in ERROR
    const sp = {
      STANDBY: 1, LISTENING: 1.5, TRANSCRIBING: 3, THINKING: 3, STREAMING: 2,
      SPEAKING: 1.5, TOOL_RUNNING: 3, AWAITING_APPROVAL: 0.5, ERROR: 0,
    }[s] ?? 1;
    if (!this.reduced) this.rot += dt * sp * (TAU / 40);
    if (!this.reduced) this.sweep = (this.sweep + dt / 1.6) % 1;
    const target = this.progress != null && (s === 'STREAMING' || s === 'SPEAKING' || s === 'STANDBY')
      ? Math.max(6, this.progress * 360)
      : 70;
    this.arcLen += (target - this.arcLen) * Math.min(1, dt * 4);
    this._draw(now);
  }

  // ---------- drawing ----------
  _ring(ctx, r, color, frac = 1) {
    if (frac <= 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, frac) * TAU);
    ctx.stroke();
  }

  _draw(now) {
    const ctx = this.canvas.getContext('2d');
    const k = this.k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, C * k, C * k);
    const s = this.state;
    const e = this.err;
    const B = this.boot || FULL;
    const accent = mix(PAL.accent, PAL.red, e * 0.9);
    const W = PAL.white;

    // ---- hairline rings ----
    this._ring(ctx, R.outer, rgba(W, 0.12), B.rings);
    this._ring(ctx, R.node, rgba(W, 0.1), B.rings);
    this._ring(ctx, R.inner, rgba(W, 0.1), B.rings);

    // ---- the accent arc ----
    if (B.arc > 0) {
      const len = (this.arcLen * Math.PI) / 180 * B.arc;
      const a0 = -Math.PI / 2 + this.rot;
      ctx.strokeStyle = rgba(accent, 0.9);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, R.arc, a0, a0 + len);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // ---- 60 radial lines ----
    if (!this.mini) {
      const lit = this._litLines(now);
      const ripples = this.lineRipples.filter((r) => now - r.t < 700);
      this.lineRipples = ripples;
      const shown = B.lines == null ? LINES : Math.min(LINES, B.lines);
      ctx.lineWidth = 1.5;
      for (let i = 0; i < shown; i++) {
        const a = deg((i / LINES) * 360);
        let v = lit[i];
        for (const r of ripples) {
          const p = (now - r.t) / 700;
          const bd = ((((i / LINES) * 360 - r.a) % 360) + 540) % 360 - 180;
          const q = (Math.abs(bd) - p * 180) / 24;
          v = Math.max(v, Math.exp(-q * q) * (1 - p) * 0.8);
        }
        ctx.strokeStyle = v > 0.02 ? rgba(accent, 0.25 + 0.75 * v) : rgba(W, 0.08);
        const c = Math.cos(a);
        const sn = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(c * R.linesIn, sn * R.linesIn);
        ctx.lineTo(c * R.linesOut, sn * R.linesOut);
        ctx.stroke();
      }
    }

    // ---- connector nodes: 6px dots; accent when active / docked ----
    for (const n of this.nodes) {
      if (this.boot) {
        const idx = B.order.indexOf(n.deg);
        if (idx < 0 || idx >= B.nodes) continue;
      }
      const a = deg(n.deg);
      const x = Math.cos(a) * R.node;
      const y = Math.sin(a) * R.node;
      const pulse = Math.max(0, 1 - (now - n.flashAt) / 700);
      const held = now - n.holdAt < 120;
      const act = Math.max(n.dock || 0, held ? 1 : 0, pulse);
      ctx.fillStyle = act > 0 ? rgba(mix(W, accent, act), 0.3 + 0.7 * act) : rgba(W, 0.3);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, TAU);
      ctx.fill();
      if (n.dock > 0) {
        ctx.strokeStyle = rgba(accent, 0.7 * n.dock);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, TAU);
        ctx.stroke();
      }
      if (pulse > 0) {
        // single soft pulse: a ring expands and fades
        ctx.strokeStyle = rgba(accent, 0.5 * pulse);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 4 + (1 - pulse) * 10, 0, TAU);
        ctx.stroke();
      }
    }

    // ---- logo: flat accent, one soft glow, slow breathing (0.85 → 1, 4 s) ----
    if (B.logo > 0) {
      const breathe = this.reduced ? 1 : 0.85 + 0.15 * (0.5 + 0.5 * Math.sin((now / 4000) * TAU));
      ctx.save();
      const sc = 0.98 + 0.02 * B.logo;
      ctx.scale(sc, sc);
      ctx.globalAlpha = breathe * B.logo;
      this._logo(ctx, accent, k);
      ctx.restore();
    }

    // ---- mic live: one thin orange arc around the logo (span follows the level) ----
    if (s === 'LISTENING') {
      const span = ((60 + Math.min(1, this.level * 1.4) * 200) * Math.PI) / 180 * this.blend;
      ctx.strokeStyle = rgba(PAL.orange, 0.9);
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, R.mic, -Math.PI / 2 - span / 2, -Math.PI / 2 + span / 2);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }

  /** Lit amount per radial line (0..1) from the real level / progress, or a soft sweep while working. */
  _litLines(now) {
    const s = this.state;
    const out = new Float32Array(LINES);
    if (s === 'TRANSCRIBING' || s === 'TOOL_RUNNING' || s === 'THINKING') {
      const head = this.sweep * LINES;
      for (let i = 0; i < LINES; i++) {
        const d = (head - i + LINES) % LINES;
        out[i] = d < 12 ? Math.pow(1 - d / 12, 2) * 0.8 : 0;
      }
      return out;
    }
    let n = 0;
    if (s === 'LISTENING' || s === 'SPEAKING') n = Math.min(1, this.level * 1.15) * LINES;
    else if (s === 'STREAMING' && this.progress != null) n = this.progress * LINES;
    for (let i = 0; i < LINES; i++) {
      if (i < Math.floor(n)) out[i] = 1;
      else if (i < n) out[i] = n - i;
    }
    return out;
  }

  /** The emblem: a flat diamond with a W cutout, ~60% of the old size, one soft glow. */
  _logo(ctx, accent, k) {
    const sz = 26;
    const diamond = () => {
      ctx.beginPath();
      ctx.moveTo(0, -sz);
      ctx.lineTo(sz, 0);
      ctx.lineTo(0, sz);
      ctx.lineTo(-sz, 0);
      ctx.closePath();
    };
    ctx.save();
    if (this.quality === 'high') {
      ctx.shadowColor = rgba(accent, 0.3);
      ctx.shadowBlur = 16 * k;
    }
    ctx.fillStyle = rgba(accent, 1);
    diamond();
    ctx.fill();
    ctx.restore();
    // W cutout + top notch, punched out of the diamond
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = sz * 0.16;
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.moveTo(-sz * 0.6, -sz * 0.08);
    ctx.lineTo(-sz * 0.3, sz * 0.38);
    ctx.lineTo(0, sz * 0.02);
    ctx.lineTo(sz * 0.3, sz * 0.38);
    ctx.lineTo(sz * 0.6, -sz * 0.08);
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.moveTo(0, -sz * 0.6);
    ctx.lineTo(sz * 0.15, -sz * 0.4);
    ctx.lineTo(0, -sz * 0.2);
    ctx.lineTo(-sz * 0.15, -sz * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
