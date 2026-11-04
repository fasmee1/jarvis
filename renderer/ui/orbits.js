// Calm style: Saturn-like orbital navigation. Three wide, tilted elliptical orbits
// around the core carry one satellite per card. The back half of every orbit passes
// behind the reactor, the front half in front of it. Clicking a satellite opens its
// card (docking.js does the open / fold animation along the energy line, which
// cards.js draws from the card to the moving satellite).
//
// The math (orbitPoint, satAngle) is pure; OrbitLayer owns the SVG + hit buttons.

import { CORE } from './layout.js';
import { ICONS, NAMES } from './cards.js';

const NS = 'http://www.w3.org/2000/svg';
const D2R = Math.PI / 180;

// rx / ry in stage px, rot in degrees (svg rotate), speed in degrees per second
export const ORBITS = [
  { rx: 470, ry: 190, rot: -5, speed: 5.2 },
  { rx: 602, ry: 226, rot: -4, speed: -3.6 },
  { rx: 735, ry: 262, rot: -3, speed: 2.5 },
];
// every card has one satellite; satellites on one orbit are evenly spaced (phase in degrees)
export const SATS = [
  { id: 'mic', orbit: 0, phase: 20 },
  { id: 'tts', orbit: 0, phase: 200 },
  { id: 'reply', orbit: 1, phase: 70 },
  { id: 'step', orbit: 1, phase: 190 },
  { id: 'camera', orbit: 1, phase: 310 },
  { id: 'latency', orbit: 2, phase: 130 },
  { id: 'tokens', orbit: 2, phase: 250 },
  { id: 'edit', orbit: 2, phase: 10 },
];

/** Point on an orbit at angle theta (deg). depth: -1 far (top, behind the core) … 1 near (bottom, in front). */
export function orbitPoint(o, theta, c = CORE) {
  const t = theta * D2R;
  const ex = Math.cos(t) * o.rx;
  const ey = Math.sin(t) * o.ry;
  const r = o.rot * D2R;
  return {
    x: c.x + ex * Math.cos(r) - ey * Math.sin(r),
    y: c.y + ex * Math.sin(r) + ey * Math.cos(r),
    depth: Math.sin(t),
  };
}

/** Satellite angle (deg) after `elapsed` seconds of orbiting. */
export function satAngle(sat, elapsed) {
  return (((sat.phase + ORBITS[sat.orbit].speed * elapsed) % 360) + 360) % 360;
}

function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

const TRAIL = 26; // degrees of trail behind each satellite
const TRAIL_N = 12;

