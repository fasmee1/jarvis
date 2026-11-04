// Calm style background (holographic): deep navy with a soft blue radial light behind
// the reactor, a fine technical grid that fades out around the core and toward the
// edges, two thin alignment guides with small coordinate ticks, very faint orbital
// geometry and sparse static particles. Rendered once per resize; nothing animates
// (the moving light lives in the WebGL core, vendor/holo-core.min.js).

import { CORE } from './layout.js';

const GRID = 60; // design px between fine grid lines
const MAJOR = 4; // every 4th line is a little stronger
const STARS = 150;

// Deterministic PRNG: the background is identical on every launch / resize.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Grid {
  constructor(bgCanvas, fxCanvas) {
    this.bg = bgCanvas;
    this.fx = fxCanvas;
    this.quality = 'high';
    this.style = 'calm';
  }

  setStyle(style) {
    this.style = style === 'hud' ? 'hud' : 'calm'; // the HUD draws its own background (hud-backdrop.js)
  }

  /** @param {{scale:number, ox:number, oy:number}} t stage transform */
  resize(t) {
    this.t = t;
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    this.bg.width = w;
    this.bg.height = h;
    if (this.fx) {
      this.fx.width = 1;
      this.fx.height = 1;
    }
    this._draw();
  }

  // window px of a design point
  _p(x, y) {
    const { scale, ox, oy } = this.t;
    return [(ox + x * scale) * this.dpr, (oy + y * scale) * this.dpr];
  }

  _draw() {
    const ctx = this.bg.getContext('2d');
    const { width: w, height: h } = this.bg;
    const k = this.t.scale * this.dpr;
    const [cx, cy] = this._p(CORE.x, CORE.y);
    const reach = Math.hypot(w, h) / 2;

    // ---- base: #020711 with a blue light behind the core and a faint haze low-left ----
    ctx.fillStyle = '#020711';
    ctx.fillRect(0, 0, w, h);
    // the light sits behind the rings; the centre stays dark (the core is hollow)
    let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 860 * k);
    g.addColorStop(0, 'rgba(2, 7, 17, 0.9)');
    g.addColorStop(0.16, 'rgba(6, 19, 41, 0.55)');
    g.addColorStop(0.32, 'rgba(8, 60, 140, 0.16)');
    g.addColorStop(0.55, 'rgba(6, 19, 41, 0.45)');
    g.addColorStop(1, 'rgba(6, 19, 41, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    g = ctx.createRadialGradient(w * 0.08, h * 1.02, 0, w * 0.08, h * 1.02, 700 * k);
    g.addColorStop(0, 'rgba(8, 80, 200, 0.12)');
    g.addColorStop(1, 'rgba(8, 80, 200, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // ---- fine grid on its own layer: fades out around the core and toward the edges ----
    const lay = document.createElement('canvas');
    lay.width = w;
    lay.height = h;
    const gc = lay.getContext('2d');
    const step = GRID * k;
    const [x0, y0] = this._p(0, 0);
    const line = Math.max(1, Math.round(this.dpr));
    const iStart = Math.floor(-x0 / step) - 1;
    const jStart = Math.floor(-y0 / step) - 1;
    for (let i = iStart; x0 + i * step < w; i++) {
      gc.fillStyle = i % MAJOR === 0 ? 'rgba(32, 184, 255, 0.07)' : 'rgba(32, 184, 255, 0.035)';
      gc.fillRect(Math.round(x0 + i * step), 0, line, h);
    }
    for (let j = jStart; y0 + j * step < h; j++) {
      gc.fillStyle = j % MAJOR === 0 ? 'rgba(32, 184, 255, 0.07)' : 'rgba(32, 184, 255, 0.035)';
      gc.fillRect(0, Math.round(y0 + j * step), w, line);
    }
    gc.globalCompositeOperation = 'destination-in';
    const keep = gc.createRadialGradient(cx, cy, CORE.rOuter * 0.95 * k, cx, cy, reach);
    keep.addColorStop(0, 'rgba(0,0,0,0)');
    keep.addColorStop(0.18, 'rgba(0,0,0,0.9)');
    keep.addColorStop(0.55, 'rgba(0,0,0,0.55)');
    keep.addColorStop(1, 'rgba(0,0,0,0.1)');
    gc.fillStyle = keep;
    gc.fillRect(0, 0, w, h);
    ctx.drawImage(lay, 0, 0);

    // ---- alignment guides through the core with small coordinate ticks ----
    const guide = (horizontal) => {
      const len = horizontal ? w : h;
      const c = horizontal ? cx : cy;
      const lg = horizontal ? ctx.createLinearGradient(0, 0, w, 0) : ctx.createLinearGradient(0, 0, 0, h);
      const at = c / len;
      lg.addColorStop(0, 'rgba(32, 184, 255, 0)');
      lg.addColorStop(Math.max(0, at - 0.3), 'rgba(32, 184, 255, 0.08)');
      lg.addColorStop(at, 'rgba(32, 184, 255, 0.02)');
      lg.addColorStop(Math.min(1, at + 0.3), 'rgba(32, 184, 255, 0.08)');
      lg.addColorStop(1, 'rgba(32, 184, 255, 0)');
      ctx.fillStyle = lg;
      if (horizontal) ctx.fillRect(0, Math.round(cy), w, line);
      else ctx.fillRect(Math.round(cx), 0, line, h);
      // ticks every 2 grid cells, outside the core only
      ctx.fillStyle = 'rgba(112, 223, 255, 0.16)';
      const tick = 2 * step;
      for (let d = Math.ceil((CORE.rOuter * 1.25 * k) / tick) * tick; d < len; d += tick) {
        for (const sgn of [-1, 1]) {
          const p = c + sgn * d;
          if (p < 0 || p > len) continue;
          const major = Math.round(d / tick) % 4 === 0;
          const tl = (major ? 7 : 3) * k;
          if (horizontal) ctx.fillRect(Math.round(p), Math.round(cy - tl), line, Math.round(tl * 2));
          else ctx.fillRect(Math.round(cx - tl), Math.round(p), Math.round(tl * 2), line);
        }
      }
    };
    guide(true);
    guide(false);

    // ---- very faint orbital geometry around the core ----
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineWidth = line;
    ctx.strokeStyle = 'rgba(32, 184, 255, 0.05)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 560 * k, 205 * k, -0.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(32, 184, 255, 0.035)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 640 * k, 300 * k, 0.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([2 * k, 10 * k]);
    ctx.strokeStyle = 'rgba(112, 223, 255, 0.08)';
    ctx.beginPath();
    ctx.arc(0, 0, 470 * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // ---- sparse static particles (a few warm ones) ----
    const r = rng(23);
    for (let i = 0; i < STARS; i++) {
      const x = r() * w;
      const y = r() * h;
      const near = Math.hypot(x - cx, y - cy) / (k || 1);
      if (near < CORE.rOuter * 1.05) continue;
      const warm = r() < 0.05;
      const a = 0.12 + r() * 0.4;
      const s = (0.6 + r() * 1.1) * this.dpr;
      ctx.fillStyle = warm ? `rgba(255, 155, 69, ${a})` : `rgba(112, 223, 255, ${a})`;
      ctx.beginPath();
      ctx.arc(x, y, s, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- vignette ----
    g = ctx.createRadialGradient(cx, cy, reach * 0.45, cx, cy, reach * 1.05);
    g.addColorStop(0, 'rgba(1, 4, 10, 0)');
    g.addColorStop(1, 'rgba(1, 4, 10, 0.7)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  /** Static background; kept so the render loop can call it. */
  frame() {}

  /** State changes no longer ripple across the background. */
  shockwave() {}

  /** Edge rulers were removed; kept as a no-op for older callers. */
  drawRulers() {}
}
