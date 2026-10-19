'use strict';
// Floating Orb window (main process). A small always-on-top, click-through,
// non-focusable window shown while the main window is minimized. It only mirrors
// state from the main window's renderer and sends commands back; the voice
// pipeline stays in the main window.

const path = require('path');
const { BrowserWindow, Menu, screen } = require('electron');
const G = require('./geometry');

const SNAP_MS = 250;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

class OrbWindow {
  /**
   * o.settings: SettingsStore · o.preload / o.url: the orb page
   * o.command(action, extra): forward a command to the main window
   * o.openMain(): restore + focus the main window · o.quit(): quit the app
   */
  constructor(o) {
    this.o = o;
    this.win = null;
    this.ready = false;
    this.visible = false; // wanted visible (main is minimized / in the tray)
    this.hiddenByUser = false; // "ซ่อนไอคอน" until the next minimize
    this.state = {}; // last state from the main window
    this.pos = null;
    this.displayId = null;
    this.panel = null; // { w, h } while the bubble is open
    this.drag = null;
    this.anim = null;
    this.hideTimer = null;
    this.mainCrashed = false;
  }

  get settings() { return this.o.settings.get(); }
  get size() { return G.orbSize(this.settings.orbSize); }
  get level() { return this.settings.orbOnTopFullscreen ? 'screen-saver' : 'floating'; }

  alive() { return !!this.win && !this.win.isDestroyed(); }

  send(ch, payload) {
    if (this.alive() && this.ready) this.win.webContents.send(ch, payload);
  }

  /** Create the hidden window ahead of time so it shows instantly on minimize. */
  create() {
    if (this.alive()) return;
    this.ready = false;
    this._place();
    const b = G.orbBounds(this.pos, this.size);
    const win = new BrowserWindow({
      ...b,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      focusable: false, // never takes focus, except while the bubble's text box is open
      title: 'JARVIS',
      webPreferences: {
        preload: this.o.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.win = win;
    win.setAlwaysOnTop(true, this.level);
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    if (this.o.log) win.webContents.on('console-message', (e) => this.o.log(`[orb page] ${e.message} (${e.lineNumber})`));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('render-process-gone', () => {
      // a crashed orb is rebuilt on the next show
      try { win.destroy(); } catch { /* gone */ }
    });
    win.on('closed', () => {
      if (this.win === win) { this.win = null; this.ready = false; this.panel = null; }
    });
    win.loadURL(this.o.url);
  }

  /** Called by the orb page once it has loaded. */
  onReady() {
    this.ready = true;
    this._config();
    this.send('orb:state', this.state);
    if (this.visible) this._reveal();
  }

  _config() {
    const s = this.settings;
    this.send('orb:config', { size: this.size, autoFade: !!s.orbAutoFade });
  }

  /** Settings changed (size, layer, fade, enabled). */
  configure() {
    const s = this.settings;
    if (!s.orbEnabled) {
      this.hide(true);
      return;
    }
    if (!this.alive()) return;
    this.win.setAlwaysOnTop(true, this.level);
    this._place();
    this._collapse();
    this._config();
  }

  // ---------- show / hide ----------

  show({ force = false } = {}) {
    if (!this.settings.orbEnabled) return;
    if (force) this.hiddenByUser = false;
    if (this.hiddenByUser) return;
    this.visible = true;
    clearTimeout(this.hideTimer);
    if (!this.alive()) this.create();
    if (this.ready) this._reveal();
  }

  _reveal() {
    this._place();
    this._collapse();
    this.win.setAlwaysOnTop(true, this.level);
    if (!this.win.isVisible()) this.win.showInactive();
    this.send('orb:visible', { on: true });
    if (this.o.onVisibility) this.o.onVisibility(true);
  }

  /** immediate: skip the fade (orb turned off in settings, app quitting). */
  hide(immediate = false) {
    const was = this.visible;
    this.visible = false;
    clearTimeout(this.hideTimer);
    this._setFocusable(false);
    if (!this.alive()) return;
    if (!this.win.isVisible()) return;
    this.send('orb:visible', { on: false });
    const done = () => { if (!this.visible && this.alive()) { this.win.hide(); this._collapse(); } };
    if (immediate) done();
    else this.hideTimer = setTimeout(done, 200);
    if (was && this.o.onVisibility) this.o.onVisibility(false);
  }

  destroy() {
    clearTimeout(this.hideTimer);
    this._stopAnim();
    if (this.alive()) this.win.destroy();
    this.win = null;
  }

  // ---------- position ----------

  /** Restore the saved position (or the default) and clamp it to its display. */
  _place() {
    if (this.drag) return;
    const r = G.restorePos(this.settings.orbPos, screen.getAllDisplays(), screen.getPrimaryDisplay(), this.size);
    this.pos = r.pos;
    this.displayId = r.displayId;
  }

  _setBounds(b) {
    if (this.alive()) this.win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  }

  _displayAt(p) {
    const s = this.size;
    return screen.getDisplayNearestPoint({ x: Math.round(p.x + s / 2), y: Math.round(p.y + s / 2) });
  }

  _save() {
    const d = this._displayAt(this.pos);
    this.displayId = d.id;
    this.o.settings.update({ orbPos: { x: this.pos.x, y: this.pos.y, displayId: d.id } });
  }

  resetPosition() {
    this.o.settings.update({ orbPos: null });
    this._stopAnim();
    this._place();
    this._collapse();
  }

  /** Display added / removed / rescaled: re-clamp (or fall back to the default). */
  reclamp() {
    if (!this.alive() || this.drag) return;
    this._place();
    if (this.panel) this._openPanel(this.panel);
    else this._collapse();
  }

  // ---------- bubble (window grows beside the orb) ----------

  _layout() {
    const wa = this._displayAt(this.pos).workArea;
    return this.panel ? G.panelLayout(this.pos, this.size, wa, this.panel) : G.orbLayout(this.pos, this.size);
  }

  _openPanel(panel) {
    this.panel = panel;
    const l = this._layout();
    this._setBounds(l.bounds);
    this.send('orb:layout', l);
    return l;
  }

  _collapse() {
    this.panel = null;
    const l = this._layout();
    this._setBounds(l.bounds);
    this.send('orb:layout', l);
    return l;
  }

  setPanel(p) {
    if (this.drag) return this._layout();
    return p ? this._openPanel(p) : this._collapse();
  }

  _setFocusable(on) {
    if (!this.alive()) return;
    this.win.setFocusable(on);
    if (on) this.win.focus();
    else if (this.win.isFocused()) this.win.blur();
  }

  setFocusable(on) { this._setFocusable(on); }

  setHit(on) {
    // transparent areas pass clicks to the apps underneath; the circle / bubble take them
    if (this.alive()) this.win.setIgnoreMouseEvents(!on, { forward: true });
  }

  // ---------- drag (pointer events in the page + window moves here) ----------

  dragStart() {
    if (!this.alive()) return;
    this._stopAnim();
    if (this.panel) this._collapse();
    this.drag = { cursor: screen.getCursorScreenPoint(), pos: { ...this.pos } };
  }

  dragMove() {
    if (!this.drag || !this.alive()) return;
    const c = screen.getCursorScreenPoint();
    const p = { x: this.drag.pos.x + c.x - this.drag.cursor.x, y: this.drag.pos.y + c.y - this.drag.cursor.y };
    // clamp to the display under the cursor, so dragging across monitors works
    this.pos = G.clampPos(p, this.size, screen.getDisplayNearestPoint(c).workArea);
    this._setBounds(G.orbBounds(this.pos, this.size));
  }

  dragEnd() {
    if (!this.drag) return;
    this.drag = null;
    const target = G.snapPos(this.pos, this.size, this._displayAt(this.pos).workArea);
    this._animateTo(target);
  }

  _stopAnim() {
    if (this.anim) { clearInterval(this.anim); this.anim = null; }
  }

  _animateTo(target) {
    this._stopAnim();
    const from = { ...this.pos };
    if (from.x === target.x && from.y === target.y) { this._save(); return; }
    const t0 = Date.now();
    this.anim = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / SNAP_MS);
      const e = easeOut(k);
      this.pos = { x: Math.round(from.x + (target.x - from.x) * e), y: Math.round(from.y + (target.y - from.y) * e) };
      this._setBounds(G.orbBounds(this.pos, this.size));
      if (k >= 1) { this._stopAnim(); this._save(); }
    }, 16);
  }

