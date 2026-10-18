// The reactor — calm, precise, alive. Drawn on Canvas 2D.
//   • a dim full track with one live cyan arc on top (orbits at standby,
//     follows the mic / voice level, sweeps while processing)
//   • a slim ring of 72 segments that fade with the real audio, with a soft
//     brightness wave travelling round at standby
//   • connector nodes, a faint inner disc, and the logo with a breathing halo
//   • thin amber arcs around the logo only while listening or speaking
// Every moving value is driven by a real signal fed in through setSignals().

const TAU = Math.PI * 2;
const D = 720; // design size of the core box
const C = D / 2;
const R = {
  outer: 292, // hairline under the tick ring (ticks.js)
  node: 276, // connector nodes sit on this hairline
  track: 250, // dim full track + the live arc
  segOut: 232, segIn: 222, // 72 segments, 10px long, inside the track
  inner: 150, // inner circle (with the faint disc)
  amber: 72, // amber arcs around the logo
};
const SEGS = 72;
const STANDBY_ARC = 40; // degrees
const ORBIT = 12; // seconds per rotation at standby
const WAVE = 6; // seconds per standby wave lap
const PROCESSING = new Set(['TRANSCRIBING', 'THINKING', 'TOOL_RUNNING', 'STREAMING']);

const PAL = {
  accent: [91, 225, 240],
  white: [255, 255, 255],
  amber: [255, 170, 80],
  red: [255, 92, 108],
};
// Boot parameters (tweened by ui/boot.js). FULL = normal operation.
const FULL = { rings: 1, arc: 1, lines: null, nodes: 99, order: [], logo: 1 };
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const deg = (d) => ((d - 90) * Math.PI) / 180; // 0° at 12 o'clock, clockwise
const ease = (x, rate, dt) => x * Math.pow(1 - rate, dt * 60);

export class Core {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'STANDBY';
    this.prevState = 'STANDBY';
    this.stateAt = performance.now();
    this.blend = 1; // 0→1 after a state change
    this.head = -Math.PI / 2; // live arc start angle
    this.arcLen = STANDBY_ARC; // degrees, smoothed
    this.sweepT = 0; // processing phase
    this.level = 0; // smoothed real level (mic / tts)
    this.bands = null;
    this.progress = null; // 0..1 real progress (kept for callers)
    this.activity = 0; // stream activity, decays
    this.seg = new Float32Array(SEGS); // smoothed brightness per segment
    this.amber = 0; // amber arcs opacity (0..1, 300 ms fades)
    this.nodes = []; // [{deg, flashAt, holdAt, dock}]
    this.hoverDeg = null;
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

  /** Docked look for a node: 0 = normal, 1 = filled cyan dot. */
  setDocked(d, v) {
    const n = this.nodes.find((x) => x.deg === d);
    if (n) n.dock = v;
  }

  /** A soft brightness wave around the segment ring, starting at angle d (deg). */
  ripple(d) {
    this.lineRipples.push({ t: performance.now(), a: d });
  }

  /** One soft pulse on a node (value changed, card docked). */
  flashNode(d) {
    const n = this.nodes.find((x) => x.deg === d);
    if (n) n.flashAt = performance.now();
  }

  /** Show a node's cyan hover ring this frame (card hover, live camera). */
  holdNode(d) {
    const n = this.nodes.find((x) => x.deg === d);
    if (n) n.holdAt = performance.now();
  }

  /** Pointer over a node's hit area (null when it leaves). */
  setHover(d) {
    this.hoverDeg = d;
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
    if (bands !== undefined) this.bands = bands;
    if (progress !== undefined) this.progress = progress;
  }

  pulseActivity() {
    this.activity = Math.min(1, this.activity + 0.25);
  }

  frame(now, dt) {
    const s = this.state;
    const audio = s === 'LISTENING' || s === 'SPEAKING';
    const busy = PROCESSING.has(s);
    this.blend = Math.min(1, this.blend + dt / 0.5);
    this.activity *= Math.pow(0.25, dt);
    if (!audio) this.level *= Math.pow(0.08, dt);
    this.err += ((s === 'ERROR' ? 1 : 0) - this.err) * Math.min(1, dt * 4);
    this.mini = !!(this.canvas.parentElement && this.canvas.parentElement.classList.contains('mini'));
    // amber arcs: fade in / out over ~300 ms
    this.amber += Math.sign((audio ? 1 : 0) - this.amber) * Math.min(Math.abs((audio ? 1 : 0) - this.amber), dt / 0.3);

    // ---- live arc ----
    let target = STANDBY_ARC;
    let speed = TAU / ORBIT;
    if (audio) target = 10 + Math.min(1, this.level * 1.3) * 300;
    else if (busy) {
      // indeterminate sweep: the arc breathes between short and long while turning
      this.sweepT += dt / 1.6;
      target = 30 + 130 * (0.5 - 0.5 * Math.cos(this.sweepT * TAU));
      speed = TAU / 1.4;
    } else if (s === 'ERROR') speed = 0;
    if (this.reduced) speed = 0;
    this.head += speed * dt;
    this.arcLen += (target - this.arcLen) * Math.min(1, dt * (audio ? 14 : 6));

    // ---- segments: smooth fades toward the target brightness ----
    const tgt = this._segTargets(now);
    for (let i = 0; i < SEGS; i++) {
      const up = tgt[i] > this.seg[i];
      this.seg[i] += (tgt[i] - this.seg[i]) * Math.min(1, dt * (up ? 16 : 4));
    }
    this._draw(now);
  }

