'use strict';
// Permission popup on the desktop (main process). While the main window is minimized
// or hidden, a request to use a tool (Edit, Bash, …) opens this centered, always-on-top
// window with the full request, so it can be answered without opening JARVIS.
// The page only mirrors the oldest open request and sends the answer back.

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const W = 660;
const H = 700;

class ApprovalWindow {
  /** o.preload / o.url: the popup page · o.log(msg): optional */
  constructor(o) {
    this.o = o;
    this.win = null;
    this.ready = false;
    this.data = null; // the request on screen (or null)
    this.dismissedId = null; // request whose popup the user closed
    this.quitting = false;
  }

  alive() { return !!this.win && !this.win.isDestroyed(); }

  send(ch, payload) {
    if (this.alive() && this.ready) this.win.webContents.send(ch, payload);
  }

  create() {
    if (this.alive()) return;
    this.ready = false;
    const win = new BrowserWindow({
      width: W,
      height: H,
      show: false,
      title: 'JARVIS — ขออนุญาตใช้เครื่องมือ',
      backgroundColor: '#070B10',
      autoHideMenuBar: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: this.o.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.win = win;
    win.removeMenu();
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (this.o.log) win.webContents.on('console-message', (e) => this.o.log(`[approval page] ${e.message} (${e.lineNumber})`));
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
      this.send('approval-win:data', this.data);
    });
    win.webContents.on('render-process-gone', () => {
      try { win.destroy(); } catch { /* gone */ }
    });
    // closing the popup only hides it: the request stays open (in JARVIS, until it times out),
    // and the popup doesn't come back for that same request
    win.on('close', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      if (this.data) this.dismissedId = this.data.id;
      win.hide();
    });
    win.on('closed', () => {
      if (this.win === win) { this.win = null; this.ready = false; }
    });
    win.loadURL(this.o.url);
  }

  /** The request to show (null = none open → close the popup). pop: open it now if it is hidden. */
  update(data, pop) {
    this.data = data;
    if (!data) { this.dismissedId = null; this.hide(); return; }
    if (data.id === this.dismissedId) pop = false;
    else this.dismissedId = null;
    if (!this.alive()) {
      if (!pop) return;
      this.create();
    }
    this.send('approval-win:data', data);
    if (pop) this.show();
  }

  /** Center on the display under the cursor, above everything, without stealing keystrokes. */
  show() {
    if (!this.data) return;
    if (!this.alive()) this.create();
    this.win.setAlwaysOnTop(true, 'screen-saver');
    if (this.win.isVisible()) return; // already up: don't move it back if the user dragged it
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const w = Math.min(W, wa.width - 40);
    const h = Math.min(H, wa.height - 40);
    this.win.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h });
    this.win.showInactive();
  }

  hide() {
    if (this.alive() && this.win.isVisible()) this.win.hide();
  }

  destroy() {
    this.quitting = true;
    if (this.alive()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { ApprovalWindow, APPROVAL_PRELOAD: path.join(__dirname, '..', 'approval-preload.js') };
