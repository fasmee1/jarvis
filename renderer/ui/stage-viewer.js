// The large viewer on the home HUD, shared by Camera mode and the Result Viewer.
// One viewer, many tabs (max 6, oldest dropped first); the camera is just one
// kind of tab, so there are never two large viewers at once.
//
// Opening the first tab plays one timeline (~1 s): every open card docks into
// its node (staggered), the viewer grows out of the reactor's centre
// (scale 0.1 → 1, 0.45 s) and the reactor FLIPs to the viewer's bottom-left
// corner at 0.35 scale, where it stays live and clickable. Closing the last tab
// plays it in reverse. Transforms / opacity / stroke-dashoffset only. Requests
// made while a transition runs are queued: the controller always converges on
// the latest requested state, so rapid open / close can't break it.
//
// The viewer box lives in stage px (so it lines up with the reactor), but its
// content is counter-scaled to window px: text keeps its real size at any
// window size.
//
// The same transition also drives other large surfaces (the Conversation popup,
// ui/conversation.js) registered with registerSurface(). Only one surface is on
// screen at a time: switching between two open surfaces cross-fades them while
// the cards stay docked and the reactor stays in the corner.

import { CORE } from './layout.js';
import { drawFrame, icon } from './cards.js';
import { sfx } from '../sfx.js';
import './ease.js';

const gsap = window.gsap;
const NS = 'http://www.w3.org/2000/svg';
const MINI = 0.35; // reactor scale while the viewer is open
const MINI_WEB = 0.2; // smaller badge over a live web page (the native page can't sit under it)
const R_VIS = 306; // reactor visual radius at scale 1 (stage px)
const HEAD = 48; // header height (window px)
const VCUT = 6; // same chamfer as the cards
const MAX_TABS = 6;
const DIM = ['#grid-bg', '.corner-brk', '#caption-tr', '.caption-bl'];

const WIDE_KEY = 'jarvis.viewerWide'; // "expanded" popups (all surfaces), remembered between launches
const WIDE_PAD = 8; // window px margin around an expanded popup
const WIDE_ICON = { on: 'M4 14h6v6 M20 10h-6V4 M14 10l7-7 M3 21l7-7', off: 'M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7' };

// Lucide-style 24px icons for the viewer (strokes only)
export const VICONS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.35-4.35',
  news: 'M4 22h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2 M18 14h-8 M15 18h-5 M10 6h8v4h-8z',
  youtube: 'M2.5 7.1a2.5 2.5 0 0 1 1.8-1.8C6 5 12 5 12 5s6 0 7.7.3a2.5 2.5 0 0 1 1.8 1.8C22 8.8 22 12 22 12s0 3.2-.5 4.9a2.5 2.5 0 0 1-1.8 1.8C18 19 12 19 12 19s-6 0-7.7-.3a2.5 2.5 0 0 1-1.8-1.8C2 15.2 2 12 2 12s0-3.2.5-4.9z M10 15l5-3-5-3z',
  images: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21',
  web: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  weather: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z',
  table: 'M3 3h18v18H3z M3 9h18 M3 15h18 M9 3v18',
  chart: 'M3 3v18h18 M7 15l4-4 3 3 5-6',
  text: 'M4 6h16 M4 12h16 M4 18h10',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z M9 4v14 M15 6v14',
  external: 'M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8 M21 3v5h-5',
  play: 'M7 4v16l13-8z',
  pause: 'M7 4h3v16H7z M14 4h3v16h-3z',
  reader: 'M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h5',
};