  // ---------- state + menu ----------

  setState(partial) {
    Object.assign(this.state, partial);
    this.send('orb:state', partial);
  }

  level(v) {
    if (this.visible) this.send('orb:level', v);
  }

  setMainCrashed(on) {
    this.mainCrashed = on;
    this.setState(on
      ? { state: 'error', error: 'หน้าต่างหลักหยุดทำงาน — ดับเบิลคลิกเพื่อเปิดใหม่', errorId: Date.now() }
      : { state: 'idle', error: '' });
  }

  menu() {
    if (!this.alive()) return;
    const st = this.state;
    const cmd = (action) => () => this.o.command(action);
    Menu.buildFromTemplate([
      { label: 'เปิด JARVIS', click: () => this.o.openMain() },
      { type: 'separator' },
      { label: st.micOff ? 'เปิดไมค์' : 'ปิดไมค์', click: cmd('mic-toggle') },
      { label: st.hf ? 'Hands-free: ปิด' : 'Hands-free: เปิด', click: cmd('hf-toggle') },
      { label: 'ปิดเสียง', type: 'checkbox', checked: !!st.voiceMuted, click: cmd('mute-toggle') },
      { type: 'separator' },
      { label: 'ซ่อนไอคอน', click: () => { this.hiddenByUser = true; this.hide(); } },
      { label: 'รีเซ็ตตำแหน่งไอคอน', click: () => this.resetPosition() },
      { type: 'separator' },
      { label: 'ออกจากโปรแกรม', click: () => this.o.quit() },
    ]).popup({ window: this.win });
  }
}

module.exports = { OrbWindow, ORB_PRELOAD: path.join(__dirname, '..', '..', 'orb-preload.js') };
