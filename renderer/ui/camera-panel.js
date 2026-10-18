// CAMERA on the home HUD. The CAMERA card holds the on/off control and status.
// Turning the camera on enters camera mode: a large live viewer opens, every card
// docks into the reactor, and the reactor shrinks into the viewer's bottom-left
// corner as a HUD badge. Turning it off plays the reverse.
// The camera only ever starts from a user action (button / Ctrl+Shift+C).
//
// Every transition is one GSAP timeline that animates transform, opacity and
// stroke-dashoffset only. Requests made while one runs are queued: the mode
// controller always converges on the latest requested state.

import { CORE } from './layout.js';
import { drawFrame, icon } from './cards.js';
import { sfx } from '../sfx.js';
import './ease.js';

const gsap = window.gsap;
const NS = 'http://www.w3.org/2000/svg';
const MINI = 0.35; // reactor scale in camera mode
const R_VIS = 306; // reactor visual radius (labels ring) at scale 1
const HEAD = 56; // viewer header height (stage px)
const VCUT = 6; // same chamfer as the cards
const DIM = ['#grid-bg', '.corner-brk', '#caption-tr', '.caption-bl'];
const POWER = 'M12 2v10 M18.4 6.6a9 9 0 1 1-12.77.04';
const SWITCH = 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5';

const TEXT = {
  off: 'กล้องปิดอยู่',
  requesting: 'กำลังขออนุญาต…',
  on: 'LIVE',
  CAM_DENIED: 'ไม่ได้รับอนุญาตให้ใช้กล้อง',
  CAM_NOT_FOUND: 'ไม่พบกล้อง',
  CAM_BUSY: 'กล้องถูกใช้งานโดยโปรแกรมอื่นอยู่',
};

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

export class CameraPanel {
  /**
   * @param {object} o
   * @param {import('./cards.js').Cards} o.cards
   * @param {import('./home.js').Home} o.home
   * @param {import('../vision.js').Vision} o.vision
   * @param {() => string} o.getDeviceId
   * @param {(id: string) => void} o.setDeviceId
   * @param {() => boolean} [o.overlayOn]
   * @param {(state: string, error: string|null) => void} [o.onChange]
   * @param {(msg: string) => void} [o.onError] shown as a toast when the CAMERA card is docked
   */
  constructor(o) {
    this.o = o;
    this.state = 'off';
    this.error = null;
    this.mode = false; // camera mode as currently shown
    this.want = false; // camera mode requested
    this.busy = false;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.listeners = new Set();
    this._buildViewer();
    this._buildCard();
    o.cards.onBuilt.push(() => this._buildCard());
    this._keys();
    this._expose();
    addEventListener('resize', () => this._relayout());
  }

  get docking() {
    return this.o.home.docking;
  }

