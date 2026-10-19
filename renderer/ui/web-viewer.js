// Web Viewer: real, live web pages inside the shared large viewer (one tab per
// page), with an AI summary of the page beside them.
//
// The page itself is a native WebContentsView owned by main (lib/web/browser.js).
// A native view is always drawn ABOVE this HTML, so:
//   • this module measures the placeholder (.wb-page) and sends its rect to main
//     (web:bounds) on every layout change — resize, divider drag, transitions;
//   • the page area stops above a footer band that keeps the mini reactor clear;
//   • whenever HTML must sit on top (menu, approval dialog, floating cards, the
//     open / close transition), the native view hides and a screenshot stands in.
//
// Page text never reaches this renderer as HTML: summaries arrive as validated
// JSON from main and are written with textContent.

import { vicon } from './stage-viewer.js';
import { icon } from './cards.js';

const NS = 'http://www.w3.org/2000/svg';
const SPLIT_KEY = 'jarvis.webSplit';
const SPLIT_MIN = 0.5;
const SPLIT_MAX = 0.75;
const FOOT_MIN = 40;

const P = {
  back: 'M19 12H5 M12 19l-7-7 7-7',
  fwd: 'M5 12h14 M12 5l7 7-7 7',
  reload: 'M21 12a9 9 0 1 1-3-6.7L21 8 M21 3v5h-5',
  stop: 'M18 6 6 18 M6 6l12 12',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 7.5-2',
  panel: 'M3 4h18v16H3z M15 4v16',
  find: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.35-4.35',
  up: 'M18 15l-6-6-6 6',
  down: 'M6 9l6 6 6-6',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3',
  send: 'M22 2 11 13 M22 2l-7 20-4-9-9-4z',
  jarvis: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  alert: 'M12 9v4 M12 17h.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
};

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null && text !== '') e.textContent = String(text);
  return e;
}

function ico(name, cls = 'wb-i') {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', cls);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', P[name] || P.find);
  s.append(p);
  return s;
}

function btn(name, label, cls = 'wb-btn') {
  const b = h('button', cls);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(name === 'x' ? icon('x', 'x-ico') : ico(name));
  return b;
}

function textBtn(text, cls = 'rv-btn') {
  const b = h('button', cls, text);
  b.type = 'button';
  return b;
}

/** "https://www.pantip.com/topic/1?x" → { secure, host: "pantip.com", rest: "/topic/1?x" } */
export function splitAddress(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { secure: false, host: url, rest: '' };
    return { secure: u.protocol === 'https:', host: u.host.replace(/^www\./, ''), rest: (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash };
  } catch {
    return { secure: false, host: String(url || ''), rest: '' };
  }
}

const httpUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

function loadSplit() {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    if (v >= SPLIT_MIN && v <= SPLIT_MAX) return v;
  } catch { /* storage unavailable */ }
  return 0.64;
}

export class WebViewer {
  /**
   * o: { viewer: StageViewer, api, home, speak(text), notice(text, level),
   *      onThinking(on), voiceAsk(cb): starts the mic and calls cb(text) once }
   */
  constructor(o) {
    this.o = o;
    this.viewer = o.viewer;
    this.api = o.api;
    this.tabs = new Map(); // main tab id → wt
    this.ready = false; // the viewer finished its open transition
    this.split = loadSplit();
    this.sent = ''; // last web:bounds payload (skip duplicates)
    this.thinking = new Set();
    this.last = null; // { url, title, tldr } for LAST REPLY
    this.lastAt = 0;
    this._buildPrompts();
    this.api.on('web:tab', (m) => this._onTab(m));
    this.api.on('web:prompt', (m) => this._onPrompt(m));
    this.api.on('web:summary', (m) => this._onSummary(m));
    this.viewer.onChange((ev) => this._onViewer(ev));
    addEventListener('resize', () => this.sync());
    document.addEventListener('visibilitychange', () => this.sync());
    // overlays that must sit above the page (menu, dialogs, floating cards) toggle hidden / class
    new MutationObserver(() => this.sync()).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  }

  /** The current viewer tab, when it is a web page. */
  get current() {
    const t = this.viewer.current;
    return t && t.kind === 'web' && t.ctl && t.ctl.web ? t.ctl.web : null;
  }

