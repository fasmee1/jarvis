// HUD background: technical grid (cached canvas, redrawn on resize), "+" marks, edge rulers with A/B/C coordinates,
// framing marks, soft diagonal beam, radar sweep, vignette and film grain. Everything here is static decoration
// except the radar sweep (CSS) and the state-change shockwave that lights the grid lines it crosses.
// Ported from the reference HUD; it only exists while the HUD style is on (see HudBackdrop.setActive).

import { HUD_R_OUT } from './layout.js';

const TEAL = '0,229,255';
const NSV = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

export class HudBackdrop {
  constructor() {
    this.active = false;
    this.rulers = { top: [], bottom: [], left: [], right: [], labels: [], base: [] };
    const home = $('home');
    const bg = (this.bg = document.createElement('div'));
    bg.id = 'hud-bg';
    bg.setAttribute('aria-hidden', 'true');
    bg.hidden = true;
    bg.innerHTML = '<div id="beam"></div><div id="radar"></div><canvas id="gridCv"></canvas><canvas id="gridLit"></canvas><div id="vig"></div><div id="grain"></div>';
    home.prepend(bg);
    const frame = (this.frameEl = document.createElement('div'));
    frame.id = 'hud-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.hidden = true;
    frame.innerHTML = `<svg viewBox="0 0 1672 940" preserveAspectRatio="none">
      <g class="fm">
        <path class="corner c-tr" d="M1622 22H1648V46M1622 34V22"/><path class="corner c-bl" d="M24 868V914H74"/><path class="corner c-br" d="M1648 868V914H1598"/>
        <path d="M1596 874V902M1596 874H1580" opacity=".6"/>
        <path d="M158 35H1560" class="hair"/><path d="M130 872H1500" class="hair"/><path d="M44 62V860" class="hair"/><path d="M1628 62V860" class="hair"/>
        <path class="cross" d="M70 372h16M78 364v16"/><path class="cross" d="M185 688h16M193 680v16"/><path class="cross" d="M1468 677h16M1476 669v16"/><path class="cross" d="M1582 372h16M1590 364v16"/>
        <circle cx="1596" cy="872" r="3"/>
      </g></svg>`;
    home.prepend(frame);
    this.cv = bg.querySelector('#gridCv');
    this.lit = bg.querySelector('#gridLit');
    this.ctx = this.cv.getContext('2d');
    this.litCtx = this.lit.getContext('2d');
    this._film();
    let t = 0;
    addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => this.active && this.draw(), 80); });
    document.fonts && document.fonts.ready.then(() => this.active && this.draw());
    document.addEventListener('hud:shock', () => this.shock());
  }

  setActive(on) {
    this.active = !!on;
    this.bg.hidden = !on;
    this.frameEl.hidden = !on;
    if (on) requestAnimationFrame(() => this.draw());
  }

  /** core centre and node-ring radius in viewport px (matches the stage composition) */
  core() {
    const s = $('stage').getBoundingClientRect();
    return { x: s.left + s.width / 2, y: s.top + s.height / 2, r: (s.width * HUD_R_OUT) / 1920 };
  }

  draw() {
    const W = innerWidth, H = innerHeight, dpr = Math.min(2, devicePixelRatio || 1), { cv, ctx } = this;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const c = this.core(), cell = Math.max(16, Math.round((24 * Math.min(W, H)) / 1080));
    const ox = ((c.x % cell) + cell) % cell, oy = ((c.y % cell) + cell) % cell; // a grid line passes through the core centre
    const colIdx = (x) => Math.round((x - ox) / cell), rowIdx = (y) => Math.round((y - oy) / cell);
    const major = (n) => ((n % 5) + 5) % 5 === 0;
    ctx.lineWidth = 1;
    for (let x = ox; x < W; x += cell) { ctx.strokeStyle = `rgba(${TEAL},${major(colIdx(x)) ? 0.06 : 0.02})`; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); ctx.stroke(); }
    for (let y = oy; y < H; y += cell) { ctx.strokeStyle = `rgba(${TEAL},${major(rowIdx(y)) ? 0.06 : 0.02})`; ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); ctx.stroke(); }
    ctx.strokeStyle = `rgba(${TEAL},0.2)`; ctx.beginPath();
    for (let x = ox; x < W; x += cell) {
      for (let y = oy; y < H; y += cell) {
        if (!major(colIdx(x)) || !major(rowIdx(y))) continue;
        const px = Math.round(x) + 0.5, py = Math.round(y) + 0.5;
        ctx.moveTo(px - 3, py); ctx.lineTo(px + 3, py); ctx.moveTo(px, py - 3); ctx.lineTo(px, py + 3);
      }
    }
    ctx.stroke();
    // radial fade: the grid is nearly invisible around the core, strongest in the empty corners
    ctx.save(); ctx.globalCompositeOperation = 'destination-out';
    const g = ctx.createRadialGradient(c.x, c.y, c.r * 0.9, c.x, c.y, c.r * 2.1);
    g.addColorStop(0, 'rgba(0,0,0,0.92)'); g.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
    this._drawLit(W, H, dpr, c, cell, ox, oy, colIdx, rowIdx, major);
    this._buildRulers(W, H, cell, ox, oy, colIdx, rowIdx, major);
  }

  _buildRulers(W, H, cell, ox, oy, colIdx, rowIdx, major) {
    let svg = $('rulers');
    if (!svg) { svg = document.createElementNS(NSV, 'svg'); svg.id = 'rulers'; svg.setAttribute('aria-hidden', 'true'); this.bg.insertBefore(svg, this.bg.querySelector('#vig')); }
    svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.textContent = '';
    const R = (this.rulers = { top: [], bottom: [], left: [], right: [], labels: [], base: [] });
    const m = Math.round((36 * Math.min(W, H)) / 1080), lm = m + 10, fs = Math.max(9, Math.round((10 * Math.min(W, H)) / 1080));
    const el = (tag, attrs, text) => { const e = document.createElementNS(NSV, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
    const rule = (edge, horizontal, pos, from, to, off, pre, side) => {
      R.base.push(el('line', horizontal ? { x1: from, x2: to, y1: pos + 0.5, y2: pos + 0.5, class: 'rl' } : { y1: from, y2: to, x1: pos + 0.5, x2: pos + 0.5, class: 'rl' }));
      const o = horizontal ? ox : oy;
      for (let v = o; v < to; v += cell) {
        if (v < from) continue;
        const n = horizontal ? colIdx(v) : rowIdx(v), len = major(n) ? 7 : 3.5, p = Math.round(v) + 0.5;
        R[edge].push(el('line', horizontal ? { x1: p, x2: p, y1: pos, y2: pos + side * len, class: 'rt' } : { y1: p, y2: p, x1: pos, x2: pos + side * len, class: 'rt' }));
      }
      for (let v = o; v < to; v += cell) {
        const n = horizontal ? colIdx(v) : rowIdx(v);
        if (v < from + 14 || (horizontal && side < 0 && v > W - 300) || !major(n)) continue;
        const text = pre + (n < 1 ? 1 : n);
        const t = horizontal
          ? el('text', { x: Math.round(v), y: pos + side * 15, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': fs, class: 'rx' }, text)
          : el('text', { x: pos + side * off, y: Math.round(v), 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': fs, class: 'rx' }, text);
        R.labels.push({ el: t, text, edge });
      }
    };
    const xa = lm + 40, xb = W - lm, ya = lm + 40, yb = H - lm;
    rule('top', true, m - 1, xa + 60, xb, 0, 'A', -1);
    rule('bottom', true, H - Math.round(m * 1.8), xa, xb, 0, 'A', 1);
    rule('left', false, m + 10, ya, yb, 22, 'B', -1);
    rule('right', false, W - m - 10, ya, yb, 22, 'C', 1);
  }

  // Bright copy of the grid lines, masked to a thin expanding ring by CSS (#gridLit.go): the state-change shockwave
  // lights exactly the grid lines it crosses.
  _drawLit(W, H, dpr, c, cell, ox, oy, colIdx, rowIdx, major) {
    const { lit, litCtx } = this;
    lit.width = Math.round(W * dpr); lit.height = Math.round(H * dpr);
    lit.style.width = `${W}px`; lit.style.height = `${H}px`;
    lit.style.setProperty('--cx', `${c.x + 6}px`); lit.style.setProperty('--cy', `${c.y + 6}px`);
    litCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    litCtx.clearRect(0, 0, W, H);
    litCtx.lineWidth = 1;
    for (let x = ox; x < W; x += cell) { litCtx.strokeStyle = `rgba(${TEAL},${major(colIdx(x)) ? 0.7 : 0.38})`; litCtx.beginPath(); litCtx.moveTo(Math.round(x) + 0.5, 0); litCtx.lineTo(Math.round(x) + 0.5, H); litCtx.stroke(); }
    for (let y = oy; y < H; y += cell) { litCtx.strokeStyle = `rgba(${TEAL},${major(rowIdx(y)) ? 0.7 : 0.38})`; litCtx.beginPath(); litCtx.moveTo(0, Math.round(y) + 0.5); litCtx.lineTo(W, Math.round(y) + 0.5); litCtx.stroke(); }
    litCtx.save(); litCtx.globalCompositeOperation = 'destination-out';
    const g = litCtx.createRadialGradient(c.x, c.y, c.r * 0.9, c.x, c.y, c.r * 2.1);
    g.addColorStop(0, 'rgba(0,0,0,0.95)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
    litCtx.fillStyle = g; litCtx.fillRect(0, 0, W, H); litCtx.restore();
  }

  /** The expanding ring that lit the grid on a state change was removed (it swept across the whole screen). */
  shock() {}

  _film() { // static grain tile (made once)
    const t = document.createElement('canvas'); t.width = t.height = 192;
    const x = t.getContext('2d'), d = x.createImageData(192, 192);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    x.putImageData(d, 0, 0);
    this.bg.querySelector('#grain').style.backgroundImage = `url(${t.toDataURL()})`;
  }

  /** micro-parallax for the grid layer (opposite direction to the core layers) */
  parallax(px, py) {
    const t = `${(-px * 3).toFixed(2)}px ${(-py * 3).toFixed(2)}px`;
    this.cv.style.translate = t;
    this.lit.style.translate = t;
  }
}
