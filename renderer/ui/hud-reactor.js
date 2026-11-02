// HUD reactor — the reference "Energy Core" drawn as layered SVG (static rings + ticks, two counter-rotating arc
// layers, a segmented block ring, a data band, satellites, the emblem, ripple / shockwave / flash).
// It lives inside #core-wrap and exposes the same small API as the calm canvas core (ui/core.js), so cards,
// docking and the boot sequence drive either one. Every moving value comes from real signals fed in by Home.
//
// Coordinates are the reference stage units (1672×940, core centre 836,481); each layer's viewBox maps them onto
// the 720 px core box at HS px per unit, so a unit here is exactly one unit of the reference composition.

import { HS } from './layout.js';

const NS = 'http://www.w3.org/2000/svg';
const CX = 836, CY = 481, K = 1.15, R0 = 243;
export const CX_REF = CX, CY_REF = CY;
const RAD = Math.PI / 180;
const BOX = 720;
const HALF = BOX / 2 / HS; // half the box in ref units
const VIEWBOX = `${CX - HALF} ${CY - HALF} ${HALF * 2} ${HALF * 2}`;

const pt = (r, deg) => [CX + r * Math.cos(deg * RAD), CY + r * Math.sin(deg * RAD)];
const f1 = (n) => n.toFixed(1);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const angDiff = (a, b) => ((b - a + 540) % 360) - 180;
const lerp = (a, b, t) => a + (b - a) * t;

// [spinA deg/s, spinB deg/s, scale]; satellites: drift deg/s
const SPEEDS = {
  STANDBY: [6, -9, 1], LISTENING: [14, -20, 1], TRANSCRIBING: [30, -30, 0.965], THINKING: [118, -4, 1],
  STREAMING: [12, -16, 1], SPEAKING: [16, -22, 1], ERROR: [0, 0, 1],
};
const SAT = { STANDBY: 4, LISTENING: 9, TRANSCRIBING: 0, THINKING: 3, STREAMING: 30, SPEAKING: 11, ERROR: 0 };
const SAT_DIR = [1, 1, -1, 1];

/** App state names → the seven states of the reference reactor. */
export function normState(st) {
  switch (st) {
    case 'LISTENING': case 'FOLLOW_UP': case 'WAKE_DETECTED': return 'LISTENING';
    case 'TRANSCRIBING': return 'TRANSCRIBING';
    case 'THINKING': case 'TOOL_RUNNING': return 'THINKING';
    case 'STREAMING': return 'STREAMING';
    case 'SPEAKING': return 'SPEAKING';
    case 'ERROR': return 'ERROR';
    default: return 'STANDBY';
  }
}

const mk = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
const arcDash = (el, startDeg, lenDeg) => { // circle with pathLength=360, starts at 3 o'clock
  el.setAttribute('stroke-dasharray', `${lenDeg} ${360 - lenDeg}`);
  el.setAttribute('stroke-dashoffset', String(-startDeg));
};

export class HudReactor {
  /** @param {HTMLElement} wrap #core-wrap */
  constructor(wrap) {
    this.wrap = wrap;
    this.quality = 'high';
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.state = 'STANDBY';
    this.appState = 'STANDBY';
    this.since = performance.now();
    this.level = 0;
    this.bands = new Float32Array(16);
    this.bandsAt = 0;
    this.activityAt = performance.now();
    this.arcK = 1; // boot: arc length factor
    this.angA = 0; this.angB = 0; this.spdA = 6; this.spdB = -9; this.scl = 1;
    this.micSm = 0;
    this.sweepT = 0; this.errAt = 0; this.rippleAt = 0; this.bandAt = 0;
    this.tkA = 0; this.tkV = 0; this.tkT = 0; this.tkNext = 0; this.tkQ = '';
    this.satAng = [20, 115, 205, 300];
    this.nBlocks = 40;
    this.blockVal = []; this.blockTgt = []; this.blockEl = [];
    this.rip = null;
    this.mx = 0; this.my = 0; this.px = 0; this.py = 0; this.pq = '';
    this.nodes = new Map(); // deg → { g, docked(0..1), flashAt, holdAt }
    this.hoverDeg = null;
    this.active = false;
    addEventListener('mousemove', (e) => { this.mx = (e.clientX / innerWidth - 0.5) * 2; this.my = (e.clientY / innerHeight - 0.5) * 2; });
    this._build();
  }

