'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session: eSession, globalShortcut, protocol, net, powerMonitor, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { SettingsStore, defaults: settingDefaults } = require('./lib/settings');
const { JarvisCore } = require('./lib/jarvis-core');
const { v } = require('./lib/ipc-validate');
const { WinRtTts } = require('./lib/tts/winrt');
const { EdgeTts } = require('./lib/tts/edge');
const { HybridTts } = require('./lib/tts/hybrid');
const { installThaiVoice } = require('./lib/installer/thai-voice');
const { PERMISSION_MODES } = require('./lib/claude/args');
const { SttService } = require('./lib/stt');
const { VisionAssets } = require('./lib/installer/vision-assets');
const { WakeAssets } = require('./lib/installer/wake-assets');
const { pcm16ToWav } = require('./lib/stt/wav');
const { trayIconPng } = require('./lib/tray-icon');
const webReader = require('./lib/web/reader');
const { WebBrowser } = require('./lib/web/browser');
const { WebPermissions } = require('./lib/web/permissions');
const { resolveSite } = require('./lib/web/web-utils');
const { Summarizer } = require('./lib/web/summarize');
const { PageReader } = require('./lib/web/page-reader');

const APP_ROOT = __dirname;
const APP_ORIGIN = 'app://jarvis';
// Only these folders are reachable from the renderer via app://jarvis/…
const SERVED_DIRS = ['renderer', path.join('node_modules', '@mediapipe', 'tasks-vision'), path.join('node_modules', 'onnxruntime-web', 'dist')];

// Dev aid: JARVIS_USER_DATA=<dir> runs with a separate profile (own settings,
// own single-instance lock) next to a normally running JARVIS.
if (process.env.JARVIS_USER_DATA) app.setPath('userData', process.env.JARVIS_USER_DATA);

// Dev aid (hands-free tests): JARVIS_FAKE_AUDIO=<file.wav> replaces the microphone
// with that WAV, looping; JARVIS_METRICS=<file> logs per-process CPU every 2 s.
if (process.env.JARVIS_FAKE_AUDIO) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.JARVIS_FAKE_AUDIO);
}
if (process.env.JARVIS_METRICS) {
  app.whenReady().then(() => setInterval(() => {
    const m = app.getAppMetrics().map((p) => `${p.type}:${p.cpu.percentCPUUsage.toFixed(1)}`).join(' ');
    fs.appendFileSync(process.env.JARVIS_METRICS, `${Date.now()} ${m}\n`);
  }, 2000));
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function registerAppProtocol() {
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    if (url.host !== 'jarvis') return new Response('not found', { status: 404 });
    const rel = path.normalize(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    const full = path.join(APP_ROOT, rel);
    const allowed = SERVED_DIRS.some((d) => full.startsWith(path.join(APP_ROOT, d) + path.sep));
    if (!allowed || !fs.existsSync(full) || !fs.statSync(full).isFile()) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(full).toString());
  });
}

let win = null;
let core = null;
let settings = null;
let tts = null;
let stt = null;
let vision = null;
let wakeAssets = null;
let tray = null;
let web = null; // Web Viewer browser (WebContentsViews in the main window)
let reader = null; // Web Viewer page reader (extraction + summaries)
// hands-free state reported by the renderer (for tray mode + background throttling)
const hf = { on: false };

