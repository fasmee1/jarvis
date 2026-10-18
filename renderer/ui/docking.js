// Card docking. A card's × button folds it into its node on the reactor ring;
// clicking the docked node, Alt+1…8 or the dock tray plays the exact reverse.
// Closing only hides the UI — mic, TTS and everything else keep running.
//
// Each card owns one paused GSAP timeline: forward = dock, reverse = reopen.
// Toggling while it runs just flips the direction of that same timeline.
// Camera mode drives the same timelines from its own master timeline.

import { cardRect, nodePoint, CORE } from './layout.js';
import { NAMES } from './cards.js';
import { sfx } from '../sfx.js';
import './ease.js';

const gsap = window.gsap;
const NS = 'http://www.w3.org/2000/svg';
const KEY = 'jarvis.dockedCards';
const ORDER = ['reply', 'mic', 'tts', 'latency', 'step', 'tokens', 'camera', 'elapsed']; // Alt+1…8
const SHORT = { reply: 'REPLY', mic: 'MIC', tts: 'TTS', latency: 'LATENCY', step: 'STEP', tokens: 'TOKENS', camera: 'CAM', elapsed: 'TIME' };
const WRAP = { x: 600, y: 180 }; // #core-wrap origin in stage px

function loadDocked() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => ORDER.includes(x)) : []);
  } catch {
    return new Set();
  }
}
function saveDocked(set) {
  try { localStorage.setItem(KEY, JSON.stringify([...set])); } catch { /* storage unavailable */ }
}
function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
/** Point at fraction t (0..1) along a polyline. */
function along(pts, t) {
  if (!pts || pts.length < 2) return pts ? pts[0] : { x: 0, y: 0 };
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    seg.push(l);
    total += l;
  }
  let d = Math.max(0, Math.min(1, t)) * total;
  let i = 0;
  while (i < seg.length - 1 && d > seg[i]) d -= seg[i++];
  const f = seg[i] ? d / seg[i] : 0;
  return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f };
}

export class Docking {
  /** @param {import('./home.js').Home} home */
  constructor(home) {
    this.home = home;
    this.cards = home.cards;
    this.core = home.core;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.userDocked = loadDocked(); // persisted: cards the user closed
    this.st = new Map(); // id → { tl, mode, target, docked, nd, dot, btn }
    this.camMode = false;
    this.floatArea = null; // { x, bottom, top } in stage px, set by camera mode
    this.floatOrder = [];
    this.locked = false;
    this.pending = [];
    this.listeners = new Set();
    this._buildLayers();
    this._keys();
    this.cards.onBuilt.push(() => this._rebuilt());
    this._rebuilt();
  }

  // ---------- queries ----------
  /** Is this card docked (or on its way into the reactor)? */
  isDocked(id) {
    const s = this.st.get(id);
    return s ? s.target : this.userDocked.has(id);
  }

