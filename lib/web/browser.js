'use strict';
// Web Viewer browser (main process): real top-level pages in WebContentsViews
// attached to the main window, so X-Frame-Options / frame-ancestors don't apply
// and nothing has to be stripped.
//
//   • own persistent session "persist:jarvis-web" (logins survive restarts, never
//     shared with the app's session), desktop Chrome UA without "Electron"
//   • no preload, sandbox + contextIsolation + webSecurity, no Node
//   • popups / window.open → a new tab in the viewer (max 6 live tabs)
//   • downloads → save dialog first; mailto: / zoom: … → asked on screen first
//   • camera / mic / location / notifications / clipboard read → denied unless the
//     user allows it on screen (per site, optionally remembered)
//   • a crashed / hung page shows a notice with reload; the app never goes down with it
//
// The renderer owns layout: it measures the placeholder element and sends its rect
// (web:bounds); only the active tab's view is visible.

const { WebContentsView, session, Menu, clipboard, app } = require('electron');
const path = require('path');
const { chromeUserAgent, normalizeAddress, dipBounds, isLoadable, isForbidden } = require('./web-utils');
const { permissionKeys, LABELS } = require('./permissions');

const PARTITION = 'persist:jarvis-web';
const MAX_TABS = 6;
const WORLD = 1001; // isolated world for everything we inject
const PROMPT_TIMEOUT_MS = 60000;
const ALWAYS_ALLOW = new Set(['clipboard-sanitized-write']);

class WebBrowser {
  /**
   * o: { getWin(): BrowserWindow|null, send(channel, payload), perms: WebPermissions,
   *      checkPublicUrl(url): Promise<URL>, log?(msg) }
   */
  constructor(o) {
    this.o = o;
    this.tabs = new Map(); // tabId → tab
    this.seq = 0;
    this.active = null; // tabId shown in the viewer
    this.visible = false;
    this.prompts = new Map(); // id → resolve
    this.promptSeq = 0;
    this.ua = chromeUserAgent(process.versions.chrome);
    this.onSettled = null; // (tab) => void — set by the page reader (extraction + summary)
    this.onClosed = null; // (tabId) => void
  }

  get session() {
    if (!this.ses) this._initSession();
    return this.ses;
  }

