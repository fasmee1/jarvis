// Conversation popup: the old TALK page, shown over the home HUD as a dialog.
// It is one more surface of the shared large viewer (ui/stage-viewer.js), so it
// uses the same transition (cards dock, it grows out of the reactor, the reactor
// becomes a live badge on its bottom-left corner) and never shares the screen
// with the Result / Web Viewer.
//
// The DOM (index.html #cv) keeps the ids the app already wires (#chat, #input,
// #btn-folder, #perm-mode, …), so the chat, the composer and every toolbar
// action are the same code as before. Opening / closing only shows / hides
// it: the Claude Code session, the messages, the scroll position and the draft
// all stay as they are.

const $ = (id) => document.getElementById(id);
const FIELD = 'input, textarea, [contenteditable=""], [contenteditable="true"]';
const FOCUSABLE = 'button, select, textarea, input, a[href], summary, [tabindex]:not([tabindex="-1"])';
const MAX_LINES = 6;
const TERM_KEY = 'jarvis.cvTermHeight';

function isField(n) {
  return !!n && n !== document.body && (n.matches(FIELD) || n.isContentEditable);
}

/** "D:\very\long\path\project" → "D:\very\…\project" (keeps both ends). */
export function middleEllipsis(s, max) {
  const t = String(s || '');
  if (t.length <= max) return t;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  return `${t.slice(0, head)}…${t.slice(t.length - (keep - head))}`;
}

export class ConversationPopup {
  /**
   * o: { viewer: StageViewer, home: Home, canKey(): boolean — no menu / dialog / section / boot on top,
   *      onOpenInteractive(): void, onOpen?(), onClose?() }
   */
  constructor(o) {
    this.o = o;
    this.viewer = o.viewer;
    this.root = $('cv');
    this.chat = $('chat');
    this.input = $('input');
    this.head = $('cv-head');
    this.more = $('cv-more');
    this.menu = $('cv-more-menu');
    this.term = $('cv-term');
    this.firstNew = null; // first message added while the popup was closed
    this.scroll = { top: 0, bottom: true };
    this.focusNext = null;
    this.seen = false; // opened at least once (the first open has no "ข้อความใหม่" marker)
    this.cwd = '';
    const inner = this.root.querySelector('.cv-inner');
    this.viewer.registerSurface('talk', {
      root: this.root,
      fill: this.root.querySelector('.sv-fill'),
      frame: this.root.querySelector('.sv-frame'),
      inner,
      head: this.head,
      bodies: inner.querySelector('.cv-pane'),
      foot: inner.querySelector('.cv-foot'),
    }, {
      beforeShow: () => this._beforeShow(),
      focus: () => this._focusIn(),
      shown: () => { this._layoutBadge(); this._fit(); },
      hidden: () => this._closeMore(false),
    });
    this.viewer.onChange((ev) => { if (ev === 'layout') this._layoutBadge(); });
    addEventListener('resize', () => { if (this.isFront) this._layoutBadge(); });

    $('cv-close').addEventListener('click', () => this.close());
    this._wireInput();
    this._wireOverflow();
    this._wireTerminal();
    this._watchMessages();
    addEventListener('keydown', (e) => this._key(e), true);
  }

  /** Requested open (it may sit behind the viewer for a moment). */
  get isOpen() {
    return this.viewer.surfaceOpen('talk');
  }

  /** Open and in front of the viewer (what the user sees, or is about to). */
  get isFront() {
    return this.isOpen && this.viewer._target() === 'talk';
  }

  /** opts.focus: element to focus instead of the message input (e.g. the voice-confirm box). */
  open(opts = {}) {
    this.focusNext = opts.focus || null;
    if (this.isFront) {
      if (this.viewer.shown === 'talk' && !this.viewer.busy) this._focusIn();
      return;
    }
    this.viewer.showSurface('talk');
    if (this.o.onOpen) this.o.onOpen();
  }

  close() {
    if (!this.isOpen) return;
    this._saveScroll();
    this._closeMore(false);
    this.viewer.hideSurface('talk');
    if (this.o.onClose) this.o.onClose();
  }

  toggle() {
    if (this.isFront) this.close();
    else this.open();
  }

  // ---------- show / hide ----------
  _saveScroll() {
    const c = this.chat;
    if (!c.clientHeight) return; // already hidden: keep what we had
    this.scroll = { top: c.scrollTop, bottom: c.scrollHeight - c.scrollTop - c.clientHeight < 24 };
  }

