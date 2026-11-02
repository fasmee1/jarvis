// ARC style reactor — a calm, soft-cyan circular HUD with "J.A.R.V.I.S" in the middle.
// One SVG in the 720 px core box (centre 0,0 = stage 960,540; outer ring R = 380). Every element lives in its own
// radial band. Angles: 0 = 3 o'clock, clockwise; ck(h, m) converts an o'clock position.
// Motion rule: uniform layers (the dial) may turn; asymmetric clusters only oscillate a few degrees, so the
// composition never changes. Same small API as the calm canvas core and the HUD reactor.

const NS = 'http://www.w3.org/2000/svg';
const RAD = Math.PI / 180;
const VIEWBOX = '-360 -360 720 720';
const R = 380;

const P = (r, a) => [r * Math.cos(a * RAD), r * Math.sin(a * RAD)];
const f = (n) => n.toFixed(1);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Angle of h:mm o'clock; with `wrap` a result below 0 is pushed past 360 so ranges crossing 12 keep increasing. */
const ck = (h, m = 0, wrap = false) => { const a = ((h % 12) + m / 60) * 30 - 90; return wrap && a < 0 ? a + 360 : a; };

const mk = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
/** Arc of radius r from a1 to a2 (clockwise when a2 > a1). */
const arcD = (r, a1, a2) => {
  const [x1, y1] = P(r, a1), [x2, y2] = P(r, a2);
  return `M${f(x1)} ${f(y1)}A${r} ${r} 0 ${Math.abs(a2 - a1) > 180 ? 1 : 0} ${a2 >= a1 ? 1 : 0} ${f(x2)} ${f(y2)}`;
};
const sectorD = (r1, r2, a1, a2) => {
  const [ax, ay] = P(r2, a1), [bx, by] = P(r2, a2), [cx, cy] = P(r1, a2), [dx, dy] = P(r1, a1);
  return `M${f(ax)} ${f(ay)}A${r2} ${r2} 0 0 1 ${f(bx)} ${f(by)}L${f(cx)} ${f(cy)}A${r1} ${r1} 0 0 0 ${f(dx)} ${f(dy)}Z`;
};

function normState(st) {
  switch (st) {
    case 'LISTENING': case 'FOLLOW_UP': case 'WAKE_DETECTED': return 'LISTENING';
    case 'TRANSCRIBING': case 'THINKING': case 'TOOL_RUNNING': return 'THINKING';
    case 'STREAMING': case 'SPEAKING': return 'SPEAKING';
    case 'ERROR': return 'ERROR';
    default: return 'STANDBY';
  }
}

// per state: dial period (s per turn), sweep period (s), shimmer interval (ms)
const PACE = {
  STANDBY: { dial: 160, sweep: 9, wave: 4000 },
  LISTENING: { dial: 160, sweep: 9, wave: 4000 },
  THINKING: { dial: 40, sweep: 3, wave: 1200 },
  SPEAKING: { dial: 160, sweep: 9, wave: 4000 },
  ERROR: { dial: 600, sweep: 30, wave: 6000 },
};

export class ArcReactor {
  /** @param {HTMLElement} wrap #core-wrap */
  constructor(wrap) {
    this.wrap = wrap;
    this.active = false;
    this.reduced = false;
    this.booting = false;
    this.state = 'STANDBY';
    this.level = 0;
    this.lvl = 0; // smoothed level used by the visuals
    this.t = 0;
    this.dialA = 0;
    this.sweepA = 0;
    this.dialRate = 360 / 160;
    this.sweepRate = 360 / 9;
    this.heroK = 0;
    this.meterL = 0.72;
    this.waveAt = -1e9;
    this.rippleAt = -1e9;
    this.tiltX = 0; this.tiltY = 0; this.mx = 0; this.my = 0;
    this.osc = []; // { g, amp, per, ph }
    this.pills = []; this.trail = []; this.blocks = [];
    this._build();
    addEventListener('mousemove', (e) => { this.mx = (e.clientX / innerWidth - 0.5) * 2; this.my = (e.clientY / innerHeight - 0.5) * 2; });
    initOverlay();
  }