  // ---------- CAMERA card ----------
  _buildCard() {
    const card = this.o.cards.cards.get('camera');
    if (!card) return;
    this.card = card;
    const host = card.parts.host;
    host.replaceChildren();

    const ctl = h('div', 'cam-ctl');
    const btn = h('button', 'cam-btn');
    btn.type = 'button';
    const spin = svg('svg', { class: 'cam-spin', viewBox: '0 0 20 20', 'aria-hidden': 'true' });
    spin.append(svg('circle', { cx: 10, cy: 10, r: 7 }));
    const ico = svg('svg', { class: 'cam-ico', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    ico.append(svg('path', { d: POWER }));
    const lbl = h('span', 'cam-btn-label', 'CAM OFF');
    btn.append(spin, ico, lbl);

    const status = h('div', 'cam-status');
    const dot = h('i', 'cam-dot');
    const text = h('span', 'cam-text', TEXT.off);
    const hint = h('span', 'cam-hint', 'Ctrl+Shift+C');
    const retry = h('button', 'cam-retry', 'RETRY');
    retry.type = 'button';
    const line = h('div', 'cam-line');
    line.append(dot, text);
    const sub = h('div', 'cam-line');
    sub.append(hint, retry);
    status.append(line, sub);
    ctl.append(btn, status);
    host.append(ctl);
    this.el = { card: card.el, btn, lbl, text, hint, retry };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    retry.addEventListener('click', (e) => {
      e.stopPropagation();
      this.turnOn();
    });
    this._render();
  }

  _render() {
    if (!this.el) return;
    const { card, btn, lbl, text, hint, retry } = this.el;
    const st = this.state;
    card.dataset.cam = st;
    const on = st === 'on';
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'ปิดกล้อง' : 'เปิดกล้อง');
    lbl.textContent = on ? 'CAM ON' : 'CAM OFF';
    text.textContent = st === 'error' ? this._errText() : TEXT[st];
    hint.hidden = st !== 'off';
    retry.hidden = st !== 'error';
    btn.disabled = st === 'requesting';
    if (this.v) this.v.sw.hidden = !on || (this.devices || []).length < 2;
  }

  _errText() {
    return TEXT[this.error] || TEXT.CAM_NOT_FOUND;
  }

  // ---------- viewer (built once, lives in the stage) ----------
  _buildViewer() {
    const v = h('div', 'cam-viewer');
    v.hidden = true;
    v.setAttribute('role', 'region');
    v.setAttribute('aria-label', 'ภาพจากกล้อง');
    const fill = h('div', 'cv-fill');
    const frame = svg('svg', { class: 'frame cv-frame', 'aria-hidden': 'true' });

    // minimal header: title, a small LIVE pill, the timer, icon-only buttons
    const head = h('div', 'cv-head');
    const title = h('span', 'cv-title', 'CAMERA');
    const live = h('span', 'cv-live');
    live.append(h('i', 'cv-rec-dot'), h('span', '', 'LIVE'));
    live.title = 'กล้องเปิดอยู่ (ไม่มีการบันทึกภาพ)';
    const time = h('span', 'cv-time', '00:00:00');
    const res = h('span', 'cv-res', '—');
    const sw = h('button', 'cv-btn cv-switch');
    sw.type = 'button';
    sw.title = 'สลับกล้อง';
    sw.setAttribute('aria-label', 'สลับกล้อง');
    const swi = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    swi.append(svg('path', { d: SWITCH }));
    sw.append(swi);
    const x = h('button', 'cv-btn cv-close');
    x.type = 'button';
    x.title = 'ปิดกล้อง (Esc)';
    x.setAttribute('aria-label', 'ปิดกล้อง');
    x.append(icon('x', 'x-ico'));
    head.append(icon('camera', 'cv-ico'), title, live, time, res, h('span', 'cv-sp'), sw, x);

    // the video, clean and natural: no tint, scanlines or crosshair
    const feed = h('div', 'cv-feed');
    const media = h('div', 'cv-media');
    const video = document.getElementById('cam');
    const overlay = document.getElementById('cam-overlay');
    media.append(video, overlay); // moved once, before the camera ever plays
    feed.append(media);

    v.append(fill, frame, head, feed);
    document.getElementById('stage').append(v);
    this.v = { root: v, fill, frame, head, feed, media, time, res, sw, x };

    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      this.switchDevice();
    });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      this.turnOff();
    });
  }

  /** Viewer box in stage px: 80vw × 90vh, centred in the window. */
  _geom() {
    const t = this.o.home.t;
    return {
      x: (innerWidth * 0.1 - t.ox) / t.scale,
      y: (innerHeight * 0.05 - t.oy) / t.scale,
      w: (innerWidth * 0.8) / t.scale,
      h: (innerHeight * 0.9) / t.scale,
    };
  }

  /** Reactor transform that centres it on the viewer's bottom-left corner (kept on screen). */
  _reactorTarget(g) {
    const t = this.o.home.t;
    const r = R_VIS * MINI;
    const minX = -t.ox / t.scale + r + 8;
    const maxY = (innerHeight - t.oy) / t.scale - r - 8;
    const cx = Math.max(g.x, minX);
    const cy = Math.min(g.y + g.h, maxY);
    return { x: cx - CORE.x, y: cy - CORE.y, s: MINI, r: 0 };
  }

  _floatArea(g, R) {
    const cy = CORE.y + R.y;
    return { x: g.x + 28, bottom: cy - R_VIS * MINI - 12, top: g.y + HEAD + 16 };
  }

  _layoutViewer(g) {
    const { root, fill, frame } = this.v;
    Object.assign(root.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
    fill.style.clipPath = chamfer(g.w, g.h, VCUT);
    drawFrame(frame, g.w, g.h, ['tl', 'br'], { size: VCUT, pad: 6, arm: 24 });
    frame.querySelector('.base').setAttribute('pathLength', '1');
    this.g = g;
  }

  _relayout() {
    if (!this.mode) return;
    if (this.busy) {
      this.dirty = true;
      return;
    }
    const g = this._geom();
    this._layoutViewer(g);
    const R = this._reactorTarget(g);
    Object.assign(this.o.cards.reactor, R);
    this.o.home.applyReactor();
    this.docking.floatArea = this._floatArea(g, R);
  }

  // ---------- input ----------
  _keys() {
    addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        this.toggle();
      } else if (e.key === 'Escape' && (this.state === 'on' || this.want) && this._homeFocused()) {
        e.stopImmediatePropagation();
        this.turnOff();
      }
    }, true);
  }

  /** Esc belongs to the camera only when nothing else (menu, section, dialog) is on top. */
  _homeFocused() {
    const hidden = (id) => { const n = document.getElementById(id); return !n || n.hidden; };
    return this.o.home.visible && hidden('menu') && hidden('approval') && hidden('barge') && hidden('home-prompt');
  }

  _expose() {
    // Small API so the assistant layer can ask what the camera sees.
    const self = this;
    window.jarvisCamera = Object.freeze({
      get state() { return self.state; },
      get error() { return self.error; },
      captureFrame: () => self.captureFrame(),
      onChange: (fn) => { self.listeners.add(fn); return () => self.listeners.delete(fn); },
    });
  }

  // ---------- state ----------
  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this._render();
    for (const fn of this.listeners) { try { fn(state, error); } catch { /* listener error */ } }
    if (this.o.onChange) this.o.onChange(state, error);
    // the CAMERA card is the error surface; when it is docked, use a toast instead
    if (state === 'error' && this.o.onError && this.docking && this.docking.isDocked('camera')) this.o.onError(this._errText());
  }

  toggle() {
    if (this.state === 'requesting') return;
    if (this.state === 'on') this.turnOff();
    else this.turnOn();
  }

  async turnOn() {
    if (this.state === 'on' || this.state === 'requesting') return;
    this._set('requesting');
    const v = this.o.vision;
    v.overlayOn = this.o.overlayOn ? this.o.overlayOn() : true;
    const ok = await v.start(this.o.getDeviceId());
    if (!ok) {
      // permission denied / no camera: stay out of camera mode, layout unchanged
      this._set('error', v.lastError || 'CAM_NOT_FOUND');
      return;
    }
    this._started();
    this._requestMode(true);
  }

  _started() {
    this.startedAt = Date.now();
    this._mirror();
    this._listDevices();
    this._set('on');
    this._reactor(true);
    this._tick();
    clearInterval(this.timer);
    this.timer = setInterval(() => this._tick(), 1000);
  }

  turnOff() {
    if (this.state !== 'on') {
      if (this.state !== 'requesting') this._set('off');
      this._requestMode(false);
      return;
    }
    clearInterval(this.timer);
    this.o.vision.stop(); // stop every track right away → the OS camera light turns off
    this._reactor(false);
    this._set('off');
    this._requestMode(false);
  }

  async switchDevice() {
    if (!this.devices || this.devices.length < 2 || this.state !== 'on') return;
    const cur = this.o.vision.trackInfo().deviceId;
    const i = this.devices.findIndex((d) => d.deviceId === cur);
    const next = this.devices[(i + 1) % this.devices.length];
    this.o.setDeviceId(next.deviceId);
    this.o.vision.stop();
    const ok = await this.o.vision.start(next.deviceId);
    if (!ok) {
      clearInterval(this.timer);
      this._reactor(false);
      this._set('error', this.o.vision.lastError || 'CAM_NOT_FOUND');
      this._requestMode(false);
      return;
    }
    this._mirror();
    this._tick();
    if (gsap && !this.reduced) gsap.fromTo(this.v.media, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'calm' });
  }

  /** Mirror like a selfie view unless the track says it is a rear camera. */
  _mirror() {
    const t = this.o.vision.stream && this.o.vision.stream.getVideoTracks()[0];
    const facing = t && t.getSettings ? t.getSettings().facingMode : '';
    this.v.media.classList.toggle('no-mirror', facing === 'environment');
  }

  async _listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter((d) => d.kind === 'videoinput');
    } catch {
      this.devices = [];
    }
    this._render();
  }

  _tick() {
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    const p = (n) => String(n).padStart(2, '0');
    this.v.time.textContent = `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
    const { width, height } = this.o.vision.trackInfo();
    this.v.res.textContent = width && height ? `${width}×${height}` : '—';
  }

  /** Reactor reaction: camera node stays lit, "● CAM" in the core, safety tag on. */
  _reactor(on) {
    this.o.cards.setNodeLive('camera', on);
    if (on) this.o.cards.pulse('camera', true);
    this.o.home.setCamera(on);
    const ind = document.getElementById('cam-indicator');
    if (ind) ind.hidden = !on;
  }

  // ---------- camera mode ----------
  _requestMode(on) {
    this.want = on;
    if (!this.busy) this._pump();
  }

  /** Run transitions one at a time until the shown mode matches the requested one. */
  async _pump() {
    this.busy = true;
    try {
      while (this.mode !== this.want) {
        const target = this.want;
        await (target ? this._enter() : this._exit());
        this.mode = target;
      }
    } finally {
      this.busy = false;
    }
    if (this.dirty) {
      this.dirty = false;
      this._relayout();
    }
  }

  _enter() {
    const home = this.o.home;
    const dock = this.docking;
    const R = this.o.cards.reactor;
    const wrap = document.getElementById('core-wrap');
    const { root, head, media, frame } = this.v;
    const g = this._geom();
    this._layoutViewer(g);
    const last = this._reactorTarget(g);
    dock.lock();
    dock.floatArea = this._floatArea(g, last);
    home.root.classList.add('cam-mode');
    document.body.classList.add('cam-mode');
    root.hidden = false;
    const apply = () => home.applyReactor();
    const base = frame.querySelector('.base');
    const accs = frame.querySelectorAll('.acc');

    return new Promise((resolve) => {
      const tl = gsap.timeline({
        defaults: { ease: 'calm' },
        onComplete: () => {
          wrap.classList.add('mini');
          gsap.set([root, head, media, base, ...accs], { clearProps: 'transform,opacity,strokeDasharray,strokeDashoffset' });
          dock.unlock();
          resolve();
        },
      });
      // all open cards dock at once, farthest from the reactor first
      dock.enterCamera(tl, 0, this.reduced ? 0 : 0.05);
      // transform sound as the reactor shrinks into its corner; card docks stay silent
      tl.call(() => sfx.cameraTransform('in', this.reduced ? 0.3 : 0.65), null, this.reduced ? 0 : 0.35);
      tl.to(DIM, { opacity: 0.5, duration: 0.5 }, 0);

      if (this.reduced) {
        tl.fromTo(root, { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.3 }, 0.1)
          .to(wrap, { opacity: 0, duration: 0.15 }, 0.1)
          .call(() => { Object.assign(R, last); apply(); }, null, 0.26)
          .to(wrap, { opacity: 1, duration: 0.2 }, 0.27)
          .call(() => sfx.lensFocus(), null, 0.3);
        return;
      }

      // viewer: fades up from 0.98 while its border draws in; then header, then video
      tl.fromTo(root, { opacity: 0, scale: 0.98, y: 8 }, { opacity: 1, scale: 1, y: 0, duration: 0.5 }, 0.15)
        .fromTo(base, { strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.6 }, 0.15)
        .fromTo(accs, { opacity: 0 }, { opacity: 1, duration: 0.25 }, 0.45)
        .fromTo(head, { opacity: 0 }, { opacity: 1, duration: 0.25 }, 0.5)
        .fromTo(media, { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0.65)
        .call(() => sfx.lensFocus(), null, 0.7); // "lens focus" as the video appears
      // reactor: FLIP from where it is to the viewer's corner (transform only, no twist)
      const first = { x: R.x, y: R.y, s: R.s };
      tl.fromTo(R, first, { x: last.x, y: last.y, s: last.s, r: 0, duration: 0.6, ease: 'power3.inOut', onUpdate: apply }, 0.4);
    });
  }

  _exit() {
    const home = this.o.home;
    const dock = this.docking;
    const R = this.o.cards.reactor;
    const wrap = document.getElementById('core-wrap');
    const { root, head, feed, media, frame } = this.v;
    const g = this.g || this._geom();
    dock.lock();
    wrap.classList.remove('mini');
    const apply = () => home.applyReactor();
    const accs = frame.querySelectorAll('.acc');

    return new Promise((resolve) => {
      const tl = gsap.timeline({
        defaults: { ease: 'calm' },
        onComplete: () => {
          root.hidden = true;
          gsap.set([root, head, feed, media, ...accs, wrap], { clearProps: 'transform,opacity' });
          gsap.set(DIM, { clearProps: 'opacity' });
          Object.assign(R, { x: 0, y: 0, s: 1, r: 0 });
          apply();
          home.root.classList.remove('cam-mode');
          document.body.classList.remove('cam-mode');
          dock.unlock();
          resolve();
        },
      });
      // the transform reversed while the reactor returns; redeploying cards play panelOpen (docking.exitCamera)
      tl.call(() => sfx.cameraTransform('out', this.reduced ? 0.3 : 0.6), null, this.reduced ? 0 : 0.3);

      if (this.reduced) {
        tl.to(root, { opacity: 0, scale: 0.96, duration: 0.25 }, 0)
          .to(wrap, { opacity: 0, duration: 0.15 }, 0)
          .call(() => { Object.assign(R, { x: 0, y: 0, s: 1, r: 0 }); apply(); }, null, 0.16)
          .to(wrap, { opacity: 1, duration: 0.2 }, 0.17)
          .to(DIM, { opacity: 1, duration: 0.3 }, 0.1);
        dock.exitCamera(tl, 0.3, 0);
        return;
      }

      // the picture fades, then the viewer fades down to 0.98
      tl.to(feed, { opacity: 0, duration: 0.2 }, 0)
        .to([head, ...accs], { opacity: 0, duration: 0.2 }, 0.05)
        .to(root, { scale: 0.98, y: 8, opacity: 0, duration: 0.3, ease: 'power2.in' }, 0.15)
        // reactor returns to the centre at full size
        .to(R, { x: 0, y: 0, s: 1, r: 0, duration: 0.6, ease: 'power3.inOut', onUpdate: apply }, 0.3)
        .to(DIM, { opacity: 1, duration: 0.4 }, 0.4);
      // cards that were open before camera mode redeploy; manually closed ones stay docked
      dock.exitCamera(tl, 0.45, 0.06);
    });
  }

  /** Current frame as an image Blob (null when the camera is off). */
  captureFrame() {
    if (this.state !== 'on') return Promise.resolve(null);
    return this.o.vision.captureFrame();
  }
}