  // ---------- build ----------
  _layer(cls) {
    const svg = mk('svg', { class: `hud-lyr ${cls || ''}`, viewBox: VIEWBOX, 'aria-hidden': 'true' }, this.root);
    return svg;
  }

  _scaled(parent, attrs = {}) {
    return mk('g', { transform: `translate(${CX} ${CY}) scale(${K}) translate(${-CX} ${-CY})`, ...attrs }, parent);
  }

  _build() {
    const root = (this.root = document.createElement('div'));
    root.className = 'hud-reactor';
    root.hidden = true;
    this.wrap.prepend(root);

    // static layer
    const L0 = this._layer('hud-static');
    const defs = mk('defs', {}, L0);
    defs.innerHTML = '<filter id="hud-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
    // guide lines (behind everything) + crosshairs
    defs.innerHTML += `<linearGradient id="hud-gline" gradientUnits="userSpaceOnUse" x1="-200" x2="${1672 + 200}" y1="0" y2="0"><stop offset="0" stop-color="#00E5FF" stop-opacity="0"/><stop offset=".16" stop-color="#00E5FF" stop-opacity=".2"/><stop offset=".84" stop-color="#00E5FF" stop-opacity=".2"/><stop offset="1" stop-color="#00E5FF" stop-opacity="0"/></linearGradient>`;
    const g0 = (this.guides = mk('g', { id: 'g-guides' }, L0));
    const R_OUT = R0 * K;
    mk('line', { x1: -1200, x2: CX - R_OUT - 6, y1: CY, y2: CY, stroke: 'url(#hud-gline)', 'stroke-width': 1 }, g0);
    mk('line', { x1: CX + R_OUT + 6, x2: 1672 + 1200, y1: CY, y2: CY, stroke: 'url(#hud-gline)', 'stroke-width': 1 }, g0);
    for (const x of [37, 1672 - 37]) mk('path', { d: `M${x - 9} ${CY}H${x + 9}M${x} ${CY - 9}V${CY + 9}`, stroke: 'rgba(0,229,255,.28)', 'stroke-width': 1.2, fill: 'none' }, g0);
    for (const [a, b, c, d] of [[300, 640, 560, 880], [1372, 640, 1112, 880], [560, 40, 700, 120], [1112, 40, 972, 120]]) mk('path', { d: `M${a} ${b}L${c} ${d}`, stroke: 'rgba(0,229,255,.06)', 'stroke-width': 1.2 }, g0);
    const gs = this._scaled(L0, { id: 'g-static' });
    this.gs = gs;
    mk('circle', { cx: CX, cy: CY, r: 238, fill: 'rgba(2,8,18,.42)' }, gs); // dark backing for the core text
    this.outer = mk('circle', { cx: CX, cy: CY, r: R0, pathLength: 360, fill: 'none', stroke: 'rgba(0,229,255,.38)', 'stroke-width': 1.2, class: 'outer' }, gs);
    const gMin = mk('g', { id: 'ticksMin', stroke: 'rgba(0,229,255,.22)', 'stroke-width': 0.8, fill: 'none' }, gs);
    const gMid = mk('g', { id: 'ticksMid', stroke: 'rgba(0,229,255,.38)', 'stroke-width': 1, fill: 'none' }, gs);
    const gMaj = mk('g', { id: 'ticksMaj', stroke: 'rgba(0,229,255,.6)', 'stroke-width': 1.3, fill: 'none' }, gs);
    this.tickLines = [];
    for (let a = 0; a < 360; a += 1) { // every 1°, medium every 5, long every 15
      const long = a % 15 === 0, med = !long && a % 5 === 0;
      const [x1, y1] = pt(R0 + 4, a), [x2, y2] = pt(R0 + (long ? 14 : med ? 10 : 6.5), a);
      const line = mk('line', { x1: f1(x1), y1: f1(y1), x2: f1(x2), y2: f1(y2) }, long ? gMaj : med ? gMid : gMin);
      this.tickLines.push({ el: line, a, x: x1, y: y1 });
    }
    for (let a = 0; a < 360; a += 15) { // tiny degree labels at the long ticks
      const major = a % 45 === 0;
      const [x, y] = pt(R0 + (major ? (a === 90 || a === 270 ? 44 : 28) : 24), a - 90);
      const t = mk('text', { x: f1(x), y: f1(y + 3), class: major ? 'deg' : 'deg minor' }, gs);
      t.textContent = `${a}°`;
    }
    const arcPath = (r, a1, a2) => { const [x1, y1] = pt(r, a1), [x2, y2] = pt(r, a2); return `M${f1(x1)} ${f1(y1)}A${r} ${r} 0 0 1 ${f1(x2)} ${f1(y2)}`; };
    for (const [a1, a2] of [[-125, -55], [108, 158], [22, 72]]) mk('path', { d: arcPath(R0 - 7, a1, a2), class: 'dash-or' }, gs);
    let tIn = '', tIn2 = '';
    for (let a = 0; a < 360; a += 2) { const [x1, y1] = pt(212, a), [x2, y2] = pt(a % 10 === 0 ? 220 : 216, a); tIn += `M${f1(x1)} ${f1(y1)}L${f1(x2)} ${f1(y2)}`; }
    for (let a = 0; a < 360; a += 6) { const [x1, y1] = pt(99, a), [x2, y2] = pt(a % 30 === 0 ? 107 : 103, a); tIn2 += `M${f1(x1)} ${f1(y1)}L${f1(x2)} ${f1(y2)}`; }
    mk('path', { d: tIn, stroke: 'rgba(0,229,255,.34)', 'stroke-width': 0.9, fill: 'none' }, gs);
    mk('path', { d: tIn2, stroke: 'rgba(0,229,255,.3)', 'stroke-width': 0.9, fill: 'none' }, gs);
    for (const a of [0, 90, 180, 270]) { const [x1, y1] = pt(62, a), [x2, y2] = pt(R0 - 12, a); mk('path', { d: `M${f1(x1)} ${f1(y1)}L${f1(x2)} ${f1(y2)}`, stroke: 'rgba(0,229,255,.13)', 'stroke-width': 0.9 }, gs); }
    this.tk1 = gMin; this.tk2 = gMaj; this.tk3 = gMid;
    for (const e of [gMin, gMaj, gMid]) e.style.transformOrigin = `${CX}px ${CY}px`;
    mk('circle', { cx: CX, cy: CY, r: 231, fill: 'none', stroke: 'rgba(0,229,255,.16)', 'stroke-width': 1 }, gs);
    mk('circle', { id: 'ringIn', cx: CX, cy: CY, r: 125, fill: 'none', stroke: 'rgba(0,229,255,.5)', 'stroke-width': 1.2 }, gs);
    mk('circle', { cx: CX, cy: CY, r: 117, fill: 'none', stroke: 'rgba(0,229,255,.2)', 'stroke-width': 1 }, gs);
    for (const a of [-90, 0, 90, 180]) { const [x1, y1] = pt(121, a), [x2, y2] = pt(129, a); mk('path', { d: `M${f1(x1)} ${f1(y1)}L${f1(x2)} ${f1(y2)}`, stroke: 'rgba(0,229,255,.7)', 'stroke-width': 1.4 }, gs); }
    for (const a of [-45, 45, 135, 225]) { const [x1, y1] = pt(117, a), [x2, y2] = pt(125, a); mk('path', { d: `M${f1(x1)} ${f1(y1)}L${f1(x2)} ${f1(y2)}`, stroke: 'rgba(0,229,255,.45)', 'stroke-width': 1 }, gs); }
    const brL = mk('circle', { class: 'acc-s arc sq', cx: CX, cy: CY, r: 107, pathLength: 360, 'stroke-width': 5.5 }, gs);
    const brR = mk('circle', { class: 'acc-s arc sq', cx: CX, cy: CY, r: 107, pathLength: 360, 'stroke-width': 5.5 }, gs);
    arcDash(brL, 150, 60); arcDash(brR, -30, 60);
    this.brL = brL; this.brR = brR;

    // node markers (leaders are drawn by cards.js in the #leaders svg)
    this.nodeG = mk('g', { class: 'hud-nodes' }, L0);

    // spinning layer A (clockwise) and B (counter-clockwise)
    const LA = (this.LA = this._layer('spin'));
    const gA = this._scaled(LA);
    const aOr = mk('circle', { class: 'acc-s arc sq', cx: CX, cy: CY, r: 219, pathLength: 360, 'stroke-width': 4.5 }, gA);
    arcDash(aOr, -78, 62);
    const aTl = mk('circle', { class: 'teal-s arc sq', cx: CX, cy: CY, r: 203, pathLength: 360, 'stroke-width': 3, opacity: 0.85 }, gA);
    arcDash(aTl, 200, 38);
    const aTl2 = mk('circle', { class: 'teal-s sq', cx: CX, cy: CY, r: 231, pathLength: 360, 'stroke-width': 2.4, opacity: 0.9 }, gA);
    arcDash(aTl2, 100, 26);
    const LB = (this.LB = this._layer('spin'));
    const gB = this._scaled(LB);
    const bOr = mk('circle', { class: 'acc-s arc sq', cx: CX, cy: CY, r: 196, pathLength: 360, 'stroke-width': 4.5 }, gB);
    arcDash(bOr, 160, 52);
    const bOr2 = mk('circle', { class: 'acc-s arc sq', cx: CX, cy: CY, r: 196, pathLength: 360, 'stroke-width': 3 }, gB);
    arcDash(bOr2, 20, 34);
    const bTl = mk('circle', { class: 'teal-s sq', cx: CX, cy: CY, r: 203, pathLength: 360, 'stroke-width': 2.4, opacity: 0.8 }, gB);
    arcDash(bTl, -20, 30);
    const bTl2 = mk('circle', { class: 'teal-s sq', cx: CX, cy: CY, r: 203, pathLength: 360, 'stroke-width': 2.4, opacity: 0.8 }, gB);
    arcDash(bTl2, 60, 28);
    mk('circle', { cx: CX, cy: CY, r: 186, fill: 'none', stroke: 'rgba(0,229,255,.30)', 'stroke-width': 1.2, 'stroke-dasharray': '2 7' }, gB);
    this.aOr = aOr; this.bOr = bOr; this.bOr2 = bOr2;

    // block ring + data band + satellites
    const L1 = (this.L1 = this._layer());
    const gK = this._scaled(L1);
    this.blockG = mk('g', { class: 'glowed' }, gK);
    this._buildBlocks();
    this.band = mk('path', { class: 'band' }, gK);
    mk('circle', { cx: CX, cy: CY, r: 211, fill: 'none', stroke: 'rgba(0,229,255,.14)', 'stroke-width': 1 }, gK);
    this.sats = this.satAng.map((a) => { const [x, y] = pt(211, a); return mk('circle', { cx: f1(x), cy: f1(y), r: 2.4, fill: '#3FF5FF', class: 'sat' }, gK); });

    // top layer: emblem + ripple + shock + flash
    const L2 = (this.L2 = this._layer());
    const gT = this._scaled(L2);
    const emb = (this.emb = mk('g', { class: 'breathe glowed' }, gT));
    const body = `M${CX} ${CY - 61}L${CX + 38} ${CY - 25}L${CX} ${CY + 11}L${CX - 38} ${CY - 25}Z`;
    mk('path', { d: body, fill: 'rgba(70,150,255,.55)', transform: 'translate(-1.4 0)', class: 'chroma' }, emb);
    mk('path', { d: body, fill: 'rgba(0,229,255,.7)', transform: 'translate(1.4 0)', class: 'chroma' }, emb);
    mk('path', { d: body, fill: 'rgba(0,229,255,.92)' }, emb);
    mk('path', { d: `M${CX - 24} ${CY - 33}L${CX - 12} ${CY - 13}L${CX} ${CY - 30}L${CX + 12} ${CY - 13}L${CX + 24} ${CY - 33}`, fill: 'none', stroke: '#051220', 'stroke-width': 5.5, 'stroke-linejoin': 'miter', 'stroke-linecap': 'butt' }, emb);
    this.ripple = mk('circle', { cx: CX, cy: CY, r: R0 * 0.92, fill: 'none', stroke: '#00E5FF', 'stroke-width': 1.6, opacity: 0 }, gT);
    this.shock = mk('circle', { id: 'shock', cx: CX, cy: CY, r: R0, fill: 'none', stroke: '#3FF5FF', 'stroke-width': 1.5, opacity: 0 }, gT);
    this.flash = mk('circle', { id: 'flash', cx: CX, cy: CY, r: 60 }, gT);
    for (const e of [this.ripple, this.shock, this.flash]) e.style.transformOrigin = `${CX}px ${CY}px`;
    this.followArc = mk('circle', { cx: CX, cy: CY, r: 56, pathLength: 100, fill: 'none', stroke: '#3FF5FF', 'stroke-width': 1.5, opacity: 0, transform: `rotate(-90 ${CX} ${CY})` }, gT);
    this.follow = null;
  }