export class OrbitLayer {
  /** @param {{ stage: HTMLElement, onPick: (id: string) => void }} o */
  constructor({ stage, onPick }) {
    this.onPick = onPick;
    this.elapsed = 0;
    this.reduced = false;
    this.active = false;
    this.open = new Set();
    this.hover = null;
    this.flash = new Map(); // orbit index → highlight end time (ms)

    const wrap = stage.querySelector('#core-wrap');
    this.back = svgEl('svg', { class: 'stage-svg orbit-layer orbit-back', viewBox: '0 0 1920 1080', 'aria-hidden': 'true' });
    this.front = svgEl('svg', { class: 'stage-svg orbit-layer orbit-front', viewBox: '0 0 1920 1080', 'aria-hidden': 'true' });
    stage.querySelector('#leaders').before(this.back);
    wrap.after(this.front);
    this.hits = document.createElement('div');
    this.hits.className = 'orbit-hits';
    stage.querySelector('#cards').after(this.hits);

    for (const svg of [this.back, this.front]) {
      const defs = svgEl('defs', {}, svg);
      const g = svgEl('radialGradient', { id: `${svg === this.back ? 'b' : 'f'}-sat-glow` }, defs);
      svgEl('stop', { offset: '0', 'stop-color': '#70DFFF', 'stop-opacity': '0.55' }, g);
      svgEl('stop', { offset: '1', 'stop-color': '#20B8FF', 'stop-opacity': '0' }, g);
    }

    // orbit paths: the full ellipse behind the core, its near (lower) half again in front
    this.paths = ORBITS.map((o, i) => {
      const tf = `rotate(${o.rot} ${CORE.x} ${CORE.y})`;
      const back = svgEl('ellipse', { class: `orb-path o${i}`, cx: CORE.x, cy: CORE.y, rx: o.rx, ry: o.ry, transform: tf }, this.back);
      const half = `M${CORE.x + o.rx} ${CORE.y} A${o.rx} ${o.ry} 0 0 1 ${CORE.x - o.rx} ${CORE.y}`;
      const front = svgEl('path', { class: `orb-path o${i}`, d: half, transform: tf }, this.front);
      if (i === 2) {
        // fine technical particles: a dotted companion ring just outside the outer orbit
        svgEl('ellipse', { class: 'orb-dots', cx: CORE.x, cy: CORE.y, rx: o.rx + 22, ry: o.ry + 8, transform: tf }, this.back);
      }
      return [back, front];
    });

    this.sats = SATS.map((s) => {
      const parts = [this.back, this.front].map((svg) => {
        const p = svg === this.back ? 'b' : 'f';
        const grad = svgEl('linearGradient', { id: `${p}-trail-${s.id}`, gradientUnits: 'userSpaceOnUse' }, svg.querySelector('defs'));
        const warm = s.orbit === 2; // the outer orbit carries warm energy trails
        svgEl('stop', { offset: '0', 'stop-color': warm ? '#FF9B45' : '#20B8FF', 'stop-opacity': '0' }, grad);
        svgEl('stop', { offset: '1', 'stop-color': warm ? '#FF9B45' : '#70DFFF', 'stop-opacity': warm ? '0.55' : '0.7' }, grad);
        const trail = svgEl('path', { class: 'sat-trail', stroke: `url(#${p}-trail-${s.id})` }, svg);
        const g = svgEl('g', { class: `sat sat-${s.id}` }, svg);
        svgEl('circle', { class: 'sat-glow', r: 26, fill: `url(#${p}-sat-glow)` }, g);
        svgEl('circle', { class: 'sat-ring', r: 13 }, g);
        svgEl('circle', { class: 'sat-halo', r: 19 }, g);
        const ico = svgEl('g', { class: 'sat-ico', transform: 'translate(-6.5 -6.5) scale(0.54)' }, g);
        svgEl('path', { d: ICONS[s.id] }, ico);
        const lbl = svgEl('text', { class: 'sat-lbl', x: 24, y: 4 }, g);
        lbl.textContent = NAMES[s.id].toUpperCase();
        return { grad, trail, g, lbl };
      });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'orbit-hit';
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.onPick(s.id); });
      btn.addEventListener('mouseenter', () => { this.hover = s.id; });
      btn.addEventListener('mouseleave', () => { if (this.hover === s.id) this.hover = null; });
      btn.addEventListener('focus', () => { this.hover = s.id; });
      btn.addEventListener('blur', () => { if (this.hover === s.id) this.hover = null; });
      this.hits.append(btn);
      return { s, parts, btn, side: 1, front: null, cls: '' };
    });
    this.setActive(false);
  }

  setActive(on) {
    this.active = !!on;
    this.back.toggleAttribute('hidden', !on);
    this.front.toggleAttribute('hidden', !on);
    this.hits.hidden = !on;
  }

  setReduced(on) {
    this.reduced = !!on;
  }

  /** Which cards are open (from docking.js); a card that just opened highlights its orbit for a moment. */
  setOpen(ids) {
    const now = performance.now();
    for (const id of ids) {
      if (this.open.has(id)) continue;
      const sat = SATS.find((x) => x.id === id);
      if (sat) this.flash.set(sat.orbit, now + 1600);
    }
    this.open = new Set(ids);
    for (const t of this.sats) {
      const open = this.open.has(t.s.id);
      t.btn.setAttribute('aria-pressed', String(open));
      t.btn.setAttribute('aria-label', `${open ? 'ปิด' : 'เปิด'}การ์ด ${NAMES[t.s.id]}`);
      t.btn.title = `${NAMES[t.s.id]} — คลิกเพื่อ${open ? 'ปิด' : 'เปิด'}การ์ด`;
    }
  }

  /** Real data changed in a card: its satellite flashes warm orange once. */
  ping(id) {
    const t = this.sats.find((x) => x.s.id === id);
    if (!t || this.reduced) return;
    for (const p of t.parts) {
      p.g.classList.remove('ping');
      requestAnimationFrame(() => p.g.classList.add('ping')); // re-adding on the next frame restarts the animation
    }
  }

  /** Stage point of a card's satellite (null when the layer is off). */
  pointOf(id) {
    if (!this.active) return null;
    const t = this.sats.find((x) => x.s.id === id);
    return t && t.pos ? { x: t.pos.x, y: t.pos.y } : null;
  }

  frame(now, dt, hoveredCard) {
    if (!this.active) return;
    if (!this.reduced) this.elapsed += dt;
    const hot = this.hover || hoveredCard || null;
    const hotOrbit = hot ? SATS.find((x) => x.id === hot)?.orbit : -1;
    this.paths.forEach((pp, i) => {
      const sel = i === hotOrbit || (this.flash.get(i) || 0) > now;
      for (const p of pp) if (p.__sel !== sel) { p.__sel = sel; p.classList.toggle('sel', sel); }
    });

    for (const t of this.sats) {
      const o = ORBITS[t.s.orbit];
      const th = satAngle(t.s, this.elapsed);
      const p = orbitPoint(o, th);
      t.pos = p;
      const front = p.depth >= 0;
      const k = (p.depth + 1) / 2; // 0 far … 1 near
      const scale = 0.8 + 0.22 * k;
      const side = p.x >= CORE.x ? 1 : -1;
      const cls = `${this.open.has(t.s.id) ? ' open' : ''}${hot === t.s.id ? ' hover' : ''}`;
      // trail: a short arc behind the satellite, fading toward its tail
      const dir = Math.sign(o.speed) || 1;
      let d = '';
      for (let i = 0; i <= TRAIL_N; i++) {
        const q = orbitPoint(o, th - dir * (TRAIL * i) / TRAIL_N);
        d += `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
      }
      const tail = orbitPoint(o, th - dir * TRAIL);
      t.parts.forEach((part, idx) => {
        const mine = (idx === 1) === front;
        if (part.__shown !== mine) { part.__shown = mine; part.g.style.display = part.trail.style.display = mine ? '' : 'none'; }
        if (!mine) return;
        part.g.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) scale(${scale.toFixed(3)})`);
        part.g.setAttribute('opacity', (0.45 + 0.55 * k).toFixed(3));
        part.trail.setAttribute('d', d);
        part.grad.setAttribute('x1', tail.x.toFixed(1));
        part.grad.setAttribute('y1', tail.y.toFixed(1));
        part.grad.setAttribute('x2', p.x.toFixed(1));
        part.grad.setAttribute('y2', p.y.toFixed(1));
        if (part.__side !== side) {
          part.__side = side;
          part.lbl.setAttribute('x', String(side * 24));
          part.lbl.setAttribute('text-anchor', side > 0 ? 'start' : 'end');
        }
        if (part.__cls !== cls) {
          part.__cls = cls;
          part.g.classList.toggle('open', cls.includes('open'));
          part.g.classList.toggle('hover', cls.includes('hover'));
        }
      });
      t.btn.style.transform = `translate(${(p.x - 22).toFixed(1)}px, ${(p.y - 22).toFixed(1)}px)`;
      if (t.front !== front) { t.front = front; t.btn.classList.toggle('far', !front); }
    }
  }
}
