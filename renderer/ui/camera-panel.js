// CAMERA on the home HUD. The CAMERA card holds the on/off control and status.
// Turning the camera on shows the live feed as the "camera" tab of the shared
// large viewer (ui/stage-viewer.js), which owns camera mode's transition: cards
// dock, the viewer grows out of the reactor, the reactor becomes a corner badge.
// Closing the tab (× / Esc / voice) turns the camera off; turning the camera off
// closes the tab. The camera only ever starts from a user action.

import './ease.js';

const gsap = window.gsap;
const NS = 'http://www.w3.org/2000/svg';
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

export class CameraPanel {
  /**
   * @param {object} o
   * @param {import('./cards.js').Cards} o.cards
   * @param {import('./home.js').Home} o.home
   * @param {import('./stage-viewer.js').StageViewer} o.viewer shared large viewer (camera = one tab)
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
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.listeners = new Set();
    this._buildFeed();
    this._buildCard();
    o.cards.onBuilt.push(() => this._buildCard());
    this._keys();
    this._expose();
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

  // ---------- the live feed (shown as the "camera" tab of the shared viewer) ----------
  _buildFeed() {
    // header extras: a small LIVE pill, the timer, the resolution, switch camera
    const extras = h('span', 'cv-extras');
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
    extras.append(live, time, res, sw);

    // the video, clean and natural: no tint, scanlines or crosshair
    const feed = h('div', 'cv-feed');
    const media = h('div', 'cv-media');
    const video = document.getElementById('cam');
    const overlay = document.getElementById('cam-overlay');
    media.append(video, overlay); // moved once, before the camera ever plays
    feed.append(media);
    this.v = { feed, media, time, res, sw, extras, video };

    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      this.switchDevice();
    });
  }

  /** Show the camera as a tab in the shared viewer (opens the viewer if needed). */
  _openTab() {
    const viewer = this.o.viewer;
    viewer.open({
      id: 'camera',
      kind: 'camera',
      icon: 'camera',
      title: 'CAMERA',
      padded: false,
      extras: this.v.extras,
      mount: (body) => {
        body.classList.add('cv-body');
        body.append(this.v.feed);
        // a <video> pauses when moved in the DOM: keep it playing
        if (this.v.video.srcObject && this.v.video.paused) this.v.video.play().catch(() => {});
        return {};
      },
      onClose: () => { if (!this.closingTab) this.turnOff(); },
    });
  }

  _closeTab() {
    this.closingTab = true;
    try { this.o.viewer.close('camera'); } finally { this.closingTab = false; }
  }

  // ---------- input ----------
  _keys() {
    addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        this.toggle();
      }
    }, true);
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
    this._openTab();
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
      this._closeTab();
      return;
    }
    clearInterval(this.timer);
    this.o.vision.stop(); // stop every track right away → the OS camera light turns off
    this._reactor(false);
    this._set('off');
    this._closeTab();
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
      this._closeTab();
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

  /** Current frame as an image Blob (null when the camera is off). */
  captureFrame() {
    if (this.state !== 'on') return Promise.resolve(null);
    return this.o.vision.captureFrame();
  }
}
