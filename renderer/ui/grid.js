// Background: a deep neutral near-black with a very subtle radial lift behind
// the reactor, and a faint dot grid (1px dots every 40px, 6% opacity) that
// fades out around the reactor. Rendered once per resize; nothing animates.

import { CORE } from './layout.js';

const DOT_STEP = 40; // design px
const DOT_ALPHA = 0.06;

export class Grid {
  constructor(bgCanvas, fxCanvas) {
    this.bg = bgCanvas;
    this.fx = fxCanvas;
    this.quality = 'high';
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

    // base: #07090C, lifting to #0B0F14 behind the reactor
    ctx.fillStyle = '#07090C';
    ctx.fillRect(0, 0, w, h);
    const lift = ctx.createRadialGradient(cx, cy, 0, cx, cy, 760 * k);
    lift.addColorStop(0, 'rgba(14, 19, 26, 1)');
    lift.addColorStop(0.5, 'rgba(11, 15, 20, 0.6)');
    lift.addColorStop(1, 'rgba(11, 15, 20, 0)');
    ctx.fillStyle = lift;
    ctx.fillRect(0, 0, w, h);

    // dot grid on its own layer so the area around the reactor can fade out
    const g = document.createElement('canvas');
    g.width = w;
    g.height = h;
    const gc = g.getContext('2d');
    const step = DOT_STEP * k;
    const [x0, y0] = this._p(0, 0);
    const sx = ((x0 % step) + step) % step;
    const sy = ((y0 % step) + step) % step;
    const dot = Math.max(1, Math.round(this.dpr));
    gc.fillStyle = `rgba(230, 237, 243, ${DOT_ALPHA})`;
    for (let x = sx; x < w; x += step) {
      for (let y = sy; y < h; y += step) gc.fillRect(Math.round(x), Math.round(y), dot, dot);
    }
    const fade = gc.createRadialGradient(cx, cy, CORE.rOuter * 0.9 * k, cx, cy, CORE.rOuter * 1.5 * k);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    gc.globalCompositeOperation = 'destination-out';
    gc.fillStyle = fade;
    gc.fillRect(0, 0, w, h);
    ctx.drawImage(g, 0, 0);
  }

  /** Static background; kept so the render loop can call it. */
  frame() {}

  /** State changes no longer ripple across the background. */
  shockwave() {}

  /** Edge rulers were removed; kept as a no-op for older callers. */
  drawRulers() {}
}