// `jarvis --camera-on` asks for the camera once the app has booted. Only an explicit
// launch flag from the user starts the camera; the renderer still needs the same
// permission prompt as the CAM button.
let cameraAutoStart = process.argv.includes('--camera-on');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (argv.includes('--camera-on')) send('camera:cmd', { action: 'on' });
    }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#01060D',
    title: 'Mee JARVIS',
    autoHideMenuBar: true,
    frame: false,
    fullscreen: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required', // boot sound plays without a click
    },
  });
  win.loadURL(`${APP_ORIGIN}/renderer/index.html`);
  // The renderer never navigates or opens windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
  // Hands-free: in tray mode a minimized window hides to the tray and keeps
  // listening; otherwise the renderer pauses wake listening while hidden.
  win.on('minimize', () => {
    if (hf.on && settings.get().handsFreeBackground === 'tray') {
      win.hide();
      showTray();
    }
  });
  // F11 toggles fullscreen. Esc is left to the page and never exits the app.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
      return;
    }
    if (web) web.hudKey(e, input); // a web page is shown: Ctrl+R / Ctrl+W / Ctrl+L / Ctrl+F act on it
  });
  win.on('enter-full-screen', () => send('window:state', { fullscreen: true }));
  win.on('leave-full-screen', () => send('window:state', { fullscreen: false }));

  // Dev aid: JARVIS_SCREENSHOT=<file.png> captures the window after load and
  // writes renderer console output next to it.
  const shot = process.env.JARVIS_SCREENSHOT;
  if (shot) {
    const logFile = shot.replace(/\.png$/i, '') + '.console.log';
    fs.writeFileSync(logFile, '');
    const grab = async () => {
      const img = await win.webContents.capturePage();
      return web ? web.composite(img).catch(() => img) : img;
    };
    win.webContents.on('console-message', (e) => {
      fs.appendFileSync(logFile, `[${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})\n`);
      // a page script can ask for extra frames: console.log('[shot] name') → <shot>-name.png
      const m = /^\[shot\] ([\w-]{1,40})$/.exec(String(e.message || ''));
      if (m) grab().then((img) => fs.writeFileSync(shot.replace(/\.png$/i, '') + `-${m[1]}.png`, img.toPNG()), () => {});
      // '[crash-web]' crashes the shown web page (tests the crash notice)
      if (e.message === '[crash-web]' && web && web.tab(web.active)) web.tab(web.active).wc.forcefullyCrashRenderer();
    });
    win.webContents.once('did-finish-load', () => {
      // Optional page script for UI smoke tests (synthetic clicks are untrusted,
      // so they can never answer an approval dialog).
      if (process.env.JARVIS_SCREENSHOT_SCRIPT) {
        setTimeout(() => win.webContents.executeJavaScript(process.env.JARVIS_SCREENSHOT_SCRIPT).catch((err) => fs.appendFileSync(logFile, `[script] ${err.message}\n`)), 2500);
      }
      setTimeout(async () => {
        const img = await grab();
        fs.writeFileSync(shot, img.toPNG());
        if (process.env.JARVIS_SCREENSHOT_QUIT) app.quit();
      }, Number(process.env.JARVIS_SCREENSHOT_DELAY) || 5000);
    });
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!win || event.sender !== win.webContents) throw new Error('unknown sender');
    return fn(payload, event);
  });
}