  /** a group that oscillates ±amp degrees every `per` seconds, starting at phase `ph` (radians) */
  _osc(parent, amp, per, ph = 0) {
    const g = mk('g', {}, parent);
    this.osc.push({ g, amp, per, ph });
    return g;
  }

  _build() {
    const root = (this.root = document.createElement('div'));
    root.className = 'arc-reactor';
    root.hidden = true;
    this.wrap.prepend(root);
    const svg = (this.svg = mk('svg', { class: 'arc-lyr', viewBox: VIEWBOX, 'aria-hidden': 'true' }, root));
    const defs = mk('defs', {}, svg);
    defs.innerHTML = `<filter id="arc-glow" filterUnits="userSpaceOnUse" x="-420" y="-420" width="840" height="840" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="a"/><feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b"/>
      <feComponentTransfer in="a" result="a2"><feFuncA type="linear" slope=".55"/></feComponentTransfer>
      <feComponentTransfer in="b" result="b2"><feFuncA type="linear" slope=".3"/></feComponentTransfer>
      <feMerge><feMergeNode in="b2"/><feMergeNode in="a2"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <filter id="arc-glow-hero" filterUnits="userSpaceOnUse" x="-420" y="-420" width="840" height="840" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="c"/><feComponentTransfer in="c" result="c2"><feFuncA type="linear" slope=".2"/></feComponentTransfer>
      <feMerge><feMergeNode in="c2"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
    const G = mk('g', { class: 'arc-glow', filter: 'url(#arc-glow)' }, svg);
    // lists for the boot (ui/arc-boot.js): stroke paths that draw in, things that fade in, the core strokes, the bars
    const parts = (this.parts = { draw: [], fade: [], core: [], bars: [], flick: [] });
    const st = (cls, d, w, o, list, parent) => { // a stroked path registered for the boot
      const e = mk('path', { class: cls, d, 'stroke-width': w, opacity: o }, parent);
      if (list) list.push(e);
      if (list === parts.draw) e.setAttribute('pathLength', '1');
      return e;
    };
    const dots = (r, a1, a2, step, w, o, cls, parent) => { // a row of round dots, as one path
      let d = '';
      for (let a = a1; a <= a2 + 0.01; a += step) { const [x, y] = P(r, a); d += `M${f(x)} ${f(y)}h0.01`; }
      const e = mk('path', { class: `s ${cls} rnd`, d, 'stroke-width': w, opacity: o }, parent);
      parts.fade.push(e);
      return e;
    };

    // ---- scan sweep: a faint wedge between r200 and r345 (the one asymmetric thing that turns)
    this.sweep = mk('g', {}, G);
    for (let i = 0; i < 8; i++) mk('path', { class: 'fm', d: sectorD(200, 345, i * 3.1, (i + 1) * 3.1 + 0.1), opacity: f(0.01 + 0.07 * (i / 7) ** 1.5) }, this.sweep); // fades out behind the leading edge

    // ---- fixed rings and marks
    const ring = mk('g', {}, G);
    const c380 = mk('circle', { class: 's m', r: R, 'stroke-width': 1, opacity: 0.55, pathLength: 1 }, ring);
    parts.draw.push(c380);
    st('s d', arcD(340, ck(8), ck(10)), 1, 0.4, parts.draw, ring);
    st('s d', arcD(340, ck(1), ck(5)), 1, 0.4, parts.draw, ring);
    parts.draw.push(mk('circle', { class: 's d', r: 290, 'stroke-width': 1, opacity: 0.35, pathLength: 1 }, ring));
    dots(342, ck(11, 45), ck(12, 25, true), 2, 2, 0.45, 'd', ring); // top dotted line
    dots(315, ck(8, 30), ck(9, 30), 4, 2, 0.4, 'd', ring); // left dots

    // ---- bottom ticks and the square trail (each oscillates a little)
    const ticks = this._osc(G, 2, 20, 1.1);
    let tk = '';
    for (let a = 45; a <= 140; a += 5) { const [x1, y1] = P(326, a), [x2, y2] = P(332, a); tk += `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`; }
    st('s d', tk, 1, 0.4, parts.fade, ticks);
    const trail = this._osc(G, 3, 16, 2.3);
    for (let i = 0; i < 12; i++) {
      const k = i / 11, a = ck(4) + k * (ck(5, 30) - ck(4)), s = 10 - k * 5, [x, y] = P(315, a);
      const e = mk('rect', { class: 'fm', x: -s / 2, y: -s / 2, width: s, height: s, opacity: f(0.8 - k * 0.7), transform: `translate(${f(x)} ${f(y)}) rotate(${f(a + 90)})` }, trail);
      e.__o = 0.8 - k * 0.7;
      this.trail.push(e); parts.fade.push(e);
    }

    // ---- bold outer bars (oscillate together) and the hero arc
    const bars = this._osc(G, 2, 22, 0.4);
    const bar = (r, a1, a2, w) => { const e = st('s m rnd', arcD(r, a1, a2), w, 0.75, parts.draw, bars); parts.bars.push(e); return e; };
    bar(378, ck(11, 40), ck(12, 5, true), 7);
    { const a1 = ck(1, 20), a2 = ck(1, 45), gap = (3 / 384) / RAD, piece = (a2 - a1 - 2 * gap) / 3; for (let i = 0; i < 3; i++) bar(384, a1 + i * (piece + gap), a1 + i * (piece + gap) + piece, 7); }
    bar(378, ck(10), ck(10, 40), 7);
    bar(372, ck(5, 20), ck(6, 30), 7);
    parts.flick = parts.bars.slice(0, 4);
    this.hero = mk('g', { filter: 'url(#arc-glow-hero)' }, bars);
    { // right hero arc 1:50 → 5:00: a filled path, 8 px at 3:00, tapering to 3 px at both ends
      const a1 = ck(1, 50), a2 = ck(5), u0 = (0 - a1) / (a2 - a1), n = 48, out = [], inn = [];
      for (let i = 0; i <= n; i++) {
        const u = i / n, a = a1 + u * (a2 - a1);
        const w = 3 + 5 * (u < u0 ? Math.sin((Math.PI / 2) * (u / u0)) : Math.cos((Math.PI / 2) * ((u - u0) / (1 - u0))));
        out.push(P(376 + w / 2, a)); inn.push(P(376 - w / 2, a));
      }
      const xy = (p) => `${f(p[0])} ${f(p[1])}`;
      this.heroPath = mk('path', { class: 'fh', d: `M${out.map(xy).join('L')}L${inn.reverse().map(xy).join('L')}Z`, opacity: 0.8 }, this.hero);
      parts.fade.push(this.heroPath);
    }

    // ---- top bracket band (±4° / 14 s): two hairline arcs, 45° chamfered ends, a 6 px notch at 11:00
    const band = this._osc(G, 4, 14, 0);
    const b0 = ck(10, 20), b1 = ck(2, 10, true), bn = ck(11), dA = (14 / 243) / RAD, dB = (8 / 240) / RAD, nA = (6 / 247) / RAD;
    const pt = (r, a) => `${f(P(r, a)[0])} ${f(P(r, a)[1])}`;
    const outline = `M${pt(236, b0)}A236 236 0 0 1 ${pt(236, b1)}L${pt(244, b1 - dB)}A244 244 0 0 0 ${pt(244, bn)}L${pt(250, bn - nA)}A250 250 0 0 0 ${pt(250, b0 + dA)}Z`;
    parts.draw.push(mk('path', { class: 's m', d: outline, 'stroke-width': 1, opacity: 0.75, pathLength: 1 }, band));
    let bt = '';
    for (let a = b0 + dA + 1; a < b1 - dB - 0.5; a += 1.5) { const [x1, y1] = P(237, a), [x2, y2] = P(a < bn ? 249 : 243, a); bt += `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`; }
    st('s d', bt, 1, 0.4, parts.fade, band);

    // ---- middle band: top block + lower-left soft arc (fixed)
    const mid = mk('g', {}, G);
    parts.fade.push(mk('path', { class: 'fm', d: sectorD(270, 298, ck(11, 40), ck(12, 40, true)), opacity: 0.3 }, mid));
    parts.draw.push(mk('path', { class: 's h', d: arcD(298, ck(11, 40), ck(12, 40, true)), 'stroke-width': 2, opacity: 0.7, pathLength: 1 }, mid));
    const sa = (ck(7, 50) - ck(7)) / 10;
    for (let k = 0; k < 10; k++) { // both ends fade out
      const a1 = ck(7) + k * sa;
      st('s m', arcD(290, a1, a1 + sa + 0.3), 11, f(0.45 * Math.pow(Math.sin((Math.PI * (k + 0.5)) / 10), 0.8)), parts.fade, mid);
    }

    // ---- data band: pill chains (±3° / 18 s, the other way), five dots, the left meter
    const pills = this._osc(G, -3, 18, 0.9);
    const pill = (r, a, list) => {
      const [x, y] = P(r, a);
      const e = mk('rect', { class: 's m', x: -5, y: -8, width: 10, height: 16, rx: 4, 'stroke-width': 1.6, opacity: 0.75, transform: `translate(${f(x)} ${f(y)}) rotate(${f(a + 90)})` }, pills);
      list.push(e); parts.fade.push(e);
    };
    const chain = (r, a1, a2, n, list) => { for (let i = 0; i < n; i++) pill(r, a1 + (i * (a2 - a1)) / (n - 1), list); };
    chain(212, ck(12, 5, true), ck(3, 15) + 360, 20, this.pills); // top chain
    chain(196, ck(7, 40), ck(5, 20), 17, []); // bottom chain
    for (let a = ck(1); a <= ck(1, 40) + 0.1; a += 5) { const [x, y] = P(198, a); parts.fade.push(mk('circle', { class: 'fm', cx: f(x), cy: f(y), r: 1.75, opacity: 0.75 }, pills)); }

    const meter = mk('g', {}, G);
    const m0 = ck(8, 10), m1 = ck(10, 30);
    parts.fade.push(mk('path', { class: 's d', d: sectorD(190, 214, m0, m1), 'stroke-width': 1, opacity: 0.45 }, meter));
    const step = (m1 - m0 - 2) / 16, gapA = (2 / 202) / RAD;
    for (let j = 0; j < 16; j++) { // j = 0 is the bottom block
      const lo = m0 + 1 + j * step;
      this.blocks.push(mk('path', { class: j >= 11 ? 'fh' : 'fm', d: sectorD(192, 212, lo, lo + step - gapA), opacity: 0.1 }, meter));
    }
    parts.meter = this.blocks;

    // ---- dial (the only layer that turns: 160 s per turn)
    const dial = (this.dial = mk('g', {}, G));
    let dd = '';
    for (let a = 0; a < 360; a += 3) {
      if (a % 15 === 0) { const [x1, y1] = P(174, a), [x2, y2] = P(182, a); dd += `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`; } else { const [x, y] = P(178, a); dd += `M${f(x)} ${f(y)}h0.01`; }
    }
    mk('path', { class: 's d rnd', d: dd, 'stroke-width': 1.5, opacity: 0.45 }, dial);
    mk('circle', { class: 's d', r: 195, 'stroke-width': 1, opacity: 0.35 }, dial);
    parts.dial = dial;

    // ---- core: 7 px ring with four tiny notches, 10 px bulges, a hairline companion arc; breathes, swells with the voice
    this.coreG = mk('g', { filter: 'url(#arc-glow-hero)' }, G);
    this.halo = mk('g', { class: 'arc-halo' }, this.coreG);
    parts.fade.push(this.halo);
    const core = (this.core = mk('g', { class: 'arc-core' }, this.coreG));
    const notchAt = [ck(1, 30), ck(4, 30), ck(7, 30), ck(11)].map((a) => (a + 360) % 360).sort((a, b) => a - b);
    notchAt.forEach((c, i) => {
      const s = c + 2, e = (i + 1 < notchAt.length ? notchAt[i + 1] : notchAt[0] + 360) - 2;
      mk('path', { class: 's h', d: arcD(150, s, e), 'stroke-width': 7, opacity: 0.5 }, this.halo);
      const p = mk('path', { class: 's h', d: arcD(150, s, e), 'stroke-width': 7, opacity: 0.9, pathLength: 1 }, core);
      parts.core.push(p);
    });
    for (const [a1, a2] of [[ck(9), ck(10)], [ck(5, 30), ck(6, 30)]]) {
      parts.core.push(mk('path', { class: 's h', d: arcD(150, a1, a2), 'stroke-width': 10, opacity: 0.9, pathLength: 1 }, core));
    }
    parts.fade.push(mk('path', { class: 's h', d: arcD(161, ck(10), ck(1, 0, true)), 'stroke-width': 1, opacity: 0.6 }, core));

    // ---- ripples (speaking): rings r240 and r290
    this.ripples = [240, 290].map((r) => mk('circle', { class: 's d', r, 'stroke-width': 1, opacity: 0 }, G));

    // ---- text
    const txt = (this.title = mk('text', { class: 'arc-name', x: -2, y: 2, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, svg));
    txt.textContent = 'J.A.R.V.I.S';
    this._setMeter(this.meterL);
  }

  _setMeter(L) {
    for (let j = 0; j < 16; j++) {
      const lit = clamp(L * 16 - j, 0, 1), base = j >= 11 ? 0.9 : 0.55 + 0.35 * (j / 10);
      const o = (base * (0.12 + 0.88 * lit)).toFixed(2);
      if (this.blocks[j].__q !== o) { this.blocks[j].__q = o; this.blocks[j].setAttribute('opacity', o); }
    }
  }

  // ---------- API shared with the other cores ----------
  setActive(on) { this.active = !!on; this.root.hidden = !on; }
  setReduced(on) { this.reduced = !!on; }
  setQuality() {}
  setStyle() {}
  resize() {}
  setFrozen() {}
  pulseActivity() {}
  wake() {}
  setFollow() {}
  setNodes() {}
  flashNode() {}
  holdNode() {}
  setHover() {}
  setDocked() {}

  setState(appState) {
    const s = normState(appState);
    if (s === this.state) return;
    this.state = s;
    this.root.classList.toggle('err', s === 'ERROR');
  }

  setSignals({ level } = {}) {
    if (level != null) this.level = clamp(level, 0, 1);
  }

  frame(now, dt) {
    if (!this.active) return;
    const st = this.state, pace = PACE[st] || PACE.STANDBY;
    this.t += dt;
    const live = st === 'LISTENING' || st === 'SPEAKING';
    this.lvl += ((live ? this.level : 0) - this.lvl) * (1 - Math.exp(-dt / 0.12));
    const still = this.reduced || this.booting;

    // states crossfade: every rate eases over ~0.4 s
    const k = 1 - Math.exp(-dt / 0.15);
    this.dialRate += (360 / pace.dial - this.dialRate) * k;
    this.sweepRate += (360 / pace.sweep - this.sweepRate) * k;
    this.heroK += ((st === 'LISTENING' ? 1 : 0) - this.heroK) * k;

    if (!still) {
      this.dialA = (this.dialA + this.dialRate * dt) % 360;
      this.sweepA = (this.sweepA + this.sweepRate * dt) % 360;
      this.dial.setAttribute('transform', `rotate(${this.dialA.toFixed(2)})`);
      this.sweep.setAttribute('transform', `rotate(${this.sweepA.toFixed(2)})`);
      for (const o of this.osc) o.g.setAttribute('transform', `rotate(${(o.amp * Math.sin((this.t / o.per) * 2 * Math.PI + o.ph)).toFixed(2)})`);
    }
    this.sweep.setAttribute('visibility', this.reduced ? 'hidden' : 'visible');

    // core swells with the voice while speaking
    const scq = (st === 'SPEAKING' && !this.reduced ? 1 + 0.025 * this.lvl : 1).toFixed(3);
    if (scq !== this._scq) { this._scq = scq; this.core.setAttribute('transform', `scale(${scq})`); this.halo.setAttribute('transform', `scale(${scq})`); }

    // hero arc: +10 % while listening
    const ho = (0.8 + 0.1 * this.heroK).toFixed(2);
    if (ho !== this._ho) { this._ho = ho; this.heroPath.setAttribute('opacity', ho); }

    // meter: wanders between 60 % and 85 % (smoothed noise); follows the mic while listening
    const noise = 0.725 + 0.125 * (0.6 * Math.sin(this.t * 0.31) + 0.4 * Math.sin(this.t * 0.83 + 1.3));
    const target = st === 'LISTENING' ? clamp(this.level, 0, 1) : noise;
    this.meterL += (target - this.meterL) * (1 - Math.exp(-dt / (st === 'LISTENING' ? 0.12 : 0.6)));
    if (!this.booting) this._setMeter(this.meterL);

    if (!still) {
      // data shimmer: each pill of the top chain brightens in turn (180 ms each)
      if (now - this.waveAt > pace.wave) this.waveAt = now;
      this.pills.forEach((p, i) => {
        const on = now - this.waveAt - i * 40, lit = on >= 0 && on < 180;
        if (lit !== p.__lit) { p.__lit = lit; p.setAttribute('class', lit ? 's h' : 's m'); p.setAttribute('opacity', lit ? '0.9' : '0.75'); }
      });
      // square trail: an opacity wave flows outward every 3 s
      const ph = ((now / 3000) % 1) * 1.6 - 0.3;
      this.trail.forEach((e, i) => {
        const bump = Math.max(0, 1 - Math.abs(i / 11 - ph) / 0.18);
        const o = Math.min(0.9, e.__o * (1 + 0.8 * bump)).toFixed(2);
        if (o !== e.__q) { e.__q = o; e.setAttribute('opacity', o); }
      });
    }

    // ripples (speaking): rings r240 / r290 swell 1 → 1.06 while fading 0.3 → 0 over 1.2 s
    if (!still && st === 'SPEAKING' && now - this.rippleAt > 1500) this.rippleAt = now;
    const age = (now - this.rippleAt) / 1200;
    for (const c of this.ripples) {
      if (still || age < 0 || age > 1) { if (c.__q !== '0') { c.__q = '0'; c.setAttribute('opacity', '0'); } continue; }
      c.__q = 'x';
      c.setAttribute('transform', `scale(${(1 + 0.06 * age).toFixed(3)})`);
      c.setAttribute('opacity', (0.3 * (1 - age)).toFixed(3));
    }

    // tilt with the mouse: max 3°, 600 ms lerp (the whole HUD together)
    if (!this.reduced && !this.booting) {
      const kt = 1 - Math.exp(-dt / 0.6);
      this.tiltX += (-this.my * 3 - this.tiltX) * kt; this.tiltY += (this.mx * 3 - this.tiltY) * kt;
      const q = `${this.tiltX.toFixed(2)},${this.tiltY.toFixed(2)}`;
      if (q !== this._tq) { this._tq = q; this.root.style.transform = `perspective(1400px) rotateX(${this.tiltX.toFixed(2)}deg) rotateY(${this.tiltY.toFixed(2)}deg)`; }
    }
  }

  // ---------- boot hooks (ui/arc-boot.js) ----------
  bootParts() {
    return { root: this.root, parts: this.parts, title: this.title, dial: this.dial };
  }

  setBooting(b) {
    this.booting = !!b;
    if (b) { this.root.style.transform = ''; this._tq = ''; }
  }
}

// ---------- dev overlay: key O shows renderer/dev/arc-reference.png over the HUD; [ and ] change its opacity ----------
// Off unless localStorage 'jarvis.dev' is '1', so a normal run never listens for these keys.
function initOverlay() {
  let on = false;
  try { on = localStorage.getItem('jarvis.dev') === '1'; } catch { /* storage unavailable */ }
  if (!on) return;
  let img = null, op = 0.5;
  addEventListener('keydown', (e) => {
    const t = e.target;
    if (document.documentElement.dataset.style !== 'arc' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'o' || e.key === 'O') {
      if (img) { img.remove(); img = null; return; }
      img = document.createElement('img');
      img.id = 'arc-ref-overlay';
      img.src = new URL('../dev/arc-reference.png', import.meta.url).href;
      img.alt = '';
      img.addEventListener('error', () => { if (img) img.remove(); img = null; });
      document.body.appendChild(img);
      img.style.opacity = String(op);
    } else if (img && (e.key === '[' || e.key === ']')) {
      op = clamp(op + (e.key === ']' ? 0.1 : -0.1), 0.1, 1);
      img.style.opacity = op.toFixed(2);
    }
  });
}