  _beforeShow() {
    this._layoutBadge();
    const c = this.chat;
    c.querySelector('.cv-new-mark')?.remove();
    const first = this.firstNew;
    this.firstNew = null;
    const seenBefore = this.seen;
    this.seen = true;
    if (first && first.isConnected && seenBefore) {
      // messages arrived while closed: a "ข้อความใหม่" marker, then the newest at the bottom
      const mark = document.createElement('div');
      mark.className = 'cv-new-mark';
      mark.setAttribute('role', 'separator');
      mark.textContent = 'ข้อความใหม่';
      first.before(mark);
      c.scrollTop = c.scrollHeight;
    } else if (this.scroll.bottom) {
      c.scrollTop = c.scrollHeight;
    } else {
      c.scrollTop = this.scroll.top;
    }
    this._grow();
  }

  _focusIn() {
    const n = this.focusNext;
    this.focusNext = null;
    const target = n && n.isConnected && !n.closest('[hidden]') ? n : this.input;
    target.focus({ preventScroll: true });
    // the draft is kept: put the caret at its end
    if (target === this.input) { const l = this.input.value.length; this.input.setSelectionRange(l, l); }
  }

  /** Messages appended while the popup is not on screen get the "ข้อความใหม่" marker on open. */
  _watchMessages() {
    new MutationObserver((list) => {
      if (this.viewer.shown === 'talk' || this.firstNew) return;
      for (const m of list) {
        const n = [...m.addedNodes].find((x) => x.nodeType === 1 && !x.classList.contains('cv-new-mark'));
        if (n) { this.firstNew = n; return; }
      }
    }).observe(this.chat, { childList: true });
    this.chat.addEventListener('scroll', () => { if (this.viewer.shown === 'talk') this._saveScroll(); }, { passive: true });
  }

  /** Keep the input and messages clear of the reactor badge in the bottom-left corner. */
  _layoutBadge() {
    const b = this.viewer.badge ? this.viewer.badge('talk') : null;
    const inner = this.root.querySelector('.cv-inner');
    const r = inner.getBoundingClientRect();
    if (!b || !r.width) return;
    const clear = Math.max(24, Math.ceil(b.cx + b.r - r.left) + 16);
    inner.style.setProperty('--cv-badge', `${clear}px`);
  }