  // ---------- open ----------
  /**
   * Open a page in a new viewer tab.
   * opts: { initiator: 'jarvis' | 'user', question?, speak?: speak the TL;DR, title? }
   */
  async open(url, opts = {}) {
    const initiator = opts.initiator === 'user' ? 'user' : 'jarvis';
    let r;
    try {
      r = await this.api.invoke('web:open', { url: String(url || ''), initiator, question: String(opts.question || '').slice(0, 500) });
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    if (!r || !r.ok) {
      this.o.notice(`เปิดหน้าเว็บไม่ได้${r && r.error ? ` — ${r.error}` : ''}`, 'warn');
      return null;
    }
    return this._ensureTab(r.tabId, { url: r.url, question: opts.question || '', speak: opts.speak !== false, title: opts.title || '', jarvis: initiator === 'jarvis' });
  }

  _ensureTab(tabId, opts = {}) {
    let wt = this.tabs.get(tabId);
    if (wt) {
      this.viewer.select(wt.stageId);
      return wt;
    }
    wt = {
      id: tabId,
      stageId: `web-${tabId}`,
      st: { url: opts.url || '', title: opts.title || '', loading: true, progress: 0.05, jarvis: !!opts.jarvis },
      question: opts.question || '',
      speak: !!opts.speak,
      summary: null,
      panelHidden: false,
      el: null,
      shot: '',
      visible: false,
      frozen: false,
      answers: [],
    };
    this.tabs.set(tabId, wt);
    this.viewer.open({
      id: wt.stageId,
      kind: 'web',
      icon: 'web',
      title: wt.st.title || splitAddress(wt.st.url).host || 'เว็บ',
      meta: '',
      padded: false,
      hideExt: true,
      external: () => httpUrl(wt.st.url) || null,
      mount: (body) => this._mount(wt, body),
    });
    return wt;
  }

  // ---------- DOM ----------
  _mount(wt, body) {
    const root = h('div', 'wb');
    root.style.setProperty('--split', `${(this.split * 100).toFixed(2)}%`);
    const site = h('div', 'wb-site');

    const bar = h('div', 'wb-bar');
    const back = btn('back', 'ย้อนกลับ (Alt+←)');
    const fwd = btn('fwd', 'ไปข้างหน้า (Alt+→)');
    const reload = btn('reload', 'โหลดใหม่ (Ctrl+R)');
    const addr = h('div', 'wb-addr');
    const addrView = h('button', 'wb-addr-view');
    addrView.type = 'button';
    addrView.title = 'แก้ที่อยู่ (Ctrl+L)';
    const lock = h('span', 'wb-lock');
    const host = h('span', 'wb-host');
    const rest = h('span', 'wb-rest');
    addrView.append(lock, host, rest);
    const addrInput = h('input', 'wb-addr-input');
    addrInput.type = 'text';
    addrInput.spellcheck = false;
    addrInput.hidden = true;
    addrInput.setAttribute('aria-label', 'ที่อยู่เว็บ');
    addr.append(addrView, addrInput);
    const jchip = h('span', 'wb-jarvis', 'JARVIS');
    jchip.title = 'JARVIS เปิดหน้านี้ (อ่านอย่างเดียว)';
    const panelBtn = btn('panel', 'ซ่อน/แสดงสรุป (ขยายเว็บ)');
    const ext = textBtn('เปิดในเบราว์เซอร์จริง', 'wb-ext');
    const close = btn('x', 'ปิดแท็บ (Ctrl+W)');
    bar.append(back, fwd, reload, addr, jchip, panelBtn, ext, close);

    const prog = h('div', 'wb-prog');
    const progBar = h('i');
    prog.append(progBar);

    const page = h('div', 'wb-page');
    const shot = h('img', 'wb-shot');
    shot.alt = '';
    shot.hidden = true;
    const skel = h('div', 'wb-skel');
    for (let i = 0; i < 7; i++) skel.append(h('div', `sk-line${i === 0 ? ' w40' : i % 3 === 2 ? ' w70' : ''}`));
    const over = h('div', 'wb-over'); // crash / unresponsive notice (only when the native view is hidden)
    over.hidden = true;
    page.append(skel, shot, over);

    const foot = h('div', 'wb-foot');
    const status = h('span', 'wb-status');
    const find = h('div', 'wb-find');
    find.hidden = true;
    const findIn = h('input', 'wb-find-in');
    findIn.type = 'text';
    findIn.placeholder = 'ค้นหาในหน้า';
    findIn.setAttribute('aria-label', 'ค้นหาในหน้า');
    const findCount = h('span', 'wb-find-n');
    const findUp = btn('up', 'ก่อนหน้า (Shift+Enter)');
    const findDown = btn('down', 'ถัดไป (Enter)');
    const findX = btn('x', 'ปิดการค้นหา (Esc)');
    find.append(ico('find', 'wb-i dim'), findIn, findCount, findUp, findDown, findX);
    foot.append(status, find);
    site.append(bar, prog, page, foot);

    const div = h('div', 'wb-div');
    div.tabIndex = 0;
    div.setAttribute('role', 'separator');
    div.setAttribute('aria-orientation', 'vertical');
    div.setAttribute('aria-label', 'ปรับขนาดเว็บ / สรุป');
    div.setAttribute('aria-valuemin', String(SPLIT_MIN * 100));
    div.setAttribute('aria-valuemax', String(SPLIT_MAX * 100));

    const panel = h('aside', 'wb-panel');
    panel.setAttribute('aria-label', 'สรุปหน้าเว็บ');
    const panelBody = h('div', 'wp');
    panel.append(panelBody);

    root.append(site, div, panel);
    body.append(root);
    wt.el = { root, site, bar, back, fwd, reload, addr, addrView, addrInput, lock, host, rest, jchip, panelBtn, ext, close, prog, progBar, page, shot, skel, over, foot, status, find, findIn, findCount, div, panel, panelBody };

    // ---- bar ----
    back.addEventListener('click', () => this.nav(wt, 'back'));
    fwd.addEventListener('click', () => this.nav(wt, 'forward'));
    reload.addEventListener('click', () => this.nav(wt, wt.st.loading ? 'stop' : 'reload'));
    addrView.addEventListener('click', () => this.editAddress(wt));
    addrInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = addrInput.value.trim();
        this._endAddress(wt);
        if (v) this.api.invoke('web:nav', { tabId: wt.id, action: 'go', url: v }).catch(() => {});
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this._endAddress(wt);
      }
    });
    addrInput.addEventListener('blur', () => this._endAddress(wt));
    panelBtn.addEventListener('click', () => this.togglePanel(wt));
    ext.addEventListener('click', () => this.openExternal(wt));
    close.addEventListener('click', () => this.viewer.close(wt.stageId));

    // ---- find ----
    findIn.addEventListener('input', () => this.api.invoke('web:find', { tabId: wt.id, text: findIn.value }).catch(() => {}));
    findIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.api.invoke('web:find', { tabId: wt.id, text: findIn.value, next: true, forward: !e.shiftKey }).catch(() => {});
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeFind(wt);
      }
    });
    findUp.addEventListener('click', () => this.api.invoke('web:find', { tabId: wt.id, text: findIn.value, next: true, forward: false }).catch(() => {}));
    findDown.addEventListener('click', () => this.api.invoke('web:find', { tabId: wt.id, text: findIn.value, next: true, forward: true }).catch(() => {}));
    findX.addEventListener('click', () => this.closeFind(wt));

    // ---- divider ----
    this._divider(wt);

    this._renderState(wt);
    this._renderPanel(wt);
    const ro = new ResizeObserver(() => this.sync());
    ro.observe(page);
    ro.observe(root);

    const ctl = {
      web: wt,
      items: [],
      external: () => httpUrl(wt.st.url) || null,
      onShow: () => { wt.visible = false; this.sync(); },
      onHide: () => { this._hideNow(wt); },
      escape: () => {
        if (!find.hidden) { this.closeFind(wt); return true; }
        if (!addrInput.hidden) { this._endAddress(wt); return true; }
        return false;
      },
      // closing the viewer: swap the live page for a screenshot so it can shrink into the reactor
      freeze: async () => {
        wt.frozen = true;
        await this._snapshot(wt);
        this._hideNow(wt);
        this.api.invoke('web:pause', wt.id).catch(() => {});
      },
      dispose: () => {
        ro.disconnect();
        wt.frozen = true;
        this._hideNow(wt);
        this.tabs.delete(wt.id);
        this._setThinking(wt.id, false);
        this.api.invoke('web:close', wt.id).catch(() => {});
      },
    };
    wt.ctl = ctl;
    return ctl;
  }

  _divider(wt) {
    const { div, root } = wt.el;
    const set = (f, save) => {
      this.split = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, f));
      for (const t of this.tabs.values()) if (t.el) t.el.root.style.setProperty('--split', `${(this.split * 100).toFixed(2)}%`);
      div.setAttribute('aria-valuenow', String(Math.round(this.split * 100)));
      this.sync();
      if (save) { try { localStorage.setItem(SPLIT_KEY, String(this.split)); } catch { /* storage unavailable */ } }
    };
    div.setAttribute('aria-valuenow', String(Math.round(this.split * 100)));
    div.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      div.setPointerCapture(e.pointerId);
      div.classList.add('drag');
      // the native page can't receive the drag: freeze it into a screenshot while dragging
      let raf = 0;
      const move = (ev) => {
        const r = root.getBoundingClientRect();
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => set((ev.clientX - r.left) / r.width, false));
      };
      const up = () => {
        div.classList.remove('drag');
        div.removeEventListener('pointermove', move);
        div.removeEventListener('pointerup', up);
        div.removeEventListener('pointercancel', up);
        set(this.split, true);
      };
      div.addEventListener('pointermove', move);
      div.addEventListener('pointerup', up);
      div.addEventListener('pointercancel', up);
    });
    div.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        set(this.split + (e.key === 'ArrowLeft' ? -0.02 : 0.02), true);
      }
    });
    div.addEventListener('dblclick', () => set(0.64, true));
  }

  // ---------- native view placement ----------
  /** Recompute the footer band + page rect and tell main where (and whether) to show the page. */
  sync() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._syncNow();
    });
  }

  _syncNow() {
    const wt = this.current;
    for (const t of this.tabs.values()) if (t !== wt && t.visible) t.visible = false;
    if (!wt || !wt.el) {
      this._send(null, false);
      return;
    }
    this._layoutFoot(wt);
    const show = this._canShow(wt);
    if (!show && wt.visible) {
      // going under an overlay: screenshot first, so the swap isn't visible
      wt.visible = false;
      // (a PDF can take long to capture: never keep the overlay waiting more than 250 ms)
      Promise.race([this._snapshot(wt), new Promise((r) => setTimeout(r, 250))]).finally(() => { if (!wt.visible) this._send(wt, false); });
      return;
    }
    wt.visible = show;
    if (!show) {
      this._send(wt, false);
      return;
    }
    const r = wt.el.page.getBoundingClientRect();
    this._send(wt, true, { x: r.left, y: r.top, width: r.width, height: r.height });
  }

  _canShow(wt) {
    const why = this._hiddenReason(wt);
    if (why && window.__webDebug) console.log('[web] hidden:', why);
    return !why;
  }

  _hiddenReason(wt) {
    const v = this.viewer;
    if (!v.mode || !v.want || v.busy || !this.ready) return 'transition';
    if (wt.frozen) return 'frozen';
    if (wt.st.crashed) return 'crashed';
    if (document.visibilityState !== 'visible') return 'window hidden';
    if (!wt.el.root.isConnected || wt.el.root.closest('[hidden]')) return 'detached';
    return this._occluded();
  }

  /** Something in HTML must be on top of the page right now. */
  _occluded() {
    const shown = (id) => { const n = document.getElementById(id); return n && !n.hidden; };
    if (!this.o.home.visible) return 'section';
    const over = ['menu', 'approval', 'barge', 'hf-consent'].find(shown);
    if (over) return over;
    if (document.querySelector('.card.floating')) return 'floating card';
    if (document.querySelector('.web-prompt-wrap .web-prompt.over')) return 'prompt';
    return '';
  }

  /** Footer height: enough to keep the mini reactor (bottom-left corner) off the page. */
  _layoutFoot(wt) {
    const { site, foot } = wt.el;
    const b = this.viewer.badge ? this.viewer.badge() : null;
    const sr = site.getBoundingClientRect();
    let fh = FOOT_MIN;
    if (b && b.cx - b.r < sr.right && b.cx + b.r > sr.left) fh = Math.max(FOOT_MIN, Math.ceil(sr.bottom - (b.cy - b.r)) + 6);
    fh = Math.min(fh, Math.max(FOOT_MIN, sr.height * 0.3));
    wt.el.root.style.setProperty('--foot', `${fh}px`);
    if (b) foot.style.paddingLeft = `${Math.max(16, Math.ceil(b.cx + b.r - sr.left) + 12)}px`;
  }

  _send(wt, visible, rect = null) {
    const payload = { tabId: wt ? wt.id : null, visible, rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
    const key = JSON.stringify(payload);
    if (key === this.sent) return;
    this.sent = key;
    if (window.__webDebug) console.log('[web] bounds', key);
    this.api.invoke('web:bounds', payload).catch(() => {});
  }

  _hideNow(wt) {
    wt.visible = false;
    if (this.current === wt || !this.current) this._send(wt, false);
  }

  async _snapshot(wt) {
    try {
      const url = await this.api.invoke('web:capture', wt.id);
      if (url && wt.el) {
        wt.shot = url;
        wt.el.shot.src = url;
        wt.el.shot.hidden = false;
        wt.el.skel.hidden = true;
      }
    } catch { /* keep the previous one */ }
  }

  // ---------- main → renderer ----------
  _onTab(m) {
    if (!m || !m.tabId && m.type !== 'download') return;
    if (m.type === 'opened') {
      if (m.initiator === 'page') this._ensureTab(m.tabId, { speak: false });
      return;
    }
    if (m.type === 'download') {
      this.o.notice(m.ok ? `ดาวน์โหลดเสร็จ: ${m.name}` : `ดาวน์โหลดไม่สำเร็จ: ${m.name}`, m.ok ? 'info' : 'warn');
      return;
    }
    const wt = this.tabs.get(m.tabId);
    if (m.type === 'closed') {
      if (wt) this.viewer.close(wt.stageId);
      return;
    }
    if (!wt) return;
    if (m.type === 'state') {
      const was = wt.st;
      wt.st = { ...wt.st, ...m };
      this._renderState(wt);
      // a different page: answers about the old one no longer apply
      if (wt.answers.length && was.url && m.url && was.url.replace(/#.*$/, '') !== m.url.replace(/#.*$/, '')) {
        wt.answers = [];
        this._renderAnswers(wt);
      }
      if (was.url !== m.url || was.title !== m.title || was.favicon !== m.favicon) {
        this.viewer.update(wt.stageId, { title: m.title || splitAddress(m.url).host || 'เว็บ' });
        if (wt.el && wt.el.src) {
          const n = this._source(wt, wt.summary && wt.summary.source);
          wt.el.src.replaceWith(n);
          wt.el.src = n;
        }
      }
      if (!was.loading && m.loading && wt.st.jarvis) this._status(wt, `JARVIS กำลังเปิด ${splitAddress(m.url).host}`);
      if (!!m.crashed !== !!was.crashed) this.sync();
      return;
    }
    if (m.type === 'find') {
      if (wt.el) wt.el.findCount.textContent = m.matches ? `${m.active}/${m.matches}` : 'ไม่พบ';
      return;
    }
    if (m.type === 'key') this._key(wt, m.key);
  }

  _key(wt, key) {
    switch (key) {
      case 'address': this.editAddress(wt); break;
      case 'find': this.openFind(wt); break;
      case 'close-tab': this.viewer.close(wt.stageId); break;
      case 'next-tab': this.viewer.select(1); break;
      case 'prev-tab': this.viewer.select(-1); break;
      case 'escape': if (wt.el && !wt.el.find.hidden) this.closeFind(wt); break;
      default: break;
    }
  }

  _renderState(wt) {
    const e = wt.el;
    if (!e) return;
    const st = wt.st;
    const a = splitAddress(st.url);
    e.lock.replaceChildren(ico(a.secure ? 'lock' : 'unlock', `wb-i ${a.secure ? 'ok' : 'warn'}`));
    e.lock.title = a.secure ? 'การเชื่อมต่อปลอดภัย (HTTPS)' : 'ไม่ได้เข้ารหัส (HTTP)';
    e.host.textContent = a.host;
    e.rest.textContent = a.rest;
    e.addrView.title = st.url;
    e.back.disabled = !st.canGoBack;
    e.fwd.disabled = !st.canGoForward;
    e.reload.replaceChildren(ico(st.loading ? 'stop' : 'reload'));
    e.reload.title = st.loading ? 'หยุดโหลด' : 'โหลดใหม่ (Ctrl+R)';
    e.jchip.hidden = !st.jarvis;
    e.prog.classList.toggle('on', !!st.loading);
    e.progBar.style.transform = `scaleX(${Math.max(0.02, Math.min(1, st.progress || 0))})`;
    e.skel.hidden = !!wt.shot || !!st.crashed; // backdrop until the first screenshot exists
    // crash / hang notice (the native view is hidden while crashed)
    if (st.crashed) {
      e.over.hidden = false;
      e.over.replaceChildren(this._overBox('หน้าเว็บหยุดทำงาน', 'โหลดใหม่', () => this.nav(wt, 'reload')));
    } else if (st.unresponsive) {
      e.over.hidden = true;
      this._status(wt, 'หน้าเว็บไม่ตอบสนอง — กด Ctrl+R เพื่อโหลดใหม่');
    } else {
      e.over.hidden = true;
    }
    if (st.error) this._status(wt, `เปิดหน้าไม่ได้ — ${st.error.text || st.error.code}`);
    else if (st.loading) this._status(wt, st.jarvis ? `JARVIS กำลังเปิด ${a.host}` : `กำลังโหลด ${a.host}…`);
    else if (!st.unresponsive) this._status(wt, '');
  }

  _overBox(text, action, fn) {
    const box = h('div', 'wb-over-box');
    box.append(ico('alert', 'wb-i big'), h('div', 'wb-over-t', text));
    const b = textBtn(action, 'rv-btn primary');
    b.addEventListener('click', fn);
    box.append(b);
    return box;
  }

  _status(wt, text) {
    if (wt.el) wt.el.status.textContent = text || '';
  }

  // ---------- actions ----------
  nav(wt, action) {
    if (!wt) return;
    this.api.invoke('web:nav', { tabId: wt.id, action }).catch(() => {});
  }

  editAddress(wt) {
    const e = wt && wt.el;
    if (!e) return;
    e.addrView.hidden = true;
    e.addrInput.hidden = false;
    e.addrInput.value = wt.st.url || '';
    e.addrInput.focus();
    e.addrInput.select();
  }

  _endAddress(wt) {
    const e = wt && wt.el;
    if (!e || e.addrInput.hidden) return;
    e.addrInput.hidden = true;
    e.addrView.hidden = false;
  }

  openFind(wt) {
    const e = wt && wt.el;
    if (!e) return;
    e.find.hidden = false;
    e.status.hidden = true;
    e.findIn.focus();
    e.findIn.select();
    if (e.findIn.value) this.api.invoke('web:find', { tabId: wt.id, text: e.findIn.value }).catch(() => {});
  }

  closeFind(wt) {
    const e = wt && wt.el;
    if (!e) return;
    e.find.hidden = true;
    e.status.hidden = false;
    e.findCount.textContent = '';
    this.api.invoke('web:find', { tabId: wt.id, text: '' }).catch(() => {});
    this.api.invoke('web:focus', wt.id).catch(() => {});
  }

  togglePanel(wt, hide) {
    if (!wt || !wt.el) return;
    wt.panelHidden = hide == null ? !wt.panelHidden : hide;
    wt.el.root.classList.toggle('no-panel', wt.panelHidden);
    wt.el.panelBtn.classList.toggle('on', wt.panelHidden);
    this.sync();
  }

  openExternal(wt) {
    const u = wt && httpUrl(wt.st.url);
    if (u) this.api.invoke('web:open-external', u).catch(() => {});
  }

  // ---------- viewer lifecycle ----------
  _onViewer(ev) {
    if (ev === 'opened') {
      this.ready = true;
      this.sync();
    } else if (ev === 'closed') {
      this.ready = false;
      this._send(null, false);
    } else if (ev === 'select' || ev === 'layout' || ev === 'close') {
      this.sync();
    }
  }

  /** LAST REPLY: "เปิดหน้าเว็บอีกครั้ง" + the TL;DR. Called by the Result Viewer when the viewer closes. */
  offerReopen() {
    const l = this.last;
    if (!l) return false;
    this.o.home.cards.setReplyReopen(() => this.open(l.url, { initiator: 'jarvis', speak: false }), 'เปิดหน้าเว็บอีกครั้ง');
    if (l.tldr) this.o.home.reply(l.tldr);
    return true;
  }

  // ---------- on-screen prompts (permissions, external apps, confirmations) ----------
  _buildPrompts() {
    const wrap = h('div', 'web-prompt-wrap');
    wrap.setAttribute('aria-live', 'polite');
    document.body.append(wrap);
    this.promptWrap = wrap;
    this.promptEls = new Map();
  }

  _onPrompt(m) {
    if (!m || !m.id) return;
    if (m.close) {
      const el = this.promptEls.get(m.id);
      if (el) el.remove();
      this.promptEls.delete(m.id);
      return;
    }
    let text = '';
    if (m.kind === 'permission') text = `${m.origin.replace(/^https?:\/\//, '')} ขอใช้${m.what}`;
    else if (m.kind === 'external') text = `หน้าเว็บขอเปิดโปรแกรมภายนอก: ${m.url}`;
    else return;
    const remember = m.kind === 'permission';
    this.confirm(text, {
      yes: m.kind === 'external' ? 'เปิด' : 'อนุญาต',
      no: m.kind === 'external' ? 'ยกเลิก' : 'ไม่อนุญาต',
      remember,
      id: m.id,
    }).then((r) => this.api.invoke('web:prompt-respond', { id: m.id, allow: r.allow, remember: r.remember }).catch(() => {}));
  }

  /** Small click-only prompt at the bottom right (never under the native page). → { allow, remember } */
  confirm(text, { yes = 'ยืนยัน', no = 'ยกเลิก', remember = false, id = `c${Date.now()}` } = {}) {
    return new Promise((resolve) => {
      const box = h('div', 'web-prompt');
      box.setAttribute('role', 'alertdialog');
      box.append(h('div', 'web-prompt-t', text));
      let rem = null;
      if (remember) {
        const lab = h('label', 'check web-prompt-rem');
        rem = h('input');
        rem.type = 'checkbox';
        lab.append(rem, document.createTextNode(' จำไว้สำหรับเว็บนี้'));
        box.append(lab);
      }
      const row = h('div', 'row');
      const ok = textBtn(yes, 'rv-btn primary');
      const cancel = textBtn(no, 'rv-btn');
      row.append(ok, cancel);
      box.append(row);
      const done = (allow) => {
        box.remove();
        this.promptEls.delete(id);
        resolve({ allow, remember: !!(rem && rem.checked) });
      };
      ok.addEventListener('click', (e) => { if (e.isTrusted) done(true); });
      cancel.addEventListener('click', () => done(false));
      this.promptEls.set(id, box);
      this.promptWrap.append(box);
      // overlapping the page area? then the page hides while the prompt is up
      const r = box.getBoundingClientRect();
      const wt = this.current;
      if (wt && wt.el) {
        const pr = wt.el.page.getBoundingClientRect();
        if (r.left < pr.right && r.right > pr.left && r.top < pr.bottom && r.bottom > pr.top) box.classList.add('over');
      }
      this.sync();
      ok.focus();
    });
  }

  // ---------- summary panel ----------
  _setThinking(id, on) {
    if (on) this.thinking.add(id);
    else this.thinking.delete(id);
    if (this.o.onThinking) this.o.onThinking(this.thinking.size > 0);
  }

  _onSummary(m) {
    const wt = m && this.tabs.get(m.tabId);
    if (!wt) return;
    if (m.kind === 'answer') {
      this._addAnswer(wt, m);
      return;
    }
    wt.summary = m;
    this._setThinking(wt.id, m.state === 'loading');
    this._renderPanel(wt);
    if (m.state === 'ready' && m.tldr) {
      this.last = { url: m.source && m.source.url ? m.source.url : wt.st.url, title: (m.source && m.source.title) || wt.st.title, tldr: m.tldr };
      this.lastAt = Date.now();
      if (wt.speak) {
        wt.speak = false;
        this.o.speak(m.answer && m.answer.text ? `${m.answer.text} ${m.tldr}` : m.tldr);
      }
    }
  }

  /** Ask for a fresh summary (mode 'full') or the part after the scroll position ('continue'). */
  summarize(wt, mode = 'full', { speak = true } = {}) {
    if (!wt) return;
    if (speak) wt.speak = true;
    this.api.invoke('web:summarize', { tabId: wt.id, mode, question: wt.question || '' }).catch(() => {});
  }

  highlight(wt, ref) {
    if (!wt || !ref) return;
    this.api.invoke('web:highlight', { tabId: wt.id, ref }).catch(() => {});
  }

  async ask(wt, question) {
    const q = String(question || '').trim();
    if (!wt || !q) return;
    const pending = { question: q, pending: true };
    wt.answers.push(pending);
    this._renderAnswers(wt);
    this._setThinking(`ask-${wt.id}`, true);
    let r;
    try {
      r = await this.api.invoke('web:ask', { tabId: wt.id, question: q });
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    this._setThinking(`ask-${wt.id}`, false);
    Object.assign(pending, { pending: false, ...(r && r.ok ? { text: r.text, refs: r.refs || [] } : { error: (r && r.error) || 'ตอบไม่ได้' }) });
    this._renderAnswers(wt);
    if (r && r.ok && r.refs && r.refs[0]) this.highlight(wt, r.refs[0]);
    return r;
  }

  _addAnswer() { /* answers come back from web:ask directly */ }

  _renderPanel(wt) {
    const e = wt.el;
    if (!e) return;
    const p = e.panelBody;
    p.replaceChildren();
    const s = wt.summary;
    const st = wt.st;
    e.src = this._source(wt, s && s.source);
    p.append(e.src);
    if (!s || s.state === 'loading') {
      const box = h('div', 'wp-loading');
      box.append(h('div', 'wp-loading-t', 'กำลังอ่านหน้าเว็บ…'));
      for (let i = 0; i < 6; i++) box.append(h('div', `sk-line${i % 3 === 2 ? ' w70' : ''}`));
      p.append(box);
    } else if (s.state === 'blocked') {
      const box = h('div', 'wp-note');
      box.append(ico('lock', 'wb-i'), h('div', 'wp-note-t', 'หน้านี้ต้องการให้คุณยืนยัน/ล็อกอินก่อน'), h('div', 'wp-note-s', 'ทำต่อบนหน้าเว็บได้เลย — JARVIS จะสรุปให้อัตโนมัติเมื่อผ่านแล้ว'));
      p.append(box);
    } else if (s.state === 'failed') {
      const box = h('div', 'wp-note fail');
      box.append(h('div', 'wp-note-t', 'สรุปไม่ได้'));
      if (s.error) box.append(h('div', 'wp-note-s', s.error));
      const retry = textBtn('ลองใหม่', 'rv-btn primary');
      retry.addEventListener('click', () => this.summarize(wt, 'full', { speak: false }));
      box.append(retry);
      p.append(box);
    } else {
      this._sections(wt, p, s);
    }
    // ask this page (always available once the page is open)
    p.append(this._askBox(wt));
    if (st.crashed) p.prepend(h('div', 'wp-note fail', 'หน้าเว็บหยุดทำงาน'));
  }

  _source(wt, src = {}) {
    const st = wt.st;
    const box = h('div', 'wp-src');
    const top = h('div', 'wp-src-top');
    const fav = h('span', 'rv-fav');
    const site = (src && src.siteName) || splitAddress(st.url).host;
    fav.textContent = (site || '?').charAt(0).toUpperCase();
    const favUrl = /^https:\/\//i.test(st.favicon || '') ? st.favicon : ''; // the app CSP allows https images only
    if (favUrl) {
      const i = new Image();
      i.className = 'rv-fav-img';
      i.alt = '';
      i.referrerPolicy = 'no-referrer';
      i.addEventListener('load', () => { if (i.naturalWidth > 1) fav.replaceChildren(i); }, { once: true });
      i.src = favUrl;
    }
    top.append(fav, h('span', 'wp-site', site));
    box.append(top, h('div', 'wp-title', (src && src.title) || st.title || st.url));
    const meta = [];
    if (src && src.published) meta.push(src.published);
    if (src && src.author) meta.push(src.author);
    if (src && src.readingMin) meta.push(`อ่าน ~${src.readingMin} นาที`);
    if (meta.length) box.append(h('div', 'wp-meta', meta.join(' · ')));
    return box;
  }

  _sec(label, tag) {
    const sec = h('section', 'wp-sec');
    const lab = h('div', 'wp-label', label);
    if (tag) lab.append(h('span', 'wp-tag', tag));
    sec.append(lab);
    return sec;
  }

  _sections(wt, p, s) {
    // for you: a direct answer to the user's question comes first
    if (s.answer && s.answer.text) {
      const sec = this._sec('สำหรับคุณ');
      if (s.answer.question) sec.append(h('div', 'wp-q', s.answer.question));
      const a = h('p', 'wp-text', s.answer.text);
      sec.append(a);
      if (s.answer.ref) {
        a.classList.add('ref');
        a.title = 'แสดงตำแหน่งบนหน้าเว็บ';
        a.addEventListener('click', () => this.highlight(wt, s.answer.ref));
      }
      p.append(sec);
    }
    if (s.tldr) {
      const sec = this._sec(s.mode === 'continue' ? 'TL;DR · ส่วนถัดไป' : 'TL;DR', s.translatedFrom ? `แปลจาก ${s.translatedFrom}` : '');
      sec.append(h('p', 'wp-text wp-tldr', s.tldr));
      p.append(sec);
    }
    if (s.injection) {
      const note = h('div', 'wp-warn');
      note.append(ico('alert', 'wb-i'), h('span', null, 'หน้านี้มีข้อความที่พยายามสั่ง AI — JARVIS ไม่ได้ทำตาม'));
      p.append(note);
    }
    if (s.keyPoints && s.keyPoints.length) {
      const sec = this._sec('ประเด็นสำคัญ');
      const ul = h('ul', 'wp-points');
      for (const k of s.keyPoints) {
        const li = h('li');
        const b = h('button', 'wp-point', k.text);
        b.type = 'button';
        if (k.ref) {
          b.title = 'เลื่อนไปที่ข้อความนี้บนหน้าเว็บ';
          b.addEventListener('click', () => this.highlight(wt, k.ref));
        } else b.disabled = true;
        li.append(b);
        ul.append(li);
      }
      sec.append(ul);
      if (s.more) {
        const more = textBtn('อ่านต่อ', 'rv-btn');
        more.title = 'สรุปส่วนที่อยู่ถัดจากตำแหน่งที่เลื่อนอยู่';
        more.addEventListener('click', () => this.summarize(wt, 'continue', { speak: false }));
        sec.append(more);
      }
      p.append(sec);
    }
    const rows = s.keyData || [];
    const tables = s.tables || [];
    if (rows.length || tables.length) {
      const sec = this._sec('ข้อมูลสำคัญ');
      if (rows.length) {
        const dl = h('dl', 'wp-data');
        for (const r of rows) {
          const row = h('div', 'wp-row');
          row.append(h('dt', null, r.label), h('dd', null, r.value));
          dl.append(row);
        }
        sec.append(dl);
      }
      for (const t of tables) sec.append(this._table(t));
      p.append(sec);
    }
  }

  _table(t) {
    const box = h('div', 'wp-table');
    const head = h('div', 'wp-table-h');
    head.append(h('span', 'wp-table-c', t.caption || 'ตาราง'));
    const copy = btn('copy', 'คัดลอกตาราง', 'wb-btn small');
    copy.addEventListener('click', () => {
      const lines = [(t.columns || []).join('\t'), ...(t.rows || []).map((r) => r.join('\t'))].filter(Boolean);
      navigator.clipboard.writeText(lines.join('\n')).then(() => { copy.classList.add('done'); setTimeout(() => copy.classList.remove('done'), 1200); }, () => {});
    });
    head.append(copy);
    const wrap = h('div', 'wp-table-scroll');
    const table = h('table', 'rv-table');
    if (t.columns && t.columns.length) {
      const tr = h('tr');
      for (const c of t.columns) tr.append(h('th', null, c));
      const th = h('thead');
      th.append(tr);
      table.append(th);
    }
    const tb = h('tbody');
    for (const r of t.rows || []) {
      const tr = h('tr');
      for (const c of r) tr.append(h('td', null, c));
      tb.append(tr);
    }
    table.append(tb);
    wrap.append(table);
    box.append(head, wrap);
    return box;
  }

  _askBox(wt) {
    const sec = this._sec('ถามหน้านี้');
    sec.classList.add('wp-ask');
    const list = h('div', 'wp-answers');
    wt.el.answers = list;
    const row = h('form', 'wp-ask-row');
    const input = h('input', 'wp-ask-in');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'ถามเกี่ยวกับหน้านี้…';
    input.setAttribute('aria-label', 'ถามเกี่ยวกับหน้านี้');
    const mic = btn('mic', 'ถามด้วยเสียง', 'wb-btn');
    const go = btn('send', 'ถาม', 'wb-btn');
    go.type = 'submit';
    row.append(input, mic, go);
    row.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value;
      input.value = '';
      this.ask(wt, q);
    });
    mic.addEventListener('click', () => {
      if (!this.o.voiceAsk) return;
      mic.classList.add('on');
      this.o.voiceAsk((text) => {
        mic.classList.remove('on');
        if (text) this.ask(wt, text);
      });
    });
    sec.append(list, row);
    this._renderAnswers(wt);
    return sec;
  }

  _renderAnswers(wt) {
    const list = wt.el && wt.el.answers;
    if (!list) return;
    list.replaceChildren();
    for (const a of wt.answers.slice(-6)) {
      const item = h('div', 'wp-ans');
      item.append(h('div', 'wp-q', a.question));
      if (a.pending) item.append(h('div', 'wp-text dim', 'กำลังหาคำตอบในหน้านี้…'));
      else if (a.error) item.append(h('div', 'wp-text dim', a.error));
      else {
        const t = h('p', 'wp-text', a.text);
        item.append(t);
        if (a.refs && a.refs.length) {
          const refs = h('div', 'wp-refs');
          a.refs.slice(0, 4).forEach((ref, i) => {
            const chip = textBtn(String(i + 1), 'rv-ref');
            chip.title = 'แสดงข้อความต้นทางบนหน้าเว็บ';
            chip.addEventListener('click', () => this.highlight(wt, ref));
            refs.append(chip);
          });
          item.append(refs);
        }
      }
      list.append(item);
    }
  }

  // ---------- voice ----------
  /** cmd.op for a web tab → true when handled. */
  command(cmd) {
    const wt = this.current;
    if (!wt) return false;
    switch (cmd.op) {
      case 'summarize': this.summarize(wt, 'full'); return true;
      case 'scroll': this.api.invoke('web:scroll', { tabId: wt.id, dir: cmd.n > 0 ? 'down' : 'up' }).catch(() => {}); return true;
      case 'top': this.api.invoke('web:scroll', { tabId: wt.id, dir: 'top' }).catch(() => {}); return true;
      case 'back': this.nav(wt, 'back'); return true;
      case 'forward': this.nav(wt, 'forward'); return true;
      case 'reload': this.nav(wt, 'reload'); return true;
      case 'next-tab': this.viewer.select(1); return true;
      case 'close-tab': this.viewer.close(wt.stageId); return true;
      case 'expand': this.togglePanel(wt, true); return true;
      case 'external': this.openExternal(wt); return true;
      case 'more': this.summarize(wt, 'continue', { speak: true }); return true;
      case 'click': this.clickLink(wt, cmd.text); return true;
      default: return false;
    }
  }

  /** "คลิกลิงก์ <text>": links only; anything else needs an on-screen click. */
  async clickLink(wt, text) {
    let r;
    try {
      r = await this.api.invoke('web:click-link', { tabId: wt.id, text: String(text || '') });
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    if (r && r.ok) return;
    if (r && r.kind === 'button') {
      const c = await this.confirm(`“${r.label}” เป็นปุ่ม/ฟอร์ม ไม่ใช่ลิงก์ — กดปุ่มนี้บนหน้าเว็บ?`, { yes: 'กดปุ่ม', no: 'ยกเลิก' });
      if (c.allow) this.api.invoke('web:click-link', { tabId: wt.id, text: String(text || ''), confirmed: true }).catch(() => {});
      return;
    }
    this.o.speak(r && r.error ? r.error : `ไม่พบลิงก์ ${text}`);
  }
}