function registerIpc() {
  handle('camera:autostart', () => {
    const want = cameraAutoStart;
    cameraAutoStart = false;
    return want;
  });
  handle('app:init', () => ({
    snapshot: core.snapshot(),
    settings: settings.get(),
    defaults: settingDefaults(),
    platform: process.platform,
    version: app.getVersion(),
  }));

  handle('window:control', (p) => {
    v.oneOf(p, ['toggle-fullscreen', 'minimize', 'close', 'query'], 'action');
    if (p === 'toggle-fullscreen') win.setFullScreen(!win.isFullScreen());
    if (p === 'minimize') {
      if (win.isFullScreen()) win.setFullScreen(false);
      win.minimize();
    }
    if (p === 'close') win.close();
    return { fullscreen: win.isFullScreen() };
  });

  handle('settings:update', (p) => {
    v.obj(p);
    if ('permissionMode' in p) throw new Error('ใช้ mode:set สำหรับเปลี่ยน permission mode');
    const r = settings.update(p);
    if (r.ok) {
      const keys = Object.keys(p);
      core.onSettingsChanged(keys);
      if (keys.includes('pushToTalkKey')) registerHotkey();
      if (keys.includes('sttProvider') || keys.includes('whisperModel') || keys.includes('azureRegion')) stt.configure(settings.get());
      send('settings', settings.get());
    }
    return r;
  });

  handle('settings:reset-guard', () => {
    const d = settingDefaults();
    const r = settings.update({ guardBlock: d.guardBlock, guardAsk: d.guardAsk, guardBlockPaths: d.guardBlockPaths });
    core.onSettingsChanged(['guardBlock']);
    send('settings', settings.get());
    return r;
  });

  handle('mode:set', (p) => {
    v.obj(p);
    v.oneOf(p.mode, PERMISSION_MODES, 'mode');
    v.str(p.confirmText ?? '', 40, 'confirmText');
    const r = core.setPermissionMode(p.mode, p.confirmText);
    send('settings', settings.get());
    return r;
  });

  handle('folder:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'เลือกโฟลเดอร์โปรเจกต์ให้ JARVIS ทำงาน', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    core.setCwd(r.filePaths[0]);
    return { ok: true, cwd: core.cwd };
  });

  handle('dir:choose-extra', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'เพิ่มโฟลเดอร์ที่ Claude เข้าถึงได้ (--add-dir)', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('mcp:choose-config', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'เลือกไฟล์ MCP config (.json)', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return null;
    JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); // must be valid JSON
    return r.filePaths[0];
  });

  handle('chat:send', (p) => {
    v.obj(p);
    const text = v.str(p.text ?? '', 20000, 'text');
    const images = p.images === undefined ? [] : p.images;
    if (!Array.isArray(images) || images.length > 4) throw new Error('แนบภาพได้ไม่เกิน 4 ภาพ');
    images.forEach((x, i) => v.str(x, 9 * 1024 * 1024, `images[${i}]`));
    const t0 = v.num(p.t0, 't0', { optional: true, min: 0 });
    try {
      const turnId = core.send({ text, images, t0 });
      return { ok: true, turnId };
    } catch (err) {
      return { ok: false, code: err.code || 'ERROR', error: err.message };
    }
  });

  handle('chat:stop', () => {
    core.stop();
    return { ok: true };
  });
  handle('session:new', () => {
    core.newSession();
    return { ok: true };
  });
  handle('session:new-from-summary', () => core.newSessionFromSummary());
  handle('session:teach-mode', (p) => {
    core.setTeachMode(v.bool(p, 'teach'));
    return { ok: true };
  });
  handle('terminal:open-interactive', () => {
    try {
      return core.openInteractive();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('approval:respond', (p) => {
    v.obj(p);
    v.str(p.id, 100, 'id');
    v.oneOf(p.decision, ['once', 'always', 'deny', 'deny-reason'], 'decision');
    v.str(p.reason ?? '', 1000, 'reason');
    return core.respondApproval(p);
  });

  handle('latency:report', (p) => {
    v.obj(p);
    const rec = {};
    for (const k of ['t_listen_end', 't_transcribed', 't0', 't1', 't2', 't3', 'awaitingMs']) {
      if (p[k] !== undefined && p[k] !== null) rec[k] = v.num(p[k], k, { min: 0 });
    }
    rec.ts = new Date().toISOString();
    fs.appendFile(path.join(app.getPath('userData'), 'latency.log'), JSON.stringify(rec) + '\n', () => {});
    return { ok: true };
  });

  // ---- TTS ----
  handle('tts:synthesize', async (p) => {
    v.obj(p);
    const text = v.str(p.text, 1000, 'text');
    const voice = v.str(p.voice ?? '', 200, 'voice');
    const rate = v.num(p.rate ?? 1, 'rate', { min: 0.5, max: 2 });
    const pitch = v.num(p.pitch ?? 1, 'pitch', { min: 0.5, max: 1.5 });
    try {
      const wav = await tts.synthesize(text, { voice, rate, pitch });
      return { ok: true, wav: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) };
    } catch (err) {
      return { ok: false, code: err.code || 'TTS_FAILED', error: err.message };
    }
  });
  handle('tts:list-system-voices', async () => {
    try {
      return { ok: true, voices: await tts.voices() };
    } catch (err) {
      return { ok: false, error: err.message, voices: [] };
    }
  });
  handle('tts:install-thai-voice', async () => {
    try {
      await installThaiVoice();
      tts.dispose(); // restart worker so it sees the new voice
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('system:open-speech-settings', () => shell.openExternal('ms-settings:speech'));

  // ---- STT (phase 2) ----
  handle('stt:status', () => stt.status());
  handle('stt:install', async () => stt.install((p) => send('install:progress', { what: 'stt', ...p })));
  handle('stt:set-azure-key', (p) => {
    v.str(p, 200, 'key');
    stt.setAzureKey(p);
    return { ok: true };
  });
  handle('stt:transcribe', async (p) => {
    v.obj(p);
    const pcm = v.bytes(p.pcm, 16000 * 2 * 180, 'pcm'); // ≤ 3 minutes of 16 kHz mono int16
    const partial = p.partial === undefined ? false : v.bool(p.partial, 'partial');
    // verify: second-stage wake check on the ~1.6 s around a detection — local whisper
    // only (this audio is from before the wake word, so it never goes to a cloud service), never saved
    const verify = p.verify === undefined ? false : v.bool(p.verify, 'verify');
    if (verify && settings.get().sttProvider !== 'whisper') return { ok: false, code: 'SKIPPED' };
    try {
      const text = await stt.transcribe(pcm, { partial });
      if (partial) return text == null ? { ok: false, code: 'SKIPPED' } : { ok: true, text };
      if (settings.get().saveVoiceHistory && !verify) saveVoice(pcm, text);
      return { ok: true, text };
    } catch (err) {
      return { ok: false, code: err.code || 'STT_FAILED', error: err.message };
    }
  });

  // ---- Hands-free (wake word models + background behaviour) ----
  handle('hf:status', () => wakeAssets.status());
  handle('hf:install', () => wakeAssets.install((p) => send('install:progress', { what: 'hands-free', ...p })));
  handle('hf:model', (p) => {
    v.oneOf(p, WakeAssets.MODEL_NAMES, 'model');
    const buf = wakeAssets.read(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  handle('hf:active', (p) => {
    v.obj(p);
    hf.on = v.bool(p.on, 'on');
    // tray mode keeps timers running at full rate while the window is hidden
    win.webContents.setBackgroundThrottling(!(hf.on && settings.get().handsFreeBackground === 'tray'));
    if (tray) updateTray();
    if (!hf.on && tray && win.isVisible()) hideTray();
    return { ok: true };
  });
  handle('hf:open-history', () => {
    const dir = path.join(app.getPath('userData'), 'voice-history');
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  // ---- Result Viewer: open pages externally ----
  handle('web:open-external', async (p) => {
    const url = v.str(p, 2000, 'url');
    let u;
    try { u = new URL(url); } catch { return { ok: false, error: 'URL ไม่ถูกต้อง' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'เปิดได้เฉพาะ http/https' };
    await shell.openExternal(u.toString());
    return { ok: true };
  });

  // ---- Web Viewer: live pages in WebContentsViews ----
  const tabId = (x) => v.str(x, 20, 'tabId');
  handle('web:open', async (p) => {
    v.obj(p);
    const question = v.str(p.question ?? '', 500, 'question');
    const r = await web.open({ url: v.str(p.url, 4000, 'url'), initiator: v.oneOf(p.initiator ?? 'user', ['user', 'jarvis'], 'initiator') });
    if (r.ok && question) reader.setQuestion(r.tabId, question);
    return r;
  });
  handle('web:summarize', (p) => {
    v.obj(p);
    const t = web.tab(tabId(p.tabId));
    if (!t) return { ok: false, error: 'ไม่พบแท็บ' };
    const q = v.str(p.question ?? '', 500, 'question');
    if (q) reader.setQuestion(t.id, q);
    reader.read(t, v.oneOf(p.mode ?? 'full', ['full', 'continue'], 'mode')).catch(() => {});
    return { ok: true };
  });
  handle('web:ask', (p) => {
    v.obj(p);
    return reader.ask(tabId(p.tabId), v.str(p.question, 500, 'question'));
  });
  handle('web:highlight', async (p) => {
    v.obj(p);
    return { ok: await reader.highlight(tabId(p.tabId), v.str(p.ref, 12, 'ref')).catch(() => false) };
  });
  handle('web:scroll', async (p) => {
    v.obj(p);
    return { ok: await reader.scroll(tabId(p.tabId), v.oneOf(p.dir, ['up', 'down', 'top'], 'dir')).catch(() => false) };
  });
  handle('web:click-link', (p) => {
    v.obj(p);
    return reader.clickLink(tabId(p.tabId), v.str(p.text, 200, 'text'), p.confirmed === true).catch((err) => ({ ok: false, error: err.message }));
  });
  handle('web:resolve', (p) => resolveSite(v.str(p, 300, 'name')));
  handle('web:bounds', (p) => {
    v.obj(p);
    let rect = null;
    if (p.rect) {
      v.obj(p.rect, 'rect');
      rect = {};
      for (const k of ['x', 'y', 'width', 'height']) rect[k] = v.num(p.rect[k], `rect.${k}`, { min: -10000, max: 20000 });
    }
    web.setBounds({ tabId: p.tabId == null ? null : tabId(p.tabId), rect, visible: v.bool(p.visible, 'visible') });
    return { ok: true };
  });
  handle('web:nav', (p) => {
    v.obj(p);
    const action = v.oneOf(p.action, ['back', 'forward', 'reload', 'stop', 'go'], 'action');
    return web.nav(tabId(p.tabId), action, action === 'go' ? v.str(p.url, 4000, 'url') : undefined);
  });
  handle('web:close', (p) => { web.close(tabId(p)); return { ok: true }; });
  handle('web:focus', (p) => { web.focus(tabId(p)); return { ok: true }; });
  handle('web:capture', (p) => web.capture(tabId(p)));
  handle('web:pause', async (p) => { await web.pauseMedia(tabId(p)); return { ok: true }; });
  handle('web:find', (p) => {
    v.obj(p);
    web.find(tabId(p.tabId), v.str(p.text ?? '', 300, 'text'), { forward: p.forward !== false, next: p.next === true });
    return { ok: true };
  });
  handle('web:prompt-respond', (p) => {
    v.obj(p);
    return { ok: web.respond(v.str(p.id, 20, 'id'), v.bool(p.allow, 'allow'), p.remember === true) };
  });
  handle('web:clear-data', async () => {
    try {
      await web.clearData();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- Vision (phase 3) ----
  handle('vision:status', () => vision.status());
  handle('vision:install', () => vision.install((p) => send('install:progress', { what: 'vision', ...p })));
  handle('vision:model', (p) => {
    v.oneOf(p, VisionAssets.MODEL_NAMES, 'model');
    const buf = vision.read(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  handle('snapshot:save', (p) => {
    v.obj(p);
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(v.str(p.dataUrl, 9 * 1024 * 1024, 'dataUrl'));
    if (!m) throw new Error('ภาพต้องเป็น JPEG');
    if (!core.cwd) throw new Error('ยังไม่ได้เลือกโฟลเดอร์');
    const dir = path.join(core.cwd, '.jarvis', 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `step-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
    fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
    return { ok: true, file };
  });
}

/** Optional voice history (Settings, off by default): command audio + transcript. */
function saveVoice(pcm, text) {
  try {
    const dir = path.join(app.getPath('userData'), 'voice-history');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-'));
    fs.writeFileSync(base + '.wav', pcm16ToWav(pcm));
    fs.writeFileSync(base + '.txt', text || '', 'utf8');
  } catch { /* history is optional */ }
}

// ---- system tray (hands-free tray mode only) ----
function showTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromBuffer(trayIconPng(32, { live: hf.on }), { scaleFactor: 2 }));
    tray.on('click', restoreFromTray);
  }
  updateTray();
}

function updateTray() {
  if (!tray) return;
  tray.setImage(nativeImage.createFromBuffer(trayIconPng(32, { live: hf.on }), { scaleFactor: 2 }));
  tray.setToolTip(hf.on ? 'Mee JARVIS · Hands-free กำลังฟัง “จาร์วิส”' : 'Mee JARVIS');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'เปิด JARVIS', click: restoreFromTray },
    { label: 'ปิด Hands-free', enabled: hf.on, click: () => send('hf:command', { action: 'off' }) },
    { type: 'separator' },
    { label: 'ออกจากแอป', click: () => app.quit() },
  ]));
}

function restoreFromTray() {
  if (!win) return;
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  hideTray();
}

function hideTray() {
  if (tray) { tray.destroy(); tray = null; }
}

// Push-to-talk hotkey. Electron's globalShortcut has no key-up event, so the
// hotkey toggles listening; VAD ends the recording on silence.
function registerHotkey() {
  globalShortcut.unregisterAll();
  const key = settings.get().pushToTalkKey;
  try {
    const ok = globalShortcut.register(key, () => send('ptt', { at: Date.now() }));
    if (!ok) send('notice', { level: 'warn', text: `ลงทะเบียนคีย์ลัด ${key} ไม่ได้ (อาจมีโปรแกรมอื่นใช้อยู่)` });
  } catch (err) {
    send('notice', { level: 'warn', text: `คีย์ลัด ${key} ไม่ถูกต้อง: ${err.message}` });
  }
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  settings = new SettingsStore(userData);
  tts = new HybridTts({ edge: new EdgeTts(), fallback: new WinRtTts() });
  stt = new SttService({ dataDir: path.join(userData, 'stt'), tempDir: path.join(app.getPath('temp'), 'mee-jarvis') });
  stt.configure(settings.get());
  vision = new VisionAssets({ dataDir: path.join(userData, 'vision') });
  wakeAssets = new WakeAssets({ dataDir: path.join(userData, 'handsfree') });
  core = new JarvisCore({
    settings,
    tempDir: path.join(app.getPath('temp'), 'mee-jarvis'),
    appRoot: APP_ROOT,
    logDir: userData,
    ui: send,
  });
  await core.init();
  registerAppProtocol();

  // Only the microphone/camera may be requested, and only by our own page.
  const ses = eSession.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const own = win && wc === win.webContents && String(details.requestingUrl || '').startsWith(APP_ORIGIN + '/');
    cb(own && (permission === 'media' || permission === 'speaker-selection'));
  });
  // embedded pages in the Result Viewer share this webContents: only our own origin counts
  ses.setPermissionCheckHandler((wc, permission, origin) => (permission === 'media' || permission === 'speaker-selection') && !!win && wc === win.webContents && String(origin || '').startsWith(APP_ORIGIN));
  // YouTube embeds refuse to play without a Referer (error 153); app:// pages send none
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*'] }, (d, cb) => {
    if (!d.requestHeaders.Referer && !d.requestHeaders.referer) d.requestHeaders.Referer = 'https://mee-jarvis.app/';
    cb({ requestHeaders: d.requestHeaders });
  });

  web = new WebBrowser({
    getWin: () => (win && !win.isDestroyed() ? win : null),
    send,
    perms: new WebPermissions(userData),
    checkPublicUrl: (u) => webReader.checkUrl(u),
    log: process.env.JARVIS_WEB_DEBUG && process.env.JARVIS_SCREENSHOT ? (m) => fs.appendFileSync(process.env.JARVIS_SCREENSHOT.replace(/\.png$/i, '') + '.console.log', `[main] ${m}\n`) : null,
  });
  reader = new PageReader({
    browser: web,
    summarizer: new Summarizer({ getSettings: () => settings.get(), tempDir: path.join(app.getPath('temp'), 'mee-jarvis') }),
    send,
    log: web.o.log,
  });

  registerIpc();
  createWindow();
  registerHotkey();
  // device sleep / screen lock pause hands-free listening; resume restarts it
  for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) {
    powerMonitor.on(ev, () => send('hf:power', { kind: ev }));
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  hideTray();
  if (core) core.cleanup();
  if (tts) tts.dispose();
  if (stt) stt.dispose();
});

app.on('window-all-closed', () => app.quit());