  _buildBlocks() {
    this.blockG.replaceChildren();
    this.blockEl = []; this.blockVal = []; this.blockTgt = [];
    const n = this.nBlocks, step = 360 / n, half = n >= 40 ? 9.5 : 17;
    for (let i = 0; i < n; i++) {
      // square segments centred on r = 155; index 0 sits at the top, then runs counter-clockwise
      const phi = (-90 - (i + 1) * step) * RAD, cx = CX + 155 * Math.cos(phi), cy = CY + 155 * Math.sin(phi);
      const ux = Math.cos(phi), uy = Math.sin(phi), vx = -uy, vy = ux;
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => `${f1(cx + (a * ux + b * vx) * half)} ${f1(cy + (a * uy + b * vy) * half)}`);
      const p = mk('path', { class: 'blk', d: `M${pts.join('L')}Z` }, this.blockG);
      p.style.opacity = '.12';
      this.blockEl.push(p); this.blockVal.push(0); this.blockTgt.push(0);
    }
  }

  // ---------- API shared with the calm core ----------
  setActive(on) {
    this.active = !!on;
    this.root.hidden = !on;
  }

  setReduced(on) { this.reduced = !!on; }
  setStyle() {}
  resize() {}

  setQuality(q) {
    this.quality = q;
    const n = q === 'low' ? 20 : 40;
    if (n !== this.nBlocks) { this.nBlocks = n; this._buildBlocks(); }
  }

  setState(appState) {
    const s = normState(appState);
    this.appState = appState;
    if (s === this.state) return;
    this.state = s;
    this.since = performance.now();
    this.activityAt = performance.now();
    if (s === 'ERROR') this.errAt = performance.now();
    this.outer.classList.toggle('fractured', s === 'ERROR');
    document.body.dataset.s = s;
  }

  setSignals({ level, bands } = {}) {
    if (level != null) this.sigLevel = level;
    if (bands && bands.length) {
      const n = bands.length;
      for (let i = 0; i < 16; i++) this.bands[i] = clamp((bands[Math.min(n - 1, Math.floor((i / 16) * n))] || 0), 0, 1);
      this.bandsAt = performance.now();
    }
  }

  pulseActivity() { this.activityAt = performance.now(); }

  wake() {}

  /** Follow-up window: a thin arc around the logo that shrinks over ms (null hides it). */
  setFollow(ms) {
    this.follow = ms ? { at: performance.now(), ms } : null;
    if (!ms) this.followArc.setAttribute('opacity', '0');
  }

  /** Quick brightness ripple around the block ring (angle in D degrees, clockwise from the top). */
  ringRipple(deg) {
    if (!this.reduced) this.rip = { a: deg - 90, t0: performance.now() };
  }

  // ----- nodes on the ring (positions come from layout.js through setNodes) -----
  setNodes(degs) {
    this.nodeG.replaceChildren();
    this.nodes.clear();
    const R = 243 * K;
    for (const deg of degs) {
      const a = (deg - 90) * RAD, x = CX + R * Math.cos(a), y = CY + R * Math.sin(a);
      const g = mk('g', { class: 'hud-node', 'data-deg': deg }, this.nodeG);
      mk('circle', { class: 'noder', cx: f1(x), cy: f1(y), r: 11.5 }, g);
      mk('circle', { class: 'node', cx: f1(x), cy: f1(y), r: 5.4 }, g);
      mk('circle', { class: 'nodei', cx: f1(x), cy: f1(y), r: 2 }, g);
      this.nodes.set(deg, { g, flashAt: -1e9, holdAt: -1e9, dock: 0, x, y });
    }
  }

  flashNode(deg) {
    const n = this.nodes.get(deg);
    if (!n || this.reduced || !this.active) return;
    n.g.classList.remove('glow'); void n.g.getBoundingClientRect(); n.g.classList.add('glow');
    clearTimeout(n.glowT);
    n.glowT = setTimeout(() => n.g.classList.remove('glow'), 900);
  }

  holdNode(deg) {
    const n = this.nodes.get(deg);
    if (n) n.g.classList.add('hot');
    this._holdAt = performance.now();
    (this._held ||= new Set()).add(deg);
  }

  setHover(deg) {
    this.hoverDeg = deg;
    for (const [d, n] of this.nodes) n.g.classList.toggle('hot', d === deg);
  }

  setDocked(deg, v) {
    const n = this.nodes.get(deg);
    if (!n) return;
    n.dock = v;
    n.g.classList.toggle('docked', v >= 0.5);
  }

  // ---------- per frame ----------
  frame(now, dt) {
    if (!this.active) return;
    this._lastNow = now;
    const st = this.state, sp = SPEEDS[st] || SPEEDS.STANDBY;
    const lvlIn = clamp(this.sigLevel || 0, 0, 1);
    // release held node highlights when the holder stops asking (cards.frame calls holdNode every frame)
    if (this._held && now - this._holdAt > 60) {
      for (const d of this._held) { const n = this.nodes.get(d); if (n && d !== this.hoverDeg) n.g.classList.remove('hot'); }
      this._held.clear();
    }
    const k2 = 1 - Math.exp(-dt / 0.55);
    this.spdA += (sp[0] - this.spdA) * k2; this.spdB += (sp[1] - this.spdB) * k2; this.scl += (sp[2] - this.scl) * k2;
    if (!this.reduced) { this.angA = (this.angA + this.spdA * dt) % 360; this.angB = (this.angB + this.spdB * dt) % 360; }

    // micro-parallax: core layers move most (the cards and the grid follow in Home)
    if (!this.reduced) {
      this.px += (this.mx - this.px) * (1 - Math.exp(-dt / 0.35)); this.py += (this.my - this.py) * (1 - Math.exp(-dt / 0.35));
      const q = `${(this.px * 8) | 0},${(this.py * 8) | 0}`;
      if (q !== this.pq) {
        this.pq = q;
        this.LA.style.translate = `${(this.px * 4).toFixed(2)}px ${(this.py * 4).toFixed(2)}px`;
        this.LB.style.translate = `${(-this.px * 2.5).toFixed(2)}px ${(-this.py * 2.5).toFixed(2)}px`;
        this.L1.style.translate = `${(this.px * 1.5).toFixed(2)}px ${(this.py * 1.5).toFixed(2)}px`;
        if (this.onParallax) this.onParallax(this.px, this.py);
      }
    }

    // outer degree scale: ticks ratchet left / right in irregular jerks (labels stay put)
    if (!this.reduced) {
      if (st === 'ERROR') this.tkT = this.tkA;
      else if (now >= this.tkNext) {
        const busy = st === 'STANDBY' ? 1 : 0.55;
        const dir = Math.random() < 0.62 ? (this.tkT > this.tkA ? 1 : -1) : -(this.tkT > this.tkA ? 1 : -1);
        const amt = Math.random() < 0.25 ? 18 + Math.random() * 30 : 3 + Math.random() * 12;
        this.tkT += dir * amt;
        if (Math.abs(this.tkT) > 80) this.tkT *= -0.55;
        this.tkNext = now + (Math.random() < 0.3 ? 90 + Math.random() * 220 : 350 + Math.random() * 1500) * busy;
      }
      const acc = (this.tkT - this.tkA) * 210 - this.tkV * 15; // under-damped spring: quick snap, small overshoot
      this.tkV += acc * dt; this.tkA += this.tkV * dt;
      const q = this.tkA.toFixed(2);
      if (q !== this.tkQ) { this.tkQ = q; const t = `rotate(${q}deg)`; this.tk1.style.transform = t; this.tk2.style.transform = t; this.tk3.style.transform = t; }
    }
    this.LA.style.transform = `rotate(${this.angA.toFixed(2)}deg) scale(${this.scl.toFixed(4)})`;
    this.LB.style.transform = `rotate(${this.angB.toFixed(2)}deg) scale(${this.scl.toFixed(4)})`;

    // orange arcs react to the real level / state (quantised so the DOM isn't touched every frame)
    const lvl = st === 'LISTENING' ? clamp(lvlIn * 1.7, 0, 1) : st === 'SPEAKING' ? clamp(lvlIn * 1.4, 0, 1) : 0;
    this.lvl = lvl;
    const lenA = Math.round((st === 'THINKING' ? 118 : 56 + Math.round((lvl * 70) / 4) * 4) * this.arcK);
    const lenB = Math.round((st === 'ERROR' ? 30 : 48 + Math.round((lvl * 60) / 4) * 4) * this.arcK);
    const startA = -78 - (lenA - 62) / 2, startB = 160 - (lenB - 52) / 2;
    if (this.aOr.__l !== lenA) { this.aOr.__l = lenA; arcDash(this.aOr, startA, lenA); }
    if (this.bOr.__l !== lenB) { this.bOr.__l = lenB; arcDash(this.bOr, startB, lenB); }
    const br = Math.round((52 + Math.round((lvl * 36) / 4) * 4) * this.arcK);
    if (this.brL.__l !== br) { this.brL.__l = br; arcDash(this.brL, 180 - br / 2, br); arcDash(this.brR, -br / 2, br); }

    // data satellites: speed follows real activity; they gather at the top while TRANSCRIBING
    for (let i = 0; i < 4; i++) {
      if (st === 'TRANSCRIBING') { const tgt = -90 + (i - 1.5) * 9; this.satAng[i] += angDiff(this.satAng[i], tgt) * (1 - Math.exp(-dt / 0.45)); }
      else if (!this.reduced) this.satAng[i] = (this.satAng[i] + (SAT[st] || 0) * SAT_DIR[i] * (1 + i * 0.12) * dt) % 360;
      const [sx, sy] = pt(211, this.satAng[i]);
      this.sats[i].setAttribute('cx', f1(sx)); this.sats[i].setAttribute('cy', f1(sy));
    }

    // block ring targets from real signals
    const n = this.nBlocks, bt = this.blockTgt, bv = this.blockVal;
    if (st === 'ERROR') {
      for (let i = 0; i < n; i++) bt[i] = now - this.errAt > 60 + i * 28 ? 0 : 1;
    } else if (st === 'TRANSCRIBING') {
      this.sweepT += dt * 26;
      for (let i = 0; i < n; i++) { const d = (((i - this.sweepT) % n) + n) % n; bt[i] = d < 9 ? 1 - d / 9 : 0; }
    } else if (st === 'LISTENING' || st === 'SPEAKING') {
      const frac = lvl * n;
      for (let i = 0; i < n; i++) bt[i] = i < frac ? 1 : i < frac + 1 ? frac - Math.floor(frac) : 0;
    } else { for (let i = 0; i < n; i++) bt[i] = 0; }
    if (this.rip) { // a card docked: a brightness ripple runs around the ring from that node
      const age = (now - this.rip.t0) / 1000;
      if (age > 0.9) this.rip = null;
      else {
        const front = age * 540, step = 360 / n;
        for (let i = 0; i < n; i++) {
          const d = Math.abs(angDiff(-90 - (i + 1) * step, this.rip.a));
          bt[i] = Math.max(bt[i], Math.exp(-Math.pow((d - front) / 24, 2)) * (1 - age / 0.9) * 0.95);
        }
      }
    }
    if (!this.booting) {
      const kb = 1 - Math.exp(-dt / (st === 'ERROR' ? 0.06 : 0.14));
      for (let i = 0; i < n; i++) {
        const v = bv[i] + (bt[i] - bv[i]) * kb;
        if (Math.abs(v - bv[i]) > 0.004) { bv[i] = v; this.blockEl[i].style.opacity = (0.12 + 0.88 * v).toFixed(3); }
      }
    }

    // data band: micro-tick length follows the real FFT bands
    const fresh = now - this.bandsAt < 250;
    if (now - this.bandAt > 33 && (fresh || this.band.__live)) {
      this.bandAt = now;
      const N = 120, r0 = 175;
      let d = '';
      for (let t = 0; t < N; t++) {
        const u = t / N, s = u < 0.5 ? u * 2 : (1 - u) * 2, b = Math.min(15, Math.floor(s * 16));
        const lv = fresh ? this.bands[b] : 0, a = -90 + u * 360;
        const [x1, y1] = pt(r0, a), [x2, y2] = pt(r0 + 2.2 + 11 * lv, a);
        d += `M${f1(x1)} ${f1(y1)}L${f1(x2)} ${f1(y2)}`;
      }
      this.band.setAttribute('d', d);
      this.band.__live = fresh;
    }

    // follow-up window arc
    if (this.follow) {
      const frac = Math.max(0, 1 - (now - this.follow.at) / this.follow.ms);
      this.followArc.setAttribute('opacity', frac > 0 ? '0.75' : '0');
      this.followArc.setAttribute('stroke-dasharray', `${(frac * 100).toFixed(1)} 100`);
    }
  }

  // ---------- boot hooks (ui/hud-boot.js) ----------
  setBootArc(v) { this.arcK = v; }
  setBooting(b) { this.booting = !!b; }
  resyncBlocks() { for (let i = 0; i < this.blockEl.length; i++) this.blockEl[i].style.opacity = (0.12 + 0.88 * this.blockVal[i]).toFixed(3); }
  parts() {
    return {
      gs: this.gs, LA: this.LA, LB: this.LB, L1: this.L1, L2: this.L2, emb: this.emb, flash: this.flash, shock: this.shock,
      tk1: this.tk1, tk2: this.tk2, tk3: this.tk3, tickLines: this.tickLines, guides: this.guides, root: this.root, nodeG: this.nodeG, outer: this.outer,
    };
  }
}