  /** Target brightness per segment (0..1) from real audio, a processing sweep, or the standby wave. */
  _segTargets(now) {
    const s = this.state;
    const out = new Float32Array(SEGS);
    if (s === 'LISTENING' || s === 'SPEAKING') {
      const b = this.bands;
      const lv = Math.min(1, this.level * 1.2);
      for (let i = 0; i < SEGS; i++) {
        // mirror the spectrum left/right of 12 o'clock
        const pos = i < SEGS / 2 ? i : SEGS - i;
        let v;
        if (b && b.length) v = (b[Math.floor((pos / (SEGS / 2)) * (b.length - 1))] || 0) * 1.25;
        else v = lv * (0.55 + 0.45 * Math.cos((pos / (SEGS / 2)) * Math.PI * 0.5));
        out[i] = Math.min(1, v);
      }
      return out;
    }
    if (PROCESSING.has(s)) {
      // follow the live arc's head with a soft tail
      const headDeg = ((((this.head + Math.PI / 2) * 180) / Math.PI) + (this.arcLen || 0)) % 360;
      for (let i = 0; i < SEGS; i++) {
        const d = (headDeg - (i / SEGS) * 360 + 720) % 360;
        out[i] = d < 50 ? Math.pow(1 - d / 50, 2) * 0.5 : 0;
      }
      return out;
    }
    if (s === 'STANDBY' && !this.reduced) {
      // a soft brightness wave travels round once every ~6 s
      const at = ((now / 1000) % WAVE) / WAVE * 360;
      for (let i = 0; i < SEGS; i++) {
        const d = ((((i / SEGS) * 360 - at) % 360) + 540) % 360 - 180;
        out[i] = Math.exp(-(d * d) / (2 * 18 * 18)) * 0.3;
      }
    }
    return out;
  }

  // ---------- drawing ----------
  _ring(ctx, r, color, frac = 1, w = 1) {
    if (frac <= 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
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
    const B = this.boot || FULL;
    const accent = mix(PAL.accent, PAL.red, this.err * 0.9);
    const W = PAL.white;
    const breathe = this.reduced ? 1 : 0.5 + 0.5 * Math.sin((now / 4000) * TAU); // 4 s cycle

    // ---- inner disc: cyan 5% at the centre fading to transparent ----
    if (B.rings > 0) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R.inner);
      g.addColorStop(0, rgba(PAL.accent, 0.05 * B.rings));
      g.addColorStop(1, rgba(PAL.accent, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, R.inner, 0, TAU);
      ctx.fill();
    }

    // ---- hairline rings + the dim full track (never bright) ----
    this._ring(ctx, R.outer, rgba(W, 0.08), B.rings);
    this._ring(ctx, R.node, rgba(W, 0.07), B.rings);
    this._ring(ctx, R.inner, rgba(W, 0.08), B.rings);
    this._ring(ctx, R.track, rgba(W, 0.08), B.rings);

    // ---- the live arc: 2px cyan, round caps ----
    if (B.arc > 0 && this.arcLen > 0.5) {
      const len = ((this.arcLen * Math.PI) / 180) * B.arc;
      ctx.strokeStyle = rgba(accent, 0.95);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, R.track, this.head, this.head + len);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // ---- 72 segments: 8% white at rest, smooth cyan fades with audio ----
    if (!this.mini) {
      const ripples = this.lineRipples.filter((r) => now - r.t < 700);
      this.lineRipples = ripples;
      const shown = B.lines == null ? SEGS : Math.min(SEGS, Math.round(B.lines));
      ctx.lineWidth = 2;
      for (let i = 0; i < shown; i++) {
        const a = deg((i / SEGS) * 360);
        let v = this.seg[i];
        for (const r of ripples) {
          const p = (now - r.t) / 700;
          const bd = ((((i / SEGS) * 360 - r.a) % 360) + 540) % 360 - 180;
          const q = (Math.abs(bd) - p * 180) / 24;
          v = Math.max(v, Math.exp(-q * q) * (1 - p) * 0.6);
        }
        const c = Math.cos(a);
        const sn = Math.sin(a);
        ctx.strokeStyle = rgba(W, 0.08);
        ctx.beginPath();
        ctx.moveTo(c * R.segIn, sn * R.segIn);
        ctx.lineTo(c * R.segOut, sn * R.segOut);
        ctx.stroke();
        if (v > 0.01) {
          ctx.strokeStyle = rgba(accent, Math.min(1, v) * 0.9);
          ctx.stroke();
        }
      }
    }

    // ---- connector nodes: 7px dot + 1px ring; cyan ring on hover; filled cyan when docked ----
    for (const n of this.nodes) {
      if (this.boot) {
        const idx = B.order.indexOf(n.deg);
        if (idx < 0 || idx >= B.nodes) continue;
      }
      const a = deg(n.deg);
      const x = Math.cos(a) * R.node;
      const y = Math.sin(a) * R.node;
      const pulse = Math.max(0, 1 - (now - n.flashAt) / 700);
      const hover = this.hoverDeg === n.deg || now - n.holdAt < 120;
      const dk = n.dock || 0;
      ctx.fillStyle = dk > 0 ? rgba(mix(W, accent, dk), 0.35 + 0.65 * dk) : rgba(W, hover ? 0.6 : 0.35);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hover ? rgba(accent, 0.9) : rgba(W, dk > 0 ? 0.1 : 0.16);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, TAU);
      ctx.stroke();
      if (pulse > 0) {
        ctx.strokeStyle = rgba(accent, 0.5 * pulse);
        ctx.beginPath();
        ctx.arc(x, y, 7 + (1 - pulse) * 8, 0, TAU);
        ctx.stroke();
      }
    }