export function vicon(name, cls = 'sv-i') {
  if (name === 'camera') return icon('camera', cls);
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', cls);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', VICONS[name] || VICONS.text);
  s.append(p);
  return s;
}

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function svg(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function chamfer(w, hh, c) {
  return `polygon(${c}px 0, ${w}px 0, ${w}px ${hh - c}px, ${w - c}px ${hh}px, 0 ${hh}px, 0 ${c}px)`;
}
function iconButton(name, label, cls = '') {
  const b = h('button', `sv-btn ${cls}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(name === 'x' ? icon('x', 'x-ico') : vicon(name));
  return b;
}

export class StageViewer {
  /** @param {{ home: import('./home.js').Home }} o */
  constructor(o) {
    this.o = o;
    this.tabs = new Map(); // id → tab
    this.order = []; // tab ids in strip order
    this.cur = null;
    this.shown = null; // surface on screen: null | 'viewer' | a registered surface name
    this.extra = new Set(); // other surfaces that are open (requested)
    this.front = 'viewer'; // which one wins when the viewer and another surface are both open
    this.busy = false;
    this.seq = 0;
    this.listeners = new Set();
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.wideBtns = []; // the expand / restore button of every surface
    try { this.wide = localStorage.getItem(WIDE_KEY) === '1'; } catch { this.wide = false; }
    this._build();
    this._keys();
    addEventListener('resize', () => this._relayout());
  }

  get home() {
    return this.o.home;
  }

  get docking() {
    return this.o.home.docking;
  }

  /** Viewer open (or opening) and in front. */
  get isOpen() {
    return this.want;
  }

  /** The viewer (result / web / camera tabs) is the requested surface. */
  get want() {
    return this._target() === 'viewer';
  }

  /** The viewer is on screen (its open transition has finished). */
  get mode() {
    return this.shown === 'viewer';
  }

  /** Surface that should be on screen now. */
  _target() {
    const viewer = this.order.length > 0;
    const other = [...this.extra].pop() || null;
    if (viewer && other) return this.front === 'viewer' ? 'viewer' : other;
    return viewer ? 'viewer' : other;
  }

  /**
   * Another large surface using the same transition (cards dock, it grows out of
   * the reactor, the reactor moves to its bottom-left corner).
   * parts: { root, fill, frame, inner, head, bodies, foot }
   * hooks: { beforeShow?(), shown?(), hidden?(), focus?() }
   */
  registerSurface(name, parts, hooks = {}) {
    this.surfaces[name] = { ...parts, hooks };
    // expand / restore button, just before the surface's own close button
    if (parts.head) {
      const close = parts.head.querySelector('[id$="-close"]');
      const b = this._wideButton('cv-ctl cv-icon', 'cv-i');
      if (close) close.before(b); else parts.head.append(b);
      this._wideDblClick(parts.head);
    }
    if (this.g) this._layout(this.g);
  }

  /** Open a registered surface (it comes to the front). */
  showSurface(name) {
    if (!this.surfaces[name]) return;
    this.extra.delete(name);
    this.extra.add(name);
    this.front = name;
    this._requestMode();
  }

  hideSurface(name) {
    if (!this.extra.delete(name)) return;
    if (this.front === name) this.front = 'viewer';
    this._requestMode();
  }

  /** Bring the viewer's tabs back to the front (when it has any). */
  showViewer() {
    if (!this.order.length) return false;
    this.front = 'viewer';
    this._requestMode();
    return true;
  }

  /** A registered surface is open (it may be behind the viewer). */
  surfaceOpen(name) {
    return this.extra.has(name);
  }

  get current() {
    return this.cur ? this.tabs.get(this.cur) : null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(ev, tab) {
    for (const fn of this.listeners) { try { fn(ev, tab); } catch { /* listener error */ } }
  }

  // ---------- DOM ----------
  _build() {
    const root = h('div', 'sv');
    root.hidden = true;
    root.tabIndex = -1;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'ผลลัพธ์');
    const fill = h('div', 'sv-fill');
    const frame = svg('svg', { class: 'frame sv-frame', 'aria-hidden': 'true' });
    const inner = h('div', 'sv-inner');

    const head = h('div', 'sv-head');
    const tIco = h('span', 'sv-tico');
    const title = h('span', 'sv-title');
    const meta = h('span', 'sv-meta');
    const extras = h('span', 'sv-extras');
    const tabs = h('div', 'sv-tabs');
    tabs.setAttribute('role', 'tablist');
    const ext = iconButton('external', 'เปิดในเบราว์เซอร์', 'sv-ext');
    const wide = this._wideButton('sv-btn sv-wide');
    const x = iconButton('x', 'ปิด (Esc)', 'sv-close');
    head.append(tIco, title, meta, extras, h('span', 'sv-sp'), tabs, ext, wide, x);
    this._wideDblClick(head);

    const bodies = h('div', 'sv-bodies');
    const foot = h('div', 'sv-foot');
    const footText = h('span', 'sv-foot-text');
    const footSrc = h('span', 'sv-foot-src');
    foot.append(footText, footSrc);
    inner.append(head, bodies, foot);
    root.append(fill, frame, inner);
    document.getElementById('stage').append(root);
    this.v = { root, fill, frame, inner, head, tIco, title, meta, extras, tabs, ext, x, bodies, foot, footText, footSrc };
    this.surfaces = { viewer: { root, fill, frame, inner, head, bodies, foot, hooks: {} } };

    x.addEventListener('click', (e) => { e.stopPropagation(); this.closeAll(); });
    ext.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = this.current;
      const url = t && t.external && t.external();
      if (url && this.o.openExternal) this.o.openExternal(url);
    });
  }

  // ---------- tabs ----------
  /**
   * Open (or replace) a tab.
   * spec: { id?, kind, icon, title, meta?, extras?: Node, padded?: true, footer?: {text, sources},
   *         external?: () => url, mount(body, tab) → ctl{dispose, onShow?, onHide?}, onClose?() }
   * @returns {string} tab id
   */
  open(spec) {
    const id = spec.id || `t${++this.seq}`;
    let t = this.tabs.get(id);
    if (t) {
      this.update(id, spec);
      this.select(id);
      this.front = 'viewer';
      this._requestMode();
      return id;
    }
    t = { id, kind: spec.kind, spec: {}, openedAt: ++this.seq };
    t.body = h('div', 'sv-body');
    t.body.setAttribute('role', 'tabpanel');
    t.body.hidden = true;
    t.btn = h('button', 'sv-tab');
    t.btn.type = 'button';
    t.btn.setAttribute('role', 'tab');
    t.btnX = h('span', 'sv-tab-x');
    t.btnX.append(icon('x', 'x-ico'));
    t.btnX.setAttribute('aria-hidden', 'true');
    t.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('.sv-tab-x')) this.close(id);
      else this.select(id);
    });
    this.tabs.set(id, t);
    this.order.push(id);
    this.v.bodies.append(t.body);
    this.v.tabs.append(t.btn);
    this.update(id, spec);
    // keep at most 6 tabs: drop the oldest (the live camera only if nothing else is left)
    while (this.order.length > MAX_TABS) {
      const old = this.order.filter((k) => k !== id).sort((a, b) => {
        const ta = this.tabs.get(a);
        const tb = this.tabs.get(b);
        return (ta.kind === 'camera') - (tb.kind === 'camera') || ta.openedAt - tb.openedAt;
      })[0];
      this.close(old);
    }
    this.select(id);
    this.front = 'viewer';
    this._requestMode();
    return id;
  }

  /** Change a tab's header / footer / content (a new `mount` replaces the content). */
  update(id, patch) {
    const t = this.tabs.get(id);
    if (!t) return;
    const prevMount = t.spec.mount;
    t.spec = { ...t.spec, ...patch };
    const s = t.spec;
    t.kind = s.kind || t.kind;
    t.btn.replaceChildren(vicon(s.icon || 'text', 'sv-tab-i'), h('span', 'sv-tab-t', (s.title || '').slice(0, 22)), t.btnX);
    t.btn.title = s.title || '';
    t.body.classList.toggle('padded', s.padded !== false);
    if (patch.mount && patch.mount !== prevMount) {
      if (t.ctl && t.ctl.dispose) t.ctl.dispose();
      t.body.replaceChildren();
      t.body.scrollTop = 0;
      t.ctl = patch.mount(t.body, t) || {};
      if (this.cur === id && this.mode) this.reveal(t.body);
    }
    if (this.cur === id) this._renderHead();
  }

  select(target) {
    const id = typeof target === 'number' ? this._step(target) : target;
    const t = this.tabs.get(id);
    if (!t) return;
    const prev = this.current;
    if (prev && prev.id !== id) {
      prev.body.hidden = true;
      prev.btn.classList.remove('on');
      prev.btn.setAttribute('aria-selected', 'false');
      if (prev.ctl && prev.ctl.onHide) prev.ctl.onHide();
    }
    this.cur = id;
    t.body.hidden = false;
    t.btn.classList.add('on');
    t.btn.setAttribute('aria-selected', 'true');
    this._renderHead();
    if (t.ctl && t.ctl.onShow) t.ctl.onShow();
    if (prev && prev.id !== id && this.mode) this.reveal(t.body);
    if (prev && prev.id !== id && (prev.kind === 'web') !== (t.kind === 'web')) this._moveReactor();
    this._emit('select', t);
  }

  _step(d) {
    if (!this.order.length) return null;
    const i = this.order.indexOf(this.cur);
    return this.order[(i + d + this.order.length) % this.order.length];
  }

  /** Close one tab (dispose its content: videos stop, iframes unload). */
  close(id) {
    const t = this.tabs.get(id);
    if (!t) return;
    // a live web page first swaps itself for a screenshot (native views can't animate)
    if (t.ctl && t.ctl.freeze && !t.frozen && this.order.length === 1) {
      t.frozen = true;
      Promise.race([Promise.resolve().then(() => t.ctl.freeze()), new Promise((r) => setTimeout(r, 400))])
        .catch(() => {})
        .finally(() => this.close(id));
      return;
    }
    this.tabs.delete(id);
    this.order = this.order.filter((k) => k !== id);
    if (t.ctl && t.ctl.dispose) { try { t.ctl.dispose(); } catch { /* best effort */ } }
    t.btn.remove();
    if (this.cur === id) {
      this.cur = null;
      const next = this.order[this.order.length - 1];
      if (next) this.select(next);
    }
    const finish = () => t.body.remove();
    if (this.order.length) finish();
    else this.lastBody = t.body; // keep it visible while the viewer closes
    if (t.spec.onClose) { try { t.spec.onClose(); } catch { /* owner error */ } }
    this._emit('close', t);
    if (!this.order.length) this._requestMode();
    else this._renderHead();
  }

  closeAll() {
    for (const id of [...this.order].reverse()) this.close(id);
  }

  /** Content enters: fade + 8px slide; items (.sv-item) stagger in at 40 ms. */
  reveal(body) {
    if (!gsap || !body) return;
    if (this.reduced) {
      gsap.fromTo(body, { opacity: 0 }, { opacity: 1, duration: 0.2 });
      return;
    }
    gsap.fromTo(body, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, ease: 'calm', clearProps: 'transform' });
    const items = [...body.querySelectorAll('.sv-item')].slice(0, 14);
    if (items.length) gsap.fromTo(items, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, ease: 'calm', stagger: 0.04, clearProps: 'transform,opacity' });
  }

  _renderHead() {
    const t = this.current;
    const v = this.v;
    const s = t ? t.spec : {};
    v.tIco.replaceChildren(vicon(s.icon || 'text', 'sv-i'));
    v.title.textContent = s.title || '';
    v.meta.textContent = s.meta || '';
    v.extras.replaceChildren(...(s.extras ? [s.extras] : []));
    v.tabs.hidden = this.order.length < 2;
    v.ext.hidden = !(t && t.external && t.external()) || !!s.hideExt;
    v.root.setAttribute('aria-label', s.title ? `ผลลัพธ์: ${s.title}` : 'ผลลัพธ์');
    const f = s.footer;
    v.foot.hidden = !f || (!f.text && !f.sources);
    v.footText.textContent = f && f.text ? f.text : '';
    v.footSrc.textContent = f && f.sources ? f.sources : '';
    v.inner.classList.toggle('has-foot', !v.foot.hidden);
  }

  // ---------- expand (wide) ----------
  /** Expand every popup to (almost) the whole window, or restore the normal size. */
  setWide(on = !this.wide) {
    this.wide = !!on;
    try { localStorage.setItem(WIDE_KEY, this.wide ? '1' : '0'); } catch { /* storage unavailable */ }
    this._syncWide();
    this._relayout();
    return this.wide;
  }

  _wideButton(cls, svgCls) {
    const b = h('button', cls);
    b.type = 'button';
    const s = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', ...(svgCls ? { class: svgCls } : {}) });
    s.append(svg('path', {}));
    b.append(s);
    b.addEventListener('click', (e) => { e.stopPropagation(); this.setWide(); });
    this.wideBtns.push(b);
    this._syncWide();
    return b;
  }

  _syncWide() {
    const label = this.wide ? 'ย่อกลับขนาดปกติ (ดับเบิลคลิกหัวหน้าต่าง)' : 'ขยายเต็มจอ (ดับเบิลคลิกหัวหน้าต่าง)';
    for (const b of this.wideBtns) {
      b.title = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', String(this.wide));
      b.querySelector('path').setAttribute('d', this.wide ? WIDE_ICON.on : WIDE_ICON.off);
    }
    document.body.classList.toggle('sv-wide-on', this.wide);
  }

  /** Double-clicking an empty part of a popup's header toggles expand. */
  _wideDblClick(head) {
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, textarea, select, a, [role="tab"]')) return;
      this.setWide();
    });
  }

  // ---------- geometry ----------
  /**
   * Viewer box in stage px: 80vw × 90vh centred, never under the top-left buttons (end at 176 px);
   * expanded: the whole window less a small margin.
   */
  _geom() {
    const t = this.home.t;
    if (this.wide) {
      return {
        x: (WIDE_PAD - t.ox) / t.scale,
        y: (WIDE_PAD - t.oy) / t.scale,
        w: (innerWidth - 2 * WIDE_PAD) / t.scale,
        h: (innerHeight - 2 * WIDE_PAD) / t.scale,
      };
    }
    const left = Math.max(innerWidth * 0.1, 192);
    return {
      x: (left - t.ox) / t.scale,
      y: (innerHeight * 0.05 - t.oy) / t.scale,
      w: (innerWidth - 2 * left) / t.scale,
      h: (innerHeight * 0.9) / t.scale,
    };
  }

  _mini(surface = this.shown || this._target()) {
    if (surface !== 'viewer') return MINI;
    const t = this.current;
    return t && t.kind === 'web' ? MINI_WEB : MINI;
  }

  /** The mini reactor's circle in window px ({ cx, cy, r }), for content that must stay clear of it. */
  badge(surface) {
    const g = this.g || this._geom();
    const R = this._reactorTarget(g, surface);
    const t = this.home.t;
    return { cx: t.ox + (CORE.x + R.x) * t.scale, cy: t.oy + (CORE.y + R.y) * t.scale, r: R_VIS * R.s * t.scale };
  }

  /** Re-target the reactor (e.g. switching between a web page and another tab). */
  _moveReactor() {
    if (this.shown !== 'viewer' || this.busy) return;
    const R = this.home.cards.reactor;
    const last = this._reactorTarget(this.g || this._geom());
    document.getElementById('core-wrap').classList.toggle('mini-web', last.s === MINI_WEB);
    this._layout(this.g || this._geom());
    if (this.reduced || !gsap) { Object.assign(R, last); this.home.applyReactor(); }
    else gsap.to(R, { x: last.x, y: last.y, s: last.s, r: 0, duration: 0.35, ease: 'calm', onUpdate: () => this.home.applyReactor() });
    this.docking.floatArea = this._floatArea(this.g, last);
    this._emit('layout', this.current);
  }

  /** Reactor transform that centres it on the viewer's bottom-left corner (kept on screen). */
  _reactorTarget(g, surface) {
    const t = this.home.t;
    const mini = this._mini(surface);
    const r = R_VIS * mini;
    const minX = -t.ox / t.scale + r + 8;
    const maxY = (innerHeight - t.oy) / t.scale - r - 8;
    const cx = Math.max(g.x, minX);
    const cy = Math.min(g.y + g.h, maxY);
    return { x: cx - CORE.x, y: cy - CORE.y, s: mini, r: 0 };
  }

  _layout(g) {
    const k = this.home.t.scale;
    for (const [name, s] of Object.entries(this.surfaces)) {
      const { root, fill, frame, inner } = s;
      Object.assign(root.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
      fill.style.clipPath = chamfer(g.w, g.h, VCUT);
      drawFrame(frame, g.w, g.h, ['tl', 'br'], { size: VCUT, pad: 6, arm: 36 });
      frame.querySelector('.base').setAttribute('pathLength', '1');
      // content in window px
      Object.assign(inner.style, { width: `${g.w * k}px`, height: `${g.h * k}px`, transform: `scale(${1 / k})` });
      // the mini reactor covers the bottom-left corner: footer text starts after it
      inner.style.setProperty('--badge', `${Math.round((R_VIS * this._mini(name) + 12) * k)}px`);
    }
    this.g = g;
  }

  _floatArea(g, R) {
    const cy = CORE.y + R.y;
    return { x: g.x + 28, bottom: cy - R_VIS * R.s - 12, top: g.y + (HEAD + 16) / this.home.t.scale };
  }

  _relayout() {
    if (!this.shown) return;
    if (this.busy) {
      this.dirty = true;
      return;
    }
    const g = this._geom();
    this._layout(g);
    const R = this._reactorTarget(g, this.shown);
    Object.assign(this.home.cards.reactor, R);
    this.home.applyReactor();
    this.docking.floatArea = this._floatArea(g, R);
    this._emit('layout', this.current);
  }

  // ---------- keys ----------
  _keys() {
    addEventListener('keydown', (e) => {
      if (!this.want || !this._homeFocused()) return;
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        const t = this.current;
        if (t && t.ctl && t.ctl.escape && t.ctl.escape()) return; // e.g. a lightbox inside the tab
        this.closeAll();
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.select(e.shiftKey ? -1 : 1);
      }
    }, true);
  }

  /** Keys belong to the viewer only when nothing else (menu, section, dialog) is on top. */
  _homeFocused() {
    const hidden = (id) => { const n = document.getElementById(id); return !n || n.hidden; };
    return this.home.visible && hidden('menu') && hidden('approval') && hidden('barge') && hidden('hf-consent');
  }

  // ---------- open / close transitions ----------
  /** Converge on _target(); safe to call any time (requests during a transition queue up). */
  _requestMode() {
    if (!this.busy) this._pump();
  }

  async _pump() {
    this.busy = true;
    try {
      while (this.shown !== this._target()) {
        const from = this.shown;
        const to = this._target();
        if (!from) await this._enter(to);
        else if (!to) await this._exit(from);
        else await this._swap(from, to);
        this.shown = to;
        // 'opened' / 'closed' keep meaning "the viewer itself is on / off screen"
        if (from === 'viewer') this._emit('closed');
        if (to === 'viewer') this._emit('opened');
        const a = from && this.surfaces[from];
        const b = to && this.surfaces[to];
        if (a && a.hooks.hidden) { try { a.hooks.hidden(); } catch { /* owner error */ } }
        if (b && b.hooks.shown) { try { b.hooks.shown(); } catch { /* owner error */ } }
      }
    } finally {
      this.busy = false;
    }
    if (this.dirty) {
      this.dirty = false;
      this._relayout();
    }
  }

  /** The surface just became visible (still animating): owners restore scroll etc. */
  _beforeShow(name) {
    const s = this.surfaces[name];
    if (s.hooks.beforeShow) { try { s.hooks.beforeShow(); } catch { /* owner error */ } }
  }

  _focusIn(name) {
    const s = this.surfaces[name];
    if (s.hooks.focus) s.hooks.focus();
    else s.root.focus({ preventScroll: true });
  }

  _enter(name = 'viewer') {
    const home = this.home;
    const dock = this.docking;
    const R = home.cards.reactor;
    const wrap = document.getElementById('core-wrap');
    const { root, head, bodies, foot, frame } = this.surfaces[name];
    const g = this._geom();
    this._layout(g);
    const last = this._reactorTarget(g, name);
    const inSurface = (n) => Object.values(this.surfaces).some((s) => s.root.contains(n));
    this.focusBack = document.activeElement && !inSurface(document.activeElement) ? document.activeElement : null;
    dock.lock();
    dock.floatArea = this._floatArea(g, last);
    home.root.classList.add('viewer-mode');
    document.body.classList.add('viewer-mode');
    root.hidden = false;
    this._beforeShow(name);
    const apply = () => home.applyReactor();
    const base = frame.querySelector('.base');
    const accs = frame.querySelectorAll('.acc');
    const camera = name === 'viewer' && this.current && this.current.kind === 'camera';

    return new Promise((resolve) => {
      const tl = gsap.timeline({
        defaults: { ease: 'calm' },
        onComplete: () => {
          wrap.classList.add('mini');
          wrap.classList.toggle('mini-web', last.s === MINI_WEB);
          gsap.set([root, head, bodies, foot, base, ...accs], { clearProps: 'transform,opacity,strokeDasharray,strokeDashoffset,transformOrigin' });
          dock.unlock();
          this._focusIn(name);
          resolve();
        },
      });
      // all open cards dock, farthest from the reactor first (staggered)
      dock.enterCamera(tl, 0, this.reduced ? 0 : 0.05);
      tl.call(() => sfx.cameraTransform('in', this.reduced ? 0.3 : 0.65), null, this.reduced ? 0 : 0.35);
      tl.to(DIM, { opacity: 0.5, duration: 0.5 }, 0);

      if (this.reduced) {
        tl.fromTo(root, { opacity: 0 }, { opacity: 1, duration: 0.3 }, 0.1)
          .to(wrap, { opacity: 0, duration: 0.15 }, 0.1)
          .call(() => { Object.assign(R, last); apply(); }, null, 0.26)
          .to(wrap, { opacity: 1, duration: 0.2 }, 0.27);
        if (camera) tl.call(() => sfx.lensFocus(), null, 0.3);
        return;
      }

      // the viewer grows out of the reactor's centre: scale 0.1 → 1 in 0.45 s
      const ox = CORE.x + R.x - g.x;
      const oy = CORE.y + R.y - g.y;
      tl.set(root, { transformOrigin: `${ox}px ${oy}px` }, 0)
        .fromTo(root, { scale: 0.1, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'power3.out' }, 0.15)
        .fromTo(base, { strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.5 }, 0.3)
        .fromTo(accs, { opacity: 0 }, { opacity: 1, duration: 0.25 }, 0.5)
        .fromTo(head, { opacity: 0 }, { opacity: 1, duration: 0.25 }, 0.5)
        .fromTo(foot, { opacity: 0 }, { opacity: 1, duration: 0.25 }, 0.6)
        .fromTo(bodies, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.35 }, 0.6)
        .call(() => { const t = this.current; if (name === 'viewer' && t) this.reveal(t.body); }, null, 0.6);
      if (camera) tl.call(() => sfx.lensFocus(), null, 0.7);
      // reactor: FLIP from where it is to the viewer's corner (transform only)
      const first = { x: R.x, y: R.y, s: R.s };
      tl.fromTo(R, first, { x: last.x, y: last.y, s: last.s, r: 0, duration: 0.6, ease: 'power3.inOut', onUpdate: apply }, 0.4);
    });
  }

  _exit(name = 'viewer') {
    const home = this.home;
    const dock = this.docking;
    const R = home.cards.reactor;
    const wrap = document.getElementById('core-wrap');
    const { root, head, bodies, foot, frame } = this.surfaces[name];
    const g = this.g || this._geom();
    dock.lock();
    wrap.classList.remove('mini', 'mini-web');
    const apply = () => home.applyReactor();
    const accs = frame.querySelectorAll('.acc');

    return new Promise((resolve) => {
      const tl = gsap.timeline({
        defaults: { ease: 'calm' },
        onComplete: () => {
          root.hidden = true;
          if (this.lastBody) { this.lastBody.remove(); this.lastBody = null; }
          gsap.set([root, head, bodies, foot, ...accs, wrap], { clearProps: 'transform,opacity,transformOrigin' });
          gsap.set(DIM, { clearProps: 'opacity' });
          Object.assign(R, { x: 0, y: 0, s: 1, r: 0 });
          apply();
          home.root.classList.remove('viewer-mode');
          document.body.classList.remove('viewer-mode');
          dock.unlock();
          const back = this.focusBack;
          this.focusBack = null;
          // focus returns to the HUD: what had it before, else the reactor button
          const ok = back && back !== document.body && back.isConnected && !back.closest('[hidden]') && typeof back.focus === 'function';
          const to = ok ? back : document.getElementById('core-hit');
          if (to) to.focus({ preventScroll: true });
          resolve();
        },
      });
      tl.call(() => sfx.cameraTransform('out', this.reduced ? 0.3 : 0.6), null, this.reduced ? 0 : 0.3);

      if (this.reduced) {
        tl.to(root, { opacity: 0, duration: 0.25 }, 0)
          .to(wrap, { opacity: 0, duration: 0.15 }, 0)
          .call(() => { Object.assign(R, { x: 0, y: 0, s: 1, r: 0 }); apply(); }, null, 0.16)
          .to(wrap, { opacity: 1, duration: 0.2 }, 0.17)
          .to(DIM, { opacity: 1, duration: 0.3 }, 0.1);
        dock.exitCamera(tl, 0.3, 0);
        return;
      }

      // content fades, the viewer shrinks back into the reactor, which returns to the centre
      tl.to([bodies, foot], { opacity: 0, duration: 0.2 }, 0)
        .to([head, ...accs], { opacity: 0, duration: 0.2 }, 0.05)
        .set(root, { transformOrigin: `${CORE.x + R.x - g.x}px ${CORE.y + R.y - g.y}px` }, 0.1)
        .to(root, { scale: 0.1, opacity: 0, duration: 0.4, ease: 'power2.in' }, 0.12)
        .to(R, { x: 0, y: 0, s: 1, r: 0, duration: 0.6, ease: 'power3.inOut', onUpdate: apply }, 0.3)
        .to(DIM, { opacity: 1, duration: 0.4 }, 0.4);
      // cards that were open before redeploy from their nodes; manually closed ones stay docked
      dock.exitCamera(tl, 0.45, 0.06);
    });
  }

  /**
   * Two open surfaces share the geometry: cross-fade them. The cards stay docked;
   * the reactor only moves when its badge size differs (web pages use a smaller one).
   */
  _swap(from, to) {
    const A = this.surfaces[from];
    const B = this.surfaces[to];
    const home = this.home;
    const R = home.cards.reactor;
    const wrap = document.getElementById('core-wrap');
    const g = this._geom();
    this._layout(g);
    const last = this._reactorTarget(g, to);
    const apply = () => home.applyReactor();
    // the viewer's tab pauses (videos) / hides (native web page) while it is behind
    const t = this.current;
    if (from === 'viewer' && t && t.ctl && t.ctl.onHide) { try { t.ctl.onHide(); } catch { /* tab error */ } }
    A.root.classList.add('sv-leaving'); // the web viewer watches classes: its native page hides at once
    this.docking.floatArea = this._floatArea(g, last);
    return new Promise((resolve) => {
      const tl = gsap.timeline({
        defaults: { ease: 'calm' },
        onComplete: () => {
          A.root.hidden = true;
          A.root.classList.remove('sv-leaving');
          if (from === 'viewer' && this.lastBody) { this.lastBody.remove(); this.lastBody = null; }
          gsap.set([A.root, B.root, B.bodies], { clearProps: 'transform,opacity' });
          wrap.classList.toggle('mini-web', last.s === MINI_WEB);
          if (to === 'viewer') {
            const c = this.current;
            if (c && c.ctl && c.ctl.onShow) { try { c.ctl.onShow(); } catch { /* tab error */ } }
          }
          this._focusIn(to);
          resolve();
        },
      });
      const d = this.reduced ? 0.15 : 0.18;
      tl.to(A.root, { opacity: 0, duration: d }, 0)
        .call(() => { B.root.hidden = false; this._beforeShow(to); }, null, d)
        .fromTo(B.root, { opacity: 0 }, { opacity: 1, duration: this.reduced ? 0.2 : 0.26 }, d);
      if (!this.reduced) tl.fromTo(B.bodies, { y: 8 }, { y: 0, duration: 0.3 }, d);
      if (R.x !== last.x || R.y !== last.y || R.s !== last.s) {
        if (this.reduced) tl.call(() => { Object.assign(R, last); apply(); }, null, d);
        else tl.to(R, { x: last.x, y: last.y, s: last.s, r: 0, duration: 0.35, onUpdate: apply }, 0);
      }
    });
  }
}