  dockedIds() {
    return [...this.st.entries()].filter(([, s]) => s.target).map(([id]) => id);
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  // ---------- user actions ----------
  toggle(id) {
    if (!this.st.has(id)) return;
    if (this.isDocked(id)) this.open(id);
    else this.close(id);
  }

  close(id) {
    if (this.locked) return this._defer(() => this.close(id));
    const s = this.st.get(id);
    this.userDocked.add(id);
    saveDocked(this.userDocked);
    if (!s || s.target) return;
    s.target = true;
    this._play(id, true, this.camMode ? 'float' : 'home');
    this._sync();
  }

  open(id) {
    if (this.locked) return this._defer(() => this.open(id));
    const s = this.st.get(id);
    this.userDocked.delete(id);
    saveDocked(this.userDocked);
    if (!s || !s.target) return;
    s.target = false;
    if (this.camMode) this._placeFloat(id);
    this._play(id, false, this.camMode ? 'float' : 'home');
    this._sync();
  }

  // ---------- camera mode (driven by camera-panel's master timeline) ----------
  lock() {
    this.locked = true;
  }

  unlock() {
    this.locked = false;
    const q = this.pending.splice(0);
    for (const fn of q) fn();
  }

  _defer(fn) {
    this.pending.push(fn);
  }

  /**
   * Auto-dock every open card into the master timeline, farthest from the reactor
   * first. User state is untouched, so camera off can tell auto from manual.
   * @returns {number} end time of the last dock
   */
  enterCamera(tl, at, stagger = 0.05) {
    this.camMode = true;
    this.floatOrder = [];
    const open = this._visible().filter((c) => !this.st.get(c.def.id).target);
    open.sort((a, b) => this._dist(b) - this._dist(a));
    let end = at;
    open.forEach((c, i) => {
      const id = c.def.id;
      const s = this.st.get(id);
      s.target = true;
      this._ensure(id, 'home');
      const t = at + i * stagger;
      s.tl.pause();
      const p0 = s.tl.progress();
      const d = s.tl.duration() * (1 - p0);
      tl.fromTo(s.tl, { progress: p0 }, { progress: 1, duration: d, ease: 'none', immediateRender: false }, t);
      tl.call(() => this._settled(id, true), null, t + d);
      end = Math.max(end, t + d);
    });
    tl.call(() => this._sync(), null, at);
    return end;
  }

  /**
   * Camera off: floating cards slide home; cards that were open before camera
   * mode redeploy (nearest first); cards the user closed stay docked.
   */
  exitCamera(tl, at, stagger = 0.06) {
    this.camMode = false;
    let end = at;
    for (const c of this._visible()) {
      const id = c.def.id;
      const s = this.st.get(id);
      if (!c.float) continue;
      if (!s.target) {
        // open floating card: glide back to its home slot, then redraw its connector
        tl.to(c.float, { x: 0, y: 0, duration: 0.5, ease: 'power3.inOut' }, at);
        tl.call(() => {
          c.float = null;
          c.noLeader = false;
          c.el.classList.remove('floating');
          this._drop(id);
        }, null, at + 0.5);
        tl.fromTo(c.pl, { strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.3, immediateRender: false }, at + 0.5);
        end = Math.max(end, at + 0.8);
      } else {
        tl.call(() => {
          c.float = null;
          c.noLeader = false;
          c.el.classList.remove('floating');
          this._drop(id);
        }, null, at);
      }
    }
    const back = this._visible().filter((c) => {
      const s = this.st.get(c.def.id);
      return s.target && !this.userDocked.has(c.def.id) && !c.float;
    });
    back.sort((a, b) => this._dist(a) - this._dist(b));
    back.forEach((c, i) => {
      const id = c.def.id;
      const s = this.st.get(id);
      s.target = false;
      this._ensure(id, 'home');
      const t = at + i * stagger;
      s.tl.pause();
      const p0 = s.tl.progress();
      const d = s.tl.duration() * 0.85 * p0;
      tl.fromTo(s.tl, { progress: p0 }, { progress: 0, duration: d, ease: 'none', immediateRender: false }, t);
      tl.call(() => this._settled(id, false), null, t + d);
      // redeploy: the boot panelOpen sound, staggered with the cards
      tl.call(() => sfx.panelOpen(ORDER.indexOf(id), sfx.panOf(c.el), { group: 'ui', blipAt: Math.max(0.05, d - 0.1), crackleAt: null }), null, t);
      end = Math.max(end, t + d);
    });
    tl.call(() => this._sync(), null, at);
    return end;
  }

  // ---------- internals ----------
  _visible() {
    return [...this.cards.cards.values()].filter((c) => !c.def.hidden);
  }

  _dist(c) {
    const r = cardRect(c.def);
    return Math.hypot(r.x + r.w / 2 - CORE.x, r.y + r.h / 2 - CORE.y);
  }

  /** Card body parts that fold (all fill the card box; the frame has 6px padding). */
  _shell(c) {
    return ['.fill', '.frame', '.in', '.scan'].map((q) => c.el.querySelector(q)).filter(Boolean);
  }

  /** Put a card back in its plain open state (before building a new timeline). */
  _resetOpen(c) {
    gsap.set(this._shell(c), { clearProps: 'transform,opacity' });
    gsap.set(c.el, { clearProps: 'opacity,visibility,pointerEvents' });
    gsap.set(c.dot, { clearProps: 'opacity' });
  }

  /** Make sure the card's timeline is for `mode`, keeping its current docked/open look. */
  _ensure(id, mode) {
    const s = this.st.get(id);
    if (s.tl && s.mode === mode) return;
    const c = this.cards.cards.get(id);
    const wasDocked = s.docked;
    this._drop(id);
    this._resetOpen(c);
    s.tl = this._build(c, mode);
    s.mode = mode;
    if (wasDocked) s.tl.progress(1, true);
  }

  _drop(id) {
    const s = this.st.get(id);
    if (!s) return;
    if (s.tl) s.tl.kill();
    if (s.dot) s.dot.remove();
    s.tl = null;
    s.mode = null;
    s.dot = null;
  }

  _play(id, dock, mode) {
    const s = this.st.get(id);
    const c = this.cards.cards.get(id);
    this._ensure(id, mode);
    if (mode === 'float') {
      c.noLeader = true;
      c.el.classList.add('floating');
    }
    if (dock) s.tl.play();
    else s.tl.reverse();
  }

  _settled(id, docked) {
    const s = this.st.get(id);
    const c = this.cards.cards.get(id);
    if (!s || !c) return;
    s.docked = docked;
    s.nd.v = docked ? 1 : 0;
    this.core.setDocked(c.def.node, s.nd.v);
    if (!docked && !s.target) {
      // Fully open again: drop the fold timeline and clear what it set. Camera-off
      // rewinds timelines to exactly progress 0, where GSAP leaves the time-0
      // `pointerEvents: none` and the first glitch keyframe (x: 3px) applied —
      // the card looked normal but could not be clicked.
      this._drop(id);
      this._resetOpen(c);
    }
    if (docked && s.mode === 'float') {
      c.el.classList.remove('floating');
      this.floatOrder = this.floatOrder.filter((x) => x !== id);
    }
    this._sync();
  }

  /** The dock / reopen timeline for one card (built paused at the open state). */
  _build(c, mode) {
    const id = c.def.id;
    const s = this.st.get(id);
    const el = c.el;
    const shell = this._shell(c);
    const content = el.querySelector('.in');
    const deg = c.def.node;
    const w = el.offsetWidth;
    const hh = el.offsetHeight;
    const { side, at } = c.def.anchor;
    const ax = side === 'l' ? 0 : side === 'r' ? w : w * at;
    const ay = side === 't' ? 0 : side === 'b' ? hh : hh * at;
    const origin = (i, t) => (t.classList.contains('frame') ? `${ax + 6}px ${ay + 6}px` : `${ax}px ${ay}px`);
    const nd = s.nd;
    const setNode = () => {
      this.core.setDocked(deg, nd.v);
      this._sync();
    };
    const tl = gsap.timeline({
      paused: true,
      defaults: { ease: 'calm' },
      onComplete: () => this._settled(id, true),
      onReverseComplete: () => this._settled(id, false),
    });
    // Sounds live on this timeline. It plays forward to dock and in reverse to
    // reopen, so each call checks the direction. Camera mode scrubs these
    // timelines while docking is locked; it plays its own sounds instead.
    const pan = () => sfx.panOf(el);
    const cue = (time, onDock, onOpen) => tl.call(() => {
      if (this.locked) return;
      if (tl.reversed()) { if (onOpen) onOpen(); } else if (onDock) onDock();
    }, null, time);
    const idx = ORDER.indexOf(id);

    if (this.reduced) {
      // reduced motion: a plain fade + slight scale, no travel
      tl.set(el, { pointerEvents: 'none' }, 0)
        .to(shell, { scale: 0.96, opacity: 0, duration: 0.22, transformOrigin: '50% 50%' }, 0)
        .to(c.dot, { opacity: 0, duration: 0.2 }, 0)
        .to(nd, { v: 1, duration: 0.15, ease: 'none', onUpdate: setNode }, 0.1)
        .set(el, { visibility: 'hidden' }, 0.22);
      if (mode === 'home') tl.fromTo(c.pl, { opacity: 1 }, { opacity: 0, duration: 0.2, immediateRender: false }, 0);
      cue(0.15, () => sfx.dockHit(), null);
      cue(0.02, null, () => sfx.panelBlip(idx, pan()));
      return tl;
    }

    const dot = svgEl('circle', { class: 'dock-dot', r: 3, opacity: 0 });
    this.fx.append(dot);
    s.dot = dot;
    const P = { p: 0 };
    const path = () => (mode === 'float' ? [c.pts[0], c.pts[c.pts.length - 1]] : c.pts);
    const place = () => {
      const q = along(path(), P.p);
      dot.setAttribute('cx', q.x.toFixed(1));
      dot.setAttribute('cy', q.y.toFixed(1));
    };

    tl.set(el, { pointerEvents: 'none' }, 0)
      // 1. content fades while the card eases to 0.96 (0.12 s)
      .to(content, { opacity: 0, duration: 0.15 }, 0)
      .to(c.dot, { opacity: 0, duration: 0.15 }, 0)
      .to(shell, { scale: 0.96, duration: 0.12, transformOrigin: origin }, 0)
      // 2. then fades and scales down to nothing at the connector anchor
      .to(shell, { scale: 0, opacity: 0, duration: 0.2, ease: 'power2.in', transformOrigin: origin }, 0.1)
      .fromTo(dot, { opacity: 0 }, { opacity: 1, duration: 0.08, onStart: place, immediateRender: false }, 0.24)
      .set(el, { visibility: 'hidden' }, 0.31)
      // 3. a small dot travels along the line into the node; the line retracts behind it (0.3 s)
      .fromTo(P, { p: 0 }, { p: 1, duration: 0.3, ease: 'power2.inOut', onUpdate: place, immediateRender: false }, 0.3)
      // 4. the node takes its docked look with a single soft pulse
      .to(nd, { v: 1, duration: 0.12, ease: 'none', onUpdate: setNode }, 0.6)
      .call(() => this.core.flashNode(deg), null, 0.6)
      .to(dot, { opacity: 0, duration: 0.12 }, 0.6);
    if (mode === 'home') {
      tl.fromTo(c.pl, { strokeDasharray: '1 1', strokeDashoffset: 0 }, { strokeDashoffset: -1, duration: 0.3, ease: 'power2.inOut', immediateRender: false }, 0.3);
    }
    // dock: suck-in whoosh (0.2 → 0.6) as the card folds and the dot travels in,
    //       then a thunk + ripple shimmer when the dot reaches its node (0.6)
    // reopen: the whoosh rises back out (0.6 → 0.2), blip as the card unfolds
    cue(0.2, () => sfx.dockWhoosh(pan(), 0.4), null);
    cue(0.6, () => sfx.dockHit(), () => sfx.undockWhoosh(pan(), 0.4));
    cue(0.05, null, () => sfx.panelBlip(idx, pan()));
    return tl;
  }

  /** Floating position near the mini reactor (camera mode), stacked upward. */
  _placeFloat(id) {
    const c = this.cards.cards.get(id);
    const A = this.floatArea;
    if (!A) return;
    const r = cardRect(c.def);
    let x = A.x;
    let bottom = A.bottom;
    let colW = 0;
    for (const other of this.floatOrder) {
      const o = this.cards.cards.get(other);
      if (!o || !o.float) continue;
      const or = cardRect(o.def);
      if (bottom - or.h < A.top) {
        x += colW + 16;
        bottom = A.bottom;
        colW = 0;
      }
      bottom -= or.h + 16;
      colW = Math.max(colW, or.w);
    }
    if (bottom - r.h < A.top) {
      x += colW + 16;
      bottom = A.bottom;
    }
    this.floatOrder = this.floatOrder.filter((x2) => x2 !== id).concat(id);
    c.float = { x: x - r.x, y: bottom - r.h - r.y };
    // the floating card's open state must not keep a stale home timeline
    this._ensure(id, 'float');
  }

  // ---------- DOM: dock fx layer, docked-node buttons, tray ----------
  _buildLayers() {
    const stage = document.getElementById('stage');
    this.fx = svgEl('svg', { class: 'stage-svg dock-fx', viewBox: '0 0 1920 1080', 'aria-hidden': 'true' });
    stage.append(this.fx);

    this.layer = h('div', 'dock-layer');
    document.getElementById('core-wrap').append(this.layer);

    const readout = document.querySelector('#core-wrap .core-readout');
    const tray = h('div', 'dock-tray');
    const btn = h('button', 'dock-tray-btn');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-haspopup', 'true');
    const list = h('div', 'dock-list');
    list.hidden = true;
    list.setAttribute('role', 'menu');
    tray.append(btn, list);
    tray.hidden = true;
    readout.append(tray);
    this.tray = { tray, btn, list };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleList();
    });
    addEventListener('mousedown', (e) => {
      if (!list.hidden && !tray.contains(e.target)) this._toggleList(false);
    });
  }

  _toggleList(force) {
    const { btn, list } = this.tray;
    const show = force === undefined ? list.hidden : force;
    if (show) {
      list.replaceChildren();
      for (const id of ORDER) {
        if (!this.st.has(id) || !this.isDocked(id)) continue;
        const it = h('button', 'dock-item');
        it.type = 'button';
        it.setAttribute('role', 'menuitem');
        it.append(h('span', 'di-k', `ALT+${ORDER.indexOf(id) + 1}`), h('span', 'di-t', SHORT[id]));
        it.setAttribute('aria-label', `เปิดการ์ด ${NAMES[id]}`);
        it.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleList(false);
          this.open(id);
        });
        list.append(it);
      }
      if (!list.children.length) return;
    }
    list.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    if (show) list.querySelector('button').focus();
  }

  _rebuilt() {
    for (const id of this.st.keys()) this._drop(id);
    this.st.clear();
    this.layer.replaceChildren();
    for (const c of this._visible()) {
      const id = c.def.id;
      const floating = this.camMode && this.floatOrder.includes(id) && !this.userDocked.has(id);
      const docked = this.userDocked.has(id) || (this.camMode && !floating);
      const s = { tl: null, mode: null, target: docked, docked: false, nd: { v: 0 }, dot: null, btn: null };
      this.st.set(id, s);
      // docked-node hit area + hover label, positioned on the node in core-wrap px
      const n = nodePoint(c.def.node);
      const b = h('button', 'dock-node');
      b.type = 'button';
      b.style.left = `${n.x - WRAP.x}px`;
      b.style.top = `${n.y - WRAP.y}px`;
      b.setAttribute('aria-label', `เปิดการ์ด ${NAMES[id]}`);
      b.title = `เปิดการ์ด ${NAMES[id]} (Alt+${ORDER.indexOf(id) + 1})`;
      const lbl = h('span', `dock-lbl ${n.x >= CORE.x - 4 ? 'r' : 'l'}`, SHORT[id]);
      b.append(lbl);
      b.hidden = true;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.open(id);
      });
      this.layer.append(b);
      s.btn = b;
      if (floating) {
        this._placeFloat(id);
        c.noLeader = true;
        c.el.classList.add('floating');
      } else if (docked) {
        this._ensure(id, this.camMode ? 'float' : 'home');
        s.tl.progress(1, true);
        this._settled(id, true);
      }
    }
    this._sync();
  }

  _sync() {
    let n = 0;
    for (const s of this.st.values()) {
      const on = s.target && (s.docked || s.nd.v >= 0.5);
      if (s.btn) s.btn.hidden = !on;
      if (s.target) n++;
    }
    const { tray, btn, list } = this.tray;
    tray.hidden = n === 0;
    btn.textContent = `${n} DOCKED`;
    btn.setAttribute('aria-label', `การ์ดที่เก็บไว้ ${n} ใบ — คลิกเพื่อดูรายการ`);
    if (n === 0 && !list.hidden) this._toggleList(false);
    for (const fn of this.listeners) fn();
  }

  _keys() {
    addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || !/^Digit[1-8]$/.test(e.code)) return;
      if (document.body.classList.contains('booting')) return;
      const id = ORDER[Number(e.code.slice(5)) - 1];
      if (!this.st.has(id)) return;
      e.preventDefault();
      this.toggle(id);
    });
  }
}