  _initSession() {
    const ses = session.fromPartition(PARTITION);
    this.ses = ses;
    ses.setUserAgent(this.ua, 'th-TH,th,en-US,en');
    try { ses.setSpellCheckerEnabled(false); } catch { /* not on every platform */ }

    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      this._permission(wc, permission, details).then(cb, () => cb(false));
    });
    ses.setPermissionCheckHandler((wc, permission, origin, details) => {
      if (ALWAYS_ALLOW.has(permission)) return true;
      const o = originOf(origin || (details && details.requestingUrl));
      if (!o) return false;
      const keys = permissionKeys(permission, { mediaTypes: details && details.mediaType ? [details.mediaType] : undefined });
      return keys.length > 0 && keys.every((k) => this.o.perms.get(o, k) === true);
    });
    // no save path set → Electron shows the save dialog before anything is written
    ses.on('will-download', (_e, item) => {
      item.setSaveDialogOptions({ title: 'บันทึกไฟล์จากเว็บ', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
      item.once('done', (_ev, state) => {
        if (state === 'completed') this.o.send('web:tab', { type: 'download', ok: true, file: item.getSavePath(), name: item.getFilename() });
        else if (state === 'interrupted') this.o.send('web:tab', { type: 'download', ok: false, name: item.getFilename() });
      });
    });
  }

  // ---------- permissions + external protocols ----------
  async _permission(wc, permission, details = {}) {
    if (ALWAYS_ALLOW.has(permission)) return true;
    const tab = this._tabOf(wc);
    if (permission === 'openExternal') {
      const url = String(details.externalURL || '');
      if (!url || isForbidden(url) || /^https?:/i.test(url)) return false;
      const r = await this.prompt({ kind: 'external', tabId: tab && tab.id, url: url.slice(0, 500) });
      return !!r.allow;
    }
    const origin = originOf(details.requestingUrl || (wc && wc.getURL()));
    const keys = permissionKeys(permission, details);
    if (!origin || !keys.length) return false;
    const known = keys.map((k) => this.o.perms.get(origin, k));
    if (known.every((x) => x === true)) return true;
    if (known.some((x) => x === false)) return false;
    const r = await this.prompt({ kind: 'permission', tabId: tab && tab.id, origin, what: keys.map((k) => LABELS[k] || k).join(' + ') });
    if (r.remember) for (const k of keys) this.o.perms.set(origin, k, !!r.allow);
    return !!r.allow;
  }

  /** Ask the user on screen. Resolves { allow, remember }; no answer in 60 s = deny. */
  prompt(p) {
    const id = `p${++this.promptSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.prompts.delete(id); this.o.send('web:prompt', { id, close: true }); resolve({ allow: false }); }, PROMPT_TIMEOUT_MS);
      this.prompts.set(id, (r) => { clearTimeout(timer); resolve(r); });
      this.o.send('web:prompt', { id, ...p });
    });
  }

  respond(id, allow, remember) {
    const fn = this.prompts.get(id);
    if (!fn) return false;
    this.prompts.delete(id);
    fn({ allow: !!allow, remember: !!remember });
    return true;
  }

  // ---------- tabs ----------
  /**
   * Open a page in a new tab. initiator: 'user' (typed / clicked) | 'jarvis' (Claude,
   * search result, voice) | 'page' (popup). Jarvis-opened URLs must be public.
   * @returns {Promise<{ok, tabId?, url?, error?}>}
   */
  async open({ url, initiator = 'user', opener = null }) {
    let target = String(url || '');
    if (initiator === 'user') target = normalizeAddress(target);
    if (!target || !/^https?:/i.test(target)) return { ok: false, error: 'เปิดได้เฉพาะ http/https' };
    if (initiator === 'jarvis') {
      try { target = (await this.o.checkPublicUrl(target)).toString(); } catch (err) { return { ok: false, error: err.message }; }
    }
    const win = this.o.getWin();
    if (!win) return { ok: false, error: 'no window' };
    this._evict();
    const tab = this._create(win, initiator, opener);
    this._load(tab, target);
    return { ok: true, tabId: tab.id, url: target };
  }

  _create(win, initiator, opener) {
    if (!this.ses) this._initSession(); // permission / download handlers before the first page loads
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        plugins: true, // Chromium's built-in PDF viewer
        spellcheck: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    win.contentView.addChildView(view);
    const wc = view.webContents;
    wc.setUserAgent(this.ua);
    const tab = {
      id: `w${++this.seq}`,
      view,
      wc,
      openedAt: Date.now(),
      initiator,
      nav: 0, // bumps on every main-frame navigation (stale work checks this)
      st: { url: '', title: '', favicon: '', loading: true, progress: 0.05, canGoBack: false, canGoForward: false, crashed: null, unresponsive: false, error: null, status: 0, jarvis: initiator === 'jarvis' },
    };
    this.tabs.set(tab.id, tab);
    this._wire(tab);
    this.o.send('web:tab', { type: 'opened', tabId: tab.id, opener, initiator });
    return tab;
  }

  _load(tab, url) {
    tab.st.url = url;
    tab.st.error = null;
    tab.st.crashed = null;
    this._push(tab);
    tab.wc.loadURL(url).catch(() => { /* did-fail-load reports it */ });
  }

  _wire(tab) {
    const { wc } = tab;
    const st = tab.st;
    const push = () => this._push(tab);
    const navFlags = () => {
      try {
        st.canGoBack = wc.navigationHistory.canGoBack();
        st.canGoForward = wc.navigationHistory.canGoForward();
      } catch { /* destroyed */ }
    };
    wc.on('did-start-loading', () => { st.loading = true; st.progress = Math.max(st.progress, 0.1); push(); });
    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument || !isLoadable(d.url)) return; // mailto: etc. never replace the page
      tab.nav++;
      st.error = null;
      st.progress = 0.15;
      st.url = d.url;
      push();
    });
    wc.on('did-navigate', (_e, url, code) => { st.url = url; st.status = code || 0; st.progress = Math.max(st.progress, 0.4); navFlags(); push(); });
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      if (!isMain) return;
      const route = (u) => { try { const x = new URL(u); return x.origin + x.pathname + x.search; } catch { return u; } };
      const changed = route(url) !== route(st.url);
      st.url = url;
      navFlags();
      push();
      // single-page apps change routes without a load: read the new view once it settles
      if (changed && this.onSettled) {
        const nav = ++tab.nav;
        setTimeout(() => {
          if (tab.nav !== nav || wc.isDestroyed() || st.loading) return;
          try { this.onSettled(tab); } catch (err) { this._log(`onSettled: ${err.message}`); }
        }, 1200);
      }
    });
    wc.on('dom-ready', () => { st.progress = Math.max(st.progress, 0.7); push(); });
    wc.on('page-title-updated', (_e, title) => { st.title = String(title || '').slice(0, 300); push(); });
    wc.on('page-favicon-updated', (_e, favs) => { st.favicon = (favs || []).find((f) => /^https?:\/\//i.test(f)) || ''; push(); });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return; // -3 = aborted (a new navigation started)
      st.error = { code, text: String(desc || '').slice(0, 200), url: String(url || '').slice(0, 2000) };
      push();
    });
    wc.on('did-stop-loading', () => {
      st.loading = false;
      st.progress = 1;
      navFlags();
      push();
      if (!st.error && !st.crashed && this.onSettled) {
        try { this.onSettled(tab); } catch (err) { this._log(`onSettled: ${err.message}`); }
      }
    });
    wc.on('render-process-gone', (_e, d) => {
      if (d && d.reason === 'clean-exit') return;
      st.crashed = (d && d.reason) || 'crashed';
      st.loading = false;
      tab.nav++;
      push();
    });
    wc.on('unresponsive', () => { st.unresponsive = true; push(); });
    wc.on('responsive', () => { st.unresponsive = false; push(); });
    wc.on('found-in-page', (_e, r) => this.o.send('web:tab', { type: 'find', tabId: tab.id, active: r.activeMatchOrdinal || 0, matches: r.matches || 0 }));

    // only real web schemes load here; internal schemes are blocked, others go through openExternal (asked)
    const guard = (e, url) => { if (isForbidden(url)) e.preventDefault(); };
    wc.on('will-navigate', (e) => guard(e, e.url));
    wc.on('will-redirect', (e) => guard(e, e.url));
    wc.on('will-frame-navigate', (e) => guard(e, e.url));
    // popups and target=_blank become tabs in the viewer, never OS windows
    wc.setWindowOpenHandler(({ url }) => {
      if (isLoadable(url) && /^https?:/i.test(url)) setImmediate(() => this.open({ url, initiator: 'page', opener: tab.id }));
      return { action: 'deny' };
    });
    wc.on('before-input-event', (e, input) => this._key(tab, e, input));
    wc.on('context-menu', (_e, p) => this._contextMenu(tab, p));
  }

  _push(tab) {
    this.o.send('web:tab', { type: 'state', tabId: tab.id, ...tab.st });
  }

  _tabOf(wc) {
    for (const t of this.tabs.values()) if (t.wc === wc) return t;
    return null;
  }

  tab(id) {
    const t = this.tabs.get(id);
    return t && !t.wc.isDestroyed() ? t : null;
  }

  /** Keep at most 6 live tabs: the oldest one that isn't shown goes. */
  _evict() {
    while (this.tabs.size >= MAX_TABS) {
      const old = [...this.tabs.values()].filter((t) => t.id !== this.active).sort((a, b) => a.openedAt - b.openedAt)[0];
      if (!old) break;
      this.close(old.id);
    }
  }

  close(id) {
    const t = this.tabs.get(id);
    if (!t) return;
    this.tabs.delete(id);
    if (this.active === id) this.active = null;
    const win = this.o.getWin();
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(t.view); } catch { /* already gone */ }
    try { if (!t.wc.isDestroyed()) t.wc.close(); } catch { /* already gone */ }
    if (this.onClosed) { try { this.onClosed(id); } catch { /* owner error */ } }
    this.o.send('web:tab', { type: 'closed', tabId: id });
  }

  closeAll() {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }

  // ---------- layout ----------
  /** Show `tabId` at `rect` (renderer CSS px) or hide every view (visible false). */
  setBounds({ tabId, rect, visible }) {
    const win = this.o.getWin();
    if (!win) return;
    const zoom = win.webContents.getZoomFactor();
    const b = dipBounds(rect, zoom);
    const show = !!(visible && b && this.tabs.has(tabId));
    if (process.env.JARVIS_WEB_DEBUG) this._log(`setBounds ${tabId} visible=${visible} show=${show} b=${JSON.stringify(b)} zoom=${zoom}`);
    let hadFocus = false;
    for (const t of this.tabs.values()) {
      const on = show && t.id === tabId;
      if (!on && t.view.getVisible && t.view.getVisible()) {
        try { hadFocus = hadFocus || t.wc.isFocused(); } catch { /* destroyed */ }
      }
      if (on) t.view.setBounds(b);
      t.view.setVisible(on);
    }
    this.active = show ? tabId : (this.tabs.has(tabId) ? tabId : this.active);
    this.visible = show;
    if (hadFocus && !show) win.webContents.focus(); // keys go back to the HUD
  }

  focus(id) {
    const t = this.tab(id);
    if (t) t.wc.focus();
  }

  // ---------- navigation ----------
  nav(id, action, input) {
    const t = this.tab(id);
    if (!t) return { ok: false, error: 'ไม่พบแท็บ' };
    const h = t.wc.navigationHistory;
    switch (action) {
      case 'back': if (h.canGoBack()) h.goBack(); break;
      case 'forward': if (h.canGoForward()) h.goForward(); break;
      case 'reload':
        t.st.crashed = null;
        t.st.unresponsive = false;
        if (t.st.error && t.st.error.url) this._load(t, t.st.error.url);
        else t.wc.reload();
        break;
      case 'stop': t.wc.stop(); break;
      case 'go': {
        const url = normalizeAddress(input);
        if (!url) return { ok: false, error: 'ที่อยู่ไม่ถูกต้อง' };
        t.st.jarvis = false;
        this._load(t, url);
        return { ok: true, url };
      }
      default: return { ok: false, error: 'unknown action' };
    }
    return { ok: true };
  }

  /** Jarvis navigates an existing tab (read-only browsing; public URLs only). */
  async navJarvis(id, url) {
    const t = this.tab(id);
    if (!t) return { ok: false, error: 'ไม่พบแท็บ' };
    let target;
    try { target = (await this.o.checkPublicUrl(url)).toString(); } catch (err) { return { ok: false, error: err.message }; }
    t.st.jarvis = true;
    this._load(t, target);
    return { ok: true, url: target };
  }

  find(id, text, { forward = true, next = false } = {}) {
    const t = this.tab(id);
    if (!t) return;
    if (!text) { t.wc.stopFindInPage('clearSelection'); return; }
    t.wc.findInPage(text, { forward, findNext: next });
  }

  /** JPEG snapshot of the page (for the open / close transitions), or null. */
  async capture(id) {
    const t = this.tab(id);
    if (!t || t.st.crashed) return null;
    try {
      let img = await t.wc.capturePage();
      if (img.isEmpty()) return null;
      const { width } = img.getSize();
      if (width > 1600) img = img.resize({ width: 1600, quality: 'good' });
      return 'data:image/jpeg;base64,' + img.toJPEG(72).toString('base64');
    } catch {
      return null;
    }
  }

  /** Run code in our isolated world (shares the DOM, not the page's JS). */
  run(id, code, { userGesture = false } = {}) {
    const t = this.tab(id);
    if (!t || t.st.crashed) return Promise.resolve(undefined);
    return t.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], userGesture);
  }

  pauseMedia(id) {
    return this.run(id, 'document.querySelectorAll("video,audio").forEach((m) => { try { m.pause(); } catch {} }); true').catch(() => {});
  }

  async clearData() {
    this.closeAll();
    const ses = this.session;
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    this.o.perms.clear();
  }

  /** Keys typed in the HUD while a page is shown (Ctrl+R / Ctrl+W must not hit the app's menu). */
  hudKey(e, input) {
    if (!this.visible) return;
    const t = this.tab(this.active);
    if (t) this._key(t, e, input, true);
  }

  // ---------- keys inside a page ----------
  _key(tab, e, input, hud = false) {
    if (input.type !== 'keyDown') return;
    if (hud) {
      const k = String(input.key || '');
      if (k === 'Escape' || k === 'Tab' || k === 'F11') return; // the HUD / main window handle these
    }
    const k = String(input.key || '');
    const ctrl = input.control || input.meta;
    const fwd = (key) => { e.preventDefault(); this.o.send('web:tab', { type: 'key', tabId: tab.id, key }); };
    if (ctrl && !input.alt && (k === 'l' || k === 'L')) return fwd('address');
    if (ctrl && !input.alt && (k === 'f' || k === 'F')) return fwd('find');
    if (ctrl && !input.alt && (k === 'w' || k === 'W')) return fwd('close-tab');
    if (ctrl && k === 'Tab') return fwd(input.shift ? 'prev-tab' : 'next-tab');
    if (input.alt && k === 'ArrowLeft') { e.preventDefault(); this.nav(tab.id, 'back'); return; }
    if (input.alt && k === 'ArrowRight') { e.preventDefault(); this.nav(tab.id, 'forward'); return; }
    if ((ctrl && (k === 'r' || k === 'R')) || k === 'F5') { e.preventDefault(); this.nav(tab.id, 'reload'); return; }
    if (k === 'F11') {
      e.preventDefault();
      const win = this.o.getWin();
      if (win) win.setFullScreen(!win.isFullScreen());
      return;
    }
    if (k === 'Escape') this.o.send('web:tab', { type: 'key', tabId: tab.id, key: 'escape' }); // the page still gets it
  }

  _contextMenu(tab, p) {
    const items = [];
    const link = /^https?:/i.test(p.linkURL || '') ? p.linkURL : '';
    if (link) {
      items.push({ label: 'เปิดลิงก์ในแท็บใหม่', click: () => this.open({ url: link, initiator: 'page', opener: tab.id }) });
      items.push({ label: 'คัดลอกลิงก์', click: () => clipboard.writeText(link) });
      items.push({ type: 'separator' });
    }
    if (p.selectionText) items.push({ label: 'คัดลอก', role: 'copy' });
    if (p.isEditable) items.push({ label: 'วาง', role: 'paste' }, { label: 'ตัด', role: 'cut' });
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
    items.push(
      { label: 'ย้อนกลับ', enabled: tab.st.canGoBack, click: () => this.nav(tab.id, 'back') },
      { label: 'ไปข้างหน้า', enabled: tab.st.canGoForward, click: () => this.nav(tab.id, 'forward') },
      { label: 'โหลดใหม่', click: () => this.nav(tab.id, 'reload') },
    );
    try { Menu.buildFromTemplate(items).popup({ window: this.o.getWin() || undefined }); } catch { /* window gone */ }
  }

  /** Dev screenshots: the window capture doesn't include native views, so paint the shown page in. */
  async composite(base) {
    const win = this.o.getWin();
    const t = this.visible && this.tab(this.active);
    if (process.env.JARVIS_WEB_DEBUG) this._log(`composite? visible=${this.visible} active=${this.active} tabs=${[...this.tabs.keys()]}`);
    if (!win || !t) return base;
    const b = t.view.getBounds();
    const { width: W, height: H } = base.getSize();
    const sf = W / win.getContentBounds().width;
    let img = await t.wc.capturePage();
    if (process.env.JARVIS_WEB_DEBUG) this._log(`composite ${t.id} bounds=${JSON.stringify(b)} visible=${t.view.getVisible ? t.view.getVisible() : '?'} img=${JSON.stringify(img.getSize())} empty=${img.isEmpty()} url=${t.wc.getURL()}`);
    if (img.isEmpty()) return base;
    const tw = Math.round(b.width * sf);
    const th = Math.round(b.height * sf);
    const s = img.getSize();
    if (s.width !== tw || s.height !== th) img = img.resize({ width: tw, height: th });
    const dst = Buffer.from(base.toBitmap());
    const src = img.toBitmap();
    const ox = Math.round(b.x * sf);
    const oy = Math.round(b.y * sf);
    for (let y = 0; y < th; y++) {
      const dy = oy + y;
      if (dy < 0 || dy >= H) continue;
      const x0 = Math.max(0, ox);
      const x1 = Math.min(W, ox + tw);
      if (x1 <= x0) break;
      src.copy(dst, (dy * W + x0) * 4, (y * tw + (x0 - ox)) * 4, (y * tw + (x1 - ox)) * 4);
    }
    const { nativeImage } = require('electron');
    return nativeImage.createFromBitmap(dst, { width: W, height: H });
  }

  _log(msg) {
    if (this.o.log) this.o.log(msg);
  }
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

module.exports = { WebBrowser, PARTITION, WORLD, MAX_TABS };