  // ---------- keys: Tab opens / closes, Esc closes, focus stays inside ----------
  _key(e) {
    if (!this.o.canKey()) return; // menu, dialogs, sections and the boot sequence come first
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) this._tab(e);
    else if (e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) this._space(e);
    else if (e.key === 'Escape' && this.isFront) {
      if (!this.menu.hidden) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this._closeMore(true);
        return;
      }
      // a panel over the messages (history) closes first
      if (this.o.onEscape && this.o.onEscape()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      e.preventDefault();
      this.close(); // Esc keeps propagating, so a reply being spoken stops too (as before)
    }
  }

  _tab(e) {
    const a = document.activeElement;
    if (!this.isFront) {
      // on the HUD: Tab opens the conversation unless you are typing somewhere
      if (e.shiftKey || isField(a) || this.viewer._target() === 'projects') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.open();
      return;
    }
    const inside = a && a !== this.root && this.root.contains(a);
    if (!inside) {
      // nothing focused in the popup: Tab closes it when there is no draft, else goes to the draft
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.shiftKey && !this.input.value.trim()) this.close();
      else this.input.focus();
      return;
    }
    // inside: normal focus navigation, trapped in the popup
    const f = this._focusables();
    if (!f.length) return;
    const i = f.indexOf(a);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  }

  /**
   * Space on the HUD also opens the conversation (open only: inside the popup Space types /
   * presses buttons as usual). Not while typing, in a dropdown, or over the Result / Web
   * Viewer (Space scrolls / plays there). Ctrl+Space stays push-to-talk.
   */
  _space(e) {
    if (this.isOpen || this.viewer._target()) return;
    const a = document.activeElement;
    if (isField(a) || (a && a.matches('select'))) return;
    e.preventDefault(); // a focused HUD button (e.g. the reactor) is not pressed
    e.stopImmediatePropagation();
    if (!e.repeat) this.open();
  }

  _focusables() {
    return [...this.root.querySelectorAll(FOCUSABLE)].filter((n) => !n.disabled && !n.closest('[hidden]') && n.getClientRects().length);
  }

  // ---------- input: grows to 6 lines ----------
  _wireInput() {
    this.input.addEventListener('input', () => this._grow());
  }

  /** Call after the app changes the input's value (e.g. cleared after sending). */
  inputChanged() {
    this._grow();
  }

  _grow() {
    const t = this.input;
    if (!t.isConnected || this.root.hidden) return;
    const cs = getComputedStyle(t);
    const line = parseFloat(cs.lineHeight) || 24;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    t.style.height = 'auto';
    const h = Math.min(t.scrollHeight, line * MAX_LINES + pad);
    t.style.height = `${Math.max(h, line + pad)}px`;
    t.style.overflowY = t.scrollHeight > line * MAX_LINES + pad + 1 ? 'auto' : 'hidden';
  }

  // ---------- folder ----------
  /** The working directory: middle-ellipsized on the button, full path in the tooltip. */
  setCwd(path) {
    this.cwd = path || '';
    const b = $('btn-folder');
    b.title = this.cwd ? `โฟลเดอร์งาน: ${this.cwd} — คลิกเพื่อเปลี่ยน` : 'ยังไม่ได้เลือกโฟลเดอร์ — คลิกเพื่อเลือก';
    this._renderCwd();
  }

  _renderCwd() {
    const span = $('cwd-path');
    const narrow = this.head.clientWidth && this.head.clientWidth < 1000;
    span.textContent = this.cwd ? middleEllipsis(this.cwd, narrow ? 24 : 40) : 'ยังไม่ได้เลือกโฟลเดอร์';
  }

  // ---------- toolbar overflow ("⋯") ----------
  _wireOverflow() {
    // least-used first; the folder, the mode and × never collapse
    this.slots = ['btn-sfx', 'btn-interactive', 'btn-new-summary', 'btn-new', 'btn-history', 'session-id', 'btn-code', 'btn-teach', 'btn-plan'].map((id) => {
      const el = $(id);
      const mark = document.createComment(id);
      el.before(mark);
      return { el, mark };
    });
    new ResizeObserver(() => this._fit()).observe(this.head);
    this.more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.menu.hidden) this._openMore();
      else this._closeMore(true);
    });
    // a control used from the menu closes it (its own click handler still runs)
    this.menu.addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(() => this._closeMore(false), 0); });
    this.menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...this.menu.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      const n = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (n) n.focus();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target) && e.target !== this.more && !this.more.contains(e.target)) this._closeMore(false);
    });
  }

  _fit() {
    if (!this.head.clientWidth) return;
    this._renderCwd();
    for (const s of this.slots) {
      s.mark.after(s.el); // back to its place in the toolbar
      s.el.classList.remove('in-menu');
    }
    this.more.hidden = true;
    let i = 0;
    while (this.head.scrollWidth > this.head.clientWidth + 1 && i < this.slots.length) {
      this.more.hidden = false;
      const s = this.slots[i++];
      s.el.classList.add('in-menu');
      if (s.el.tagName === 'BUTTON') s.el.setAttribute('role', 'menuitem');
      this.menu.prepend(s.el);
    }
    for (const s of this.slots) if (!s.el.classList.contains('in-menu')) s.el.removeAttribute('role');
    if (this.more.hidden) this._closeMore(false);
  }

  _openMore() {
    this.menu.hidden = false;
    this.more.setAttribute('aria-expanded', 'true');
    const first = this.menu.querySelector('button');
    if (first) first.focus();
  }

  _closeMore(refocus) {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.more.setAttribute('aria-expanded', 'false');
    if (refocus) this.more.focus();
  }

  // ---------- terminal: a resizable bottom split inside the popup ----------
  _wireTerminal() {
    const btn = $('btn-interactive');
    let hgt = 240;
    try { hgt = Number(localStorage.getItem(TERM_KEY)) || 240; } catch { /* storage unavailable */ }
    this._setTermHeight(hgt);
    btn.addEventListener('click', () => this.toggleTerminal());
    $('cv-term-close').addEventListener('click', () => this.toggleTerminal(false));
    $('cv-term-cli').addEventListener('click', () => this.o.onOpenInteractive());
    const grip = $('cv-term-grip');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      const h0 = this.term.getBoundingClientRect().height;
      const move = (ev) => this._setTermHeight(h0 + (y0 - ev.clientY));
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        this._saveTermHeight();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      this._setTermHeight(this.termHeight + (e.key === 'ArrowUp' ? 24 : -24));
      this._saveTermHeight();
    });
  }

  toggleTerminal(on = this.term.hidden) {
    this.term.hidden = !on;
    const btn = $('btn-interactive');
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    if (on) {
      this._setTermHeight(this.termHeight);
      const log = $('cv-term-log');
      log.scrollTop = log.scrollHeight;
    }
  }

  _setTermHeight(px) {
    const body = this.root.querySelector('.cv-pane');
    const max = Math.max(160, (body.clientHeight || 600) * 0.7);
    this.termHeight = Math.round(Math.min(max, Math.max(120, px)));
    this.term.style.height = `${this.termHeight}px`;
  }

  _saveTermHeight() {
    try { localStorage.setItem(TERM_KEY, String(this.termHeight)); } catch { /* storage unavailable */ }
  }
}