    // ---- logo: 1.6× larger, soft halo behind, slow breathing (4 s) ----
    if (B.logo > 0) {
      const sc = 0.98 + 0.02 * B.logo;
      ctx.save();
      ctx.scale(sc, sc);
      if (this.quality === 'high') {
        const hr = 104;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, hr);
        g.addColorStop(0, rgba(accent, 0.2 * (0.75 + 0.25 * breathe) * B.logo));
        g.addColorStop(0.45, rgba(accent, 0.06 * B.logo));
        g.addColorStop(1, rgba(accent, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, hr, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = (0.85 + 0.15 * breathe) * B.logo;
      this._logo(ctx, accent);
      ctx.restore();
    }

    // ---- amber arcs: thin, only while listening or speaking (300 ms fades) ----
    if (this.amber > 0.01) {
      const span = ((32 + Math.min(1, this.level * 1.4) * 16) * Math.PI) / 180;
      ctx.strokeStyle = rgba(PAL.amber, 0.85 * this.amber);
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      for (const mid of [0, Math.PI]) {
        ctx.beginPath();
        ctx.arc(0, 0, R.amber, mid - span, mid + span);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
  }

  /** The emblem: a flat diamond with a W cutout, drawn from a cached sprite. */
  _logo(ctx, accent) {
    const sz = 42;
    const k = this.k;
    const color = rgba(accent.map((v) => Math.round(v)), 1);
    const key = `${k.toFixed(3)}|${color}`;
    if (this._sprite?.key !== key) this._sprite = { key, canvas: this._buildLogo(sz, k, color) };
    const half = sz + 2;
    ctx.drawImage(this._sprite.canvas, -half, -half, half * 2, half * 2);
  }

  _buildLogo(sz, k, color) {
    const half = sz + 2;
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.ceil(half * 2 * k);
    const g = cv.getContext('2d');
    g.setTransform(k, 0, 0, k, half * k, half * k);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, -sz);
    g.lineTo(sz, 0);
    g.lineTo(0, sz);
    g.lineTo(-sz, 0);
    g.closePath();
    g.fill();
    // W cutout + top notch, punched out of the diamond only
    g.globalCompositeOperation = 'destination-out';
    g.lineWidth = sz * 0.16;
    g.lineJoin = 'miter';
    g.strokeStyle = '#000';
    g.beginPath();
    g.moveTo(-sz * 0.6, -sz * 0.08);
    g.lineTo(-sz * 0.3, sz * 0.38);
    g.lineTo(0, sz * 0.02);
    g.lineTo(sz * 0.3, sz * 0.38);
    g.lineTo(sz * 0.6, -sz * 0.08);
    g.stroke();
    g.fillStyle = '#000';
    g.beginPath();
    g.moveTo(0, -sz * 0.6);
    g.lineTo(sz * 0.15, -sz * 0.4);
    g.lineTo(0, -sz * 0.2);
    g.lineTo(-sz * 0.15, -sz * 0.4);
    g.closePath();
    g.fill();
    return cv;
  }
}
