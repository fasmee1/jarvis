'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session: eSession, globalShortcut, protocol, net, powerMonitor, Tray, Menu, nativeImage, screen, desktopCapturer, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { SettingsStore, defaults: settingDefaults } = require('./lib/settings');
const { JarvisCore } = require('./lib/jarvis-core');
const { MemoryStore } = require('./lib/memory');
const { ReminderStore } = require('./lib/reminders');
const { PttTracker } = require('./lib/ptt');
const { ScreenWatcher, matchWindows, grayThumb, THUMB_W, THUMB_H } = require('./lib/screen-watch');
const { SerialMonitor, listPorts } = require('./lib/serial/monitor');
const { ProjectManager } = require('./lib/projects');
const { listSessions, readSession, deleteSession } = require('./lib/history');
const { AwayDigest } = require('./lib/away-digest');
const { UsageService } = require('./lib/usage/service');
const { resolveClaudeCommand } = require('./lib/claude/resolve');
const { v } = require('./lib/ipc-validate');
const { WinRtTts } = require('./lib/tts/winrt');
const { EdgeTts } = require('./lib/tts/edge');
const { HybridTts } = require('./lib/tts/hybrid');
const { GeminiTts } = require('./lib/tts/gemini');
const { TtsUsage } = require('./lib/tts/usage');
const { installThaiVoice } = require('./lib/installer/thai-voice');
const { PERMISSION_MODES } = require('./lib/claude/args');
const { SttService } = require('./lib/stt');
const { VisionAssets } = require('./lib/installer/vision-assets');
const { Ffmpeg } = require('./lib/video/ffmpeg');
const { MediaRegistry } = require('./lib/video/media');
const { ClipAnalyzer } = require('./lib/video/analyze');
const { VideoService } = require('./lib/video/service');
const { StyleStore } = require('./lib/video/styles');
const { readSkill } = require('./lib/video/skills');
const { askClaude } = require('./lib/video/ask-claude');
const { HfRender, QUALITIES } = require('./lib/video/hf-render');
const { SfxLibrary } = require('./lib/video/sfx-library');
const { CAPTION_STYLES } = require('./lib/video/hf-project');
const exportPresets = require('./lib/video/export-presets');
const effects = require('./lib/video/effects');
const { PACES } = require('./lib/video/presets');
const { WakeAssets } = require('./lib/installer/wake-assets');
const { pcm16ToWav } = require('./lib/stt/wav');
const { trayIconPng } = require('./lib/tray-icon');
const webReader = require('./lib/web/reader');
const { WebBrowser } = require('./lib/web/browser');
const { WebPermissions } = require('./lib/web/permissions');
const { resolveSite } = require('./lib/web/web-utils');
const { Summarizer } = require('./lib/web/summarize');
const { PageReader } = require('./lib/web/page-reader');
const { PdfReader } = require('./lib/web/pdf');
const { MapsKey } = require('./lib/maps-key');
const { Sketchfab } = require('./lib/model3d/sketchfab');
const { ImageTo3d } = require('./lib/model3d/image-to-3d');
const { OrbWindow, ORB_PRELOAD } = require('./lib/orb/orb-window');
const { ApprovalWindow, APPROVAL_PRELOAD } = require('./lib/approval-window');

const APP_ROOT = __dirname;
const APP_ORIGIN = 'app://jarvis';
// Only these folders are reachable from the renderer via app://jarvis/…
const SERVED_DIRS = ['renderer', path.join('node_modules', '@mediapipe', 'tasks-vision'), path.join('node_modules', 'onnxruntime-web', 'dist'), path.join('node_modules', 'maplibre-gl', 'dist')];

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

// clips imported to the video editor, served by random token (lib/video/media.js)
const videoMedia = new MediaRegistry();

function registerAppProtocol() {
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    if (url.host !== 'jarvis') return new Response('not found', { status: 404 });
    if (url.pathname.startsWith('/media/')) return videoMedia.respond(url.pathname, req.headers);
    const rel = path.normalize(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    // downloaded 3D models live in userData, not next to the app
    const modelsDir = path.join(app.getPath('userData'), 'models');
    const isModel = rel.startsWith('models' + path.sep);
    const full = isModel ? path.join(modelsDir, rel.slice('models'.length + 1)) : path.join(APP_ROOT, rel);
    const allowed = isModel
      ? full.startsWith(modelsDir + path.sep)
      : SERVED_DIRS.some((d) => full.startsWith(path.join(APP_ROOT, d) + path.sep));
    if (!allowed || !fs.existsSync(full) || !fs.statSync(full).isFile()) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(full).toString());
  });
}

let win = null;
let core = null;
let projects = null; // background projects: one core per folder (lib/projects.js)
const chosenProjectDirs = new Set(); // folders picked with project:choose
let settings = null;
let memory = null; // long-term voice memory shared by every project's core (lib/memory.js)
let reminders = null; // reminders shared by every project's core (lib/reminders.js)
let remindersStarted = false;
const screenWatch = new ScreenWatcher({
  grab: (t) => grabTarget(t),
  onState: (st) => {
    if (!st.on) protectOwnWindows(false);
    send('screen:watch', st);
  },
});
const serial = new SerialMonitor({ onState: (s) => send('serial:state', s) }); // one open COM port at a time
let tts = null;
let geminiTts = null; // Gemini voice + its usage counter (status shown in Settings)
const awayDigest = new AwayDigest();
let stt = null;
let vision = null;
let ffmpeg = null;
let video = null; // video editor state + analysis jobs (lib/video/service.js)
let videoStyles = null; // clip styles the user picks from (lib/video/styles.js)
let wakeAssets = null;
let mapsKeys = null; // { google, ion, sketchfab } credentials: Google Earth 3D map, 3D model downloads
let modelSource = null; // Sketchfab client behind the jarvis-model-search block
let imageTo3d = null; // picture -> GLB via a Hugging Face Space (jarvis-image-to-3d block)

/** The picture is about to leave this computer: ask the user, every time. */
async function confirmUpload(file) {
  const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'question',
    buttons: ['ส่งรูปไปแปลงเป็น 3D', 'ไม่ส่ง'],
    defaultId: 1,
    cancelId: 1,
    title: 'JARVIS',
    message: 'ส่งรูปนี้ออกไปที่ Hugging Face เพื่อแปลงเป็น 3D?',
    detail: `${file}\n\nรูปจะถูกอัปโหลดไปที่บริการภายนอก (Space ฟรีของ TRELLIS) ไม่ควรส่งรูปที่เป็นความลับ`,
  });
  return r.response === 0;
}
let tray = null;
let web = null; // Web Viewer browser (WebContentsViews in the main window)
let reader = null; // Web Viewer page reader (extraction + summaries)
let orb = null; // Floating Orb (shown while the main window is minimized)
let approvalWin = null; // permission popup in the middle of the desktop (while the main window is minimized)
let usage = null; // real Claude Code usage: limits + token counts (lib/usage)
let mainCrashed = false;
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
      restoreMain();
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
      // mic, wake word, STT and TTS keep running while minimized (the Floating Orb
      // talks to this page); the renderer pauses its own drawing via 'window:bg'
      backgroundThrottling: false,
    },
  });
  win.loadURL(`${APP_ORIGIN}/renderer/index.html`);
  // The renderer never navigates or opens windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => {
    win = null;
    if (approvalWin) approvalWin.destroy();
    // nobody can answer any more: deny what is open so the CLI doesn't wait for the timeout
    if (projects) projects.dropAllApprovals('ปิดหน้าต่างหลักแล้ว');
    openApprovals.length = 0;
    if (orb) orb.destroy(); // last window gone → the app quits
  });
  // Hands-free: in tray mode a minimized window hides to the tray and keeps
  // listening; otherwise the renderer pauses wake listening while hidden
  // (unless the Floating Orb is on screen).
  win.on('minimize', () => {
    if (hf.on && settings.get().handsFreeBackground === 'tray') {
      win.hide();
      showTray();
    }
    orb.show({ force: true });
    // a request that was waiting in the window now needs the desktop popup
    if (approvalWin && openApprovals.length) approvalWin.update(approvalPayload(openApprovals[0], openApprovals.length - 1), true);
    sendBg();
  });
  // away from the window = the user is elsewhere; coming back sums up what the background projects did
  win.on('blur', () => awayDigest.away());
  win.on('minimize', () => awayDigest.away());
  win.on('focus', () => {
    const d = awayDigest.back();
    if (d) send('projects:digest', d);
  });
  for (const ev of ['restore', 'show', 'focus']) {
    win.on(ev, () => {
      if (win.isMinimized() || !win.isVisible()) return;
      if (approvalWin) approvalWin.hide(); // the window shows its own dialog
      orb.hide();
      sendBg();
    });
  }
  win.on('hide', sendBg);
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    mainCrashed = true;
    orb.setMainCrashed(true);
    orb.show({ force: true });
  });
  win.webContents.on('did-finish-load', () => {
    if (mainCrashed) { mainCrashed = false; orb.setMainCrashed(false); }
    if (settings.get().orbEnabled) orb.create(); // ready before the first minimize
    sendBg();
    // overdue reminders speak only once the page has finished booting (the first load only)
    if (reminders && !remindersStarted) {
      remindersStarted = true;
      setTimeout(() => reminders.start(), 6000);
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
      // '[orb-shot] name' → <shot>-orb-name.png of the Floating Orb window (+ its bounds)
      const orbShot = (name) => {
        if (!orb || !orb.alive()) return;
        const b = orb.win.getBounds();
        orb.win.webContents.capturePage().then((img) => {
          fs.writeFileSync(shot.replace(/\.png$/i, '') + `-orb-${name}.png`, img.toPNG());
          fs.appendFileSync(logFile, `[orb] ${name} bounds ${JSON.stringify(b)} visible ${orb.win.isVisible()} focused ${orb.win.isFocused()} crashed ${mainCrashed}\n`);
        }, (err) => fs.appendFileSync(logFile, `[orb] capture failed ${err.message}\n`));
      };
      const o = /^\[orb-shot\] ([\w-]{1,40})$/.exec(String(e.message || ''));
      if (o) orbShot(o[1]);
      // '[crash-main]' crashes this page (tests the orb's crash state, then the relaunch)
      if (e.message === '[crash-main]') {
        setTimeout(() => win.webContents.forcefullyCrashRenderer(), 100);
        setTimeout(() => orbShot('crashed'), 1500);
        setTimeout(() => orbCommand('open-main'), 2500);
        setTimeout(() => fs.appendFileSync(logFile, `[orb] after relaunch: main visible ${win.isVisible()} minimized ${win.isMinimized()} crashed ${mainCrashed} orb visible ${orb.visible}\n`), 6000);
      }
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

/** IPC from the Floating Orb window only. */
function handleOrb(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!orb || !orb.alive() || event.sender !== orb.win.webContents) throw new Error('unknown sender');
    return fn(payload, event);
  });
}

/** Tell the page whether it is in the background and whether the orb is up. */
function sendBg() {
  if (!win || win.isDestroyed()) return;
  send('window:bg', { background: win.isMinimized() || !win.isVisible(), orb: !!orb && orb.visible });
}

/** Restore + focus the main window (from the orb, the tray, a second launch). */
function restoreMain() {
  if (!win || win.isDestroyed()) return;
  if (mainCrashed) win.webContents.reload(); // relaunch a crashed page
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  hideTray();
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
      projects.onSettingsChanged(keys);
      if (['pushToTalkKey', 'pushToTalkMode', 'orbShortcut'].some((k) => keys.includes(k))) registerHotkey();
      if (keys.some((k) => k.startsWith('orb'))) { orb.configure(); sendBg(); }
      if (['sttProvider', 'whisperModel', 'azureRegion', 'sttVocabulary', 'sttCorrections'].some((k) => keys.includes(k))) stt.configure(settings.get());
      send('settings', settings.get());
    }
    return r;
  });

  handle('settings:reset-guard', () => {
    const d = settingDefaults();
    const r = settings.update({ guardBlock: d.guardBlock, guardAsk: d.guardAsk, guardBlockPaths: d.guardBlockPaths });
    projects.onSettingsChanged(['guardBlock']);
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

  // ---- attachments: drag & drop and the ＋ button ----
  const attachResult = (r) => {
    if (r.rejected.length) {
      const why = r.rejected.map((x) => `${path.basename(x.path) || x.path} (${x.reason})`).join(', ');
      send('notice', { level: 'warn', text: `ไม่แนบ: ${why}` });
    }
    return r;
  };
  handle('attach:add', (p) => {
    v.strArray(p, 20, 4096, 'paths');
    return attachResult(core.attach(p));
  });
  handle('attach:choose', async (p) => {
    const kind = v.oneOf(p, ['file', 'folder'], 'kind');
    const r = await dialog.showOpenDialog(win, {
      title: kind === 'folder' ? 'เพิ่มโฟลเดอร์ให้ JARVIS' : 'แนบไฟล์ให้ JARVIS',
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, added: [], rejected: [] };
    return attachResult(core.attach(r.filePaths.slice(0, 20)));
  });
  handle('attach:remove', (p) => {
    core.detach(v.str(p, 4096, 'path'));
    return { ok: true };
  });
  handle('attach:make-project', (p) => {
    const dir = v.str(p, 4096, 'path');
    if (!core.attachedDirs.includes(dir) && !core.pendingAttach.some((a) => a.path === dir && a.kind === 'folder')) throw new Error('ใช้ได้เฉพาะโฟลเดอร์ที่แนบมา');
    core.setCwd(dir);
    return { ok: true, cwd: core.cwd };
  });

  handle('folder:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'เลือกโฟลเดอร์โปรเจกต์ให้ JARVIS ทำงาน', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    core.chooseFolder(r.filePaths[0]);
    return { ok: true, cwd: core.cwd };
  });

  handle('folder:options', () => core.folderOptions());
  handle('folder:needs', (p) => core.needsFolderPick(v.str(p, 20000, 'text')));

  handle('folder:select', (p) => {
    const dir = v.str(p, 4096, 'path');
    if (!core.folderOptions().some((o) => o.path === dir)) throw new Error('ใช้ได้เฉพาะโฟลเดอร์ในรายการ');
    core.chooseFolder(dir);
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
    const imageSource = p.imageSource === undefined ? 'camera' : v.oneOf(p.imageSource, ['camera', 'screen', 'pasted'], 'imageSource');
    try {
      const turnId = core.send({ text, images, imageSource, t0 });
      return { ok: true, turnId };
    } catch (err) {
      return { ok: false, code: err.code || 'ERROR', error: err.message };
    }
  });

  // "ดูนี่" with the camera off: a picture of the screen (or of one window) the user is looking at.
  // While watching, the latest changed frame is used instead of a new capture.
  handle('screen:capture', async (p) => {
    try {
      const q = p === undefined ? {} : v.obj(p);
      const hint = v.str(q.windowHint === undefined ? '' : q.windowHint, 80, 'windowHint');
      const id = v.str(q.windowId === undefined ? '' : q.windowId, 300, 'windowId');
      if (!hint && !id) {
        const f = screenWatch.latest();
        if (f) return { ok: true, dataUrl: f.dataUrl, watched: true, target: screenWatch.state.target.name };
        return { ok: true, dataUrl: await captureScreen() };
      }
      const r = await resolveWindow(hint, id);
      if (!r.target) return r;
      return { ok: true, dataUrl: (await grabTarget(r.target)).dataUrl, target: r.target.name };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('screen:watch', async (p) => {
    const q = v.obj(p);
    v.oneOf(q.op, ['start', 'stop', 'status'], 'op');
    if (q.op === 'status') return { ok: true, ...screenWatch.state };
    if (q.op === 'stop') {
      screenWatch.stop('manual');
      return { ok: true, ...screenWatch.state };
    }
    try {
      const hint = v.str(q.windowHint === undefined ? '' : q.windowHint, 80, 'windowHint');
      const id = v.str(q.windowId === undefined ? '' : q.windowId, 300, 'windowId');
      let target = { kind: 'screen', displayId: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id, name: 'ทั้งหน้าจอ' };
      if (hint || id) {
        const r = await resolveWindow(hint, id);
        if (!r.target) return r;
        target = r.target;
      } else {
        protectOwnWindows(true);
        await new Promise((done) => setTimeout(done, 120)); // let the compositor drop JARVIS's windows
      }
      const st = settings.get();
      await screenWatch.start(target, { intervalMs: st.screenWatchIntervalSec * 1000, maxMs: st.screenWatchMaxMin * 60000 });
      return { ok: true, ...screenWatch.state };
    } catch (err) {
      protectOwnWindows(false);
      return { ok: false, error: err.message };
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
  // ---- usage: limits (% used, reset time) and token counts ----
  handle('usage:get', async () => (usage ? usage.refresh() : null));
  handle('usage:ping', async () => {
    if (!usage) return { ok: false, error: 'ยังไม่พร้อม' };
    const r = await usage.ping();
    if (r.ok) await usage.refresh();
    return { ...r, snapshot: usage.snapshot() };
  });

  // ---- conversation history (Claude Code's own transcripts; delete = Recycle Bin) ----
  const sessionId = (x) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x))) throw new Error('session id ไม่ถูกต้อง');
    return x;
  };
  handle('skills:list', () => ({ ok: true, items: core.listCommands() }));
  handle('history:list', () => {
    const snap = core.snapshot();
    return { ok: true, cwd: core.cwd, current: snap.sessionId || null, sessions: core.cwd ? listSessions(core.cwd) : [] };
  });
  handle('history:read', (p) => {
    const messages = readSession(core.cwd, sessionId(p));
    return messages ? { ok: true, messages } : { ok: false, error: 'ไม่พบบทสนทนานี้' };
  });
  handle('history:delete', async (p) => {
    const id = sessionId(p);
    if (id === core.snapshot().sessionId) return { ok: false, error: 'ลบบทสนทนาที่ใช้อยู่ตอนนี้ไม่ได้' };
    try {
      return await deleteSession(core.cwd, id, { trash: (f) => shell.trashItem(f) })
        ? { ok: true }
        : { ok: false, error: 'ไม่พบบทสนทนานี้' };
    } catch (err) {
      return { ok: false, error: `ลบไม่ได้: ${err.message}` };
    }
  });
  handle('history:resume', (p) => {
    const id = sessionId(p);
    const messages = readSession(core.cwd, id);
    if (!messages) return { ok: false, error: 'ไม่พบบทสนทนานี้' };
    try {
      core.resumeSession(id);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: true, messages };
  });

  handle('mcp:info', () => local(() => core.mcpInfo()));
  handle('mcp:reconnect', () => local(() => core.mcpReconnect()));

  handle('build:reset', () => {
    core.resetBuildTime();
    return { ok: true };
  });
  // local coding voice commands: errors come back as {ok:false, error} so the HUD can say them
  const local = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  };
  handle('code:run', (p) => local(async () => {
    v.obj(p);
    v.oneOf(p.kind, ['test', 'check'], 'kind');
    return { ...(await core.runCheck(p.kind)), done: true };
  }));
  handle('code:cancel', () => ({ ok: core.tools.cancel() }));
  // diff / undo work on the HUD's project, or on a background project when it has a projectId
  const coreFor = (p) => {
    const c = projects.get(v.projectId(p && p.projectId !== undefined ? p.projectId : 'main'));
    if (!c) throw new Error('ไม่พบโปรเจกต์');
    return c;
  };
  handle('code:diff', (p) => local(() => coreFor(p).projectDiff()));
  handle('code:undo-preview', (p) => local(() => {
    const files = p && p.files !== undefined ? v.strArray(p.files, 200, 1000, 'files') : undefined;
    return coreFor(p).undoPreview(files);
  }));
  handle('code:undo', (p) => local(() => {
    v.obj(p);
    v.str(p.token, 200, 'token');
    const files = p.files === undefined ? undefined : v.strArray(p.files, 200, 1000, 'files'); // only these paths
    return coreFor(p).undoApply(p.token, files);
  }));
  handle('session:coding-mode', (p) => {
    core.setCodingMode(v.bool(p, 'coding'));
    return { ok: true };
  });
  handle('session:planning-mode', (p) => {
    core.setPlanningMode(v.bool(p, 'planning'));
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
    const projectId = v.projectId(p.projectId ?? 'main');
    return projects.respondApproval(projectId, { id: p.id, decision: p.decision, reason: p.reason });
  });

  // ---- background projects: one core + one task per folder ----
  handle('project:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'เลือกโฟลเดอร์สำหรับงานเบื้องหลัง', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const dir = path.resolve(r.filePaths[0]);
    chosenProjectDirs.add(dir.toLowerCase());
    return { ok: true, path: dir };
  });
  handle('project:start', async (p) => {
    v.obj(p);
    const dir = path.resolve(v.str(p.dir, 4096, 'dir'));
    const text = v.str(p.text, 20000, 'text');
    // only folders the user picked: the dialog, the folder list, or an existing project
    const key = dir.toLowerCase();
    const known = chosenProjectDirs.has(key)
      || core.folderOptions().some((o) => o.path.toLowerCase() === key)
      || projects.list().some((x) => x.cwd.toLowerCase() === key);
    if (!known) return { ok: false, code: 'FOLDER', error: 'ใช้ได้เฉพาะโฟลเดอร์ที่เลือกไว้' };
    try {
      return await projects.start({ dir, text, isolate: p.isolate === undefined ? false : v.bool(p.isolate, 'isolate'), approval: p.approval === 'auto' || p.approval === 'ask' ? p.approval : undefined });
    } catch (err) {
      return { ok: false, code: err.code || 'ERROR', error: err.message };
    }
  });
  handle('project:stop', (p) => {
    v.obj(p);
    return projects.stop(v.projectId(p.projectId));
  });
  // the HUD takes over a finished project's conversation (same folder, same Claude session)
  handle('project:promote', (p) => {
    v.obj(p);
    const r = projects.promote(v.projectId(p.projectId));
    if (!r.ok) return r;
    return { ok: true, cwd: r.cwd, title: path.basename(r.cwd), messages: readSession(r.cwd, r.sessionId) || [] };
  });
  handle('project:dequeue', (p) => {
    v.obj(p);
    return projects.dequeue(v.projectId(p.projectId), v.num(p.index, 'index', { min: 0, max: 100 }));
  });
  handle('project:remove', (p) => {
    v.obj(p);
    return projects.remove(v.projectId(p.projectId));
  });
  handle('project:list', () => ({ ok: true, projects: projects.list() }));

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
  handle('tts:gemini-status', () => geminiTts.status());  handle('tts:set-gemini-key', (p) => {
    v.str(p, 200, 'key');
    mapsKeys.gemini.set(p);
    geminiTts.downUntil = 0; // a new key gets a fresh try
    geminiTts.failures = 0;
    return { ok: true };
  });
  handle('system:open-speech-settings', () => shell.openExternal('ms-settings:speech'));

  // ---- STT (phase 2) ----
  handle('stt:status', () => stt.status());
  handle('stt:install', async () => stt.install((p) => send('install:progress', { what: 'stt', ...p })));
  handle('stt:set-azure-key', (p) => {
    v.str(p, 200, 'key');
    stt.setKey('azure', p);
    return { ok: true };
  });
  handle('stt:set-typhoon-key', (p) => {
    v.str(p, 200, 'key');
    stt.setKey('typhoon', p);
    return { ok: true };
  });
  // ---- Google Earth 3D map (optional) ----
  handle('maps:earth-keys', () => ({ google: mapsKeys.google.get(), ion: mapsKeys.ion.get() }));
  handle('maps:set-google-key', (p) => {
    v.str(p, 200, 'key');
    mapsKeys.google.set(p);
    return { ok: true };
  });
  handle('maps:set-ion-key', (p) => {
    v.str(p, 2000, 'key'); // ion tokens are JWTs (~200–1000 chars)
    mapsKeys.ion.set(p);
    return { ok: true };
  });
  handle('model3d:set-sketchfab-token', (p) => {
    v.str(p, 200, 'token');
    mapsKeys.sketchfab.set(p);
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
      const text = await stt.transcribe(pcm, { partial, fast: verify }); // the wake check only needs to hear "จาร์วิส"
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
    if (tray) updateTray();
    if (!hf.on && tray && win.isVisible()) hideTray();
    return { ok: true };
  });
  handle('memory:list', () => (memory ? memory.list() : []));
  handle('memory:remove', (p) => {
    v.obj(p);
    return { ok: !!memory && memory.remove(v.str(p, 200, 'text')) };
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
    reader.read(t, v.oneOf(p.mode ?? 'full', ['full', 'continue'], 'mode'), { force: true }).catch(() => {});
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

  // ---- Floating Orb ----
  // main window → orb: state (only what changed) and the live level
  const ORB_STATES = ['idle', 'listening', 'thinking', 'speaking', 'muted', 'error'];
  handle('orb:sync', (p) => {
    v.obj(p);
    const out = {};
    for (const [k, x] of Object.entries(p)) {
      if (k === 'state') out[k] = v.oneOf(x, ORB_STATES, 'state');
      else if (['hf', 'micOff', 'voiceMuted', 'replyDone', 'result'].includes(k)) out[k] = v.bool(x, k);
      else if (k === 'transcript') out[k] = v.str(x, 500, k);
      else if (k === 'reply') out[k] = v.str(x, 800, k);
      else if (k === 'attention' || k === 'error') out[k] = v.str(x, 300, k);
      else if (k === 'errorId' || k === 'typeId') out[k] = v.num(x, k, { min: 0 });
      else throw new Error('IPC input ไม่ถูกต้อง: ' + k);
    }
    if (mainCrashed) return { ok: true };
    const hadResult = !!orb.state.result;
    orb.setState(out);
    // "เปิดหน้าต่างอัตโนมัติเมื่อมีผลลัพธ์"
    if (out.result && !hadResult && orb.visible && settings.get().orbAutoOpenResults) {
      restoreMain();
      send('orb:cmd', { action: 'open-result' });
    }
    return { ok: true };
  });
  handle('orb:level', (p) => {
    orb.level(v.num(p, 'level', { min: 0, max: 1 }));
    return { ok: true };
  });
  // orb → main
  handleOrb('orb:ready', () => { orb.onReady(); return { ok: true }; });
  handleOrb('orb:cmd', (p) => {
    v.obj(p);
    const action = v.oneOf(p.action, ['toggle-listen', 'open-main', 'open-result', 'open-talk', 'send-text'], 'action');
    orbCommand(action, action === 'send-text' ? { text: v.str(p.text, 2000, 'text') } : {});
    return { ok: true };
  });
  handle('approval:approve-safe', () => ({ ok: true, count: projects.approveSafeAll() }));
  ipcMain.handle('approval-win:approve-safe', async (event) => {
    if (!approvalWin || !approvalWin.alive() || event.sender !== approvalWin.win.webContents) throw new Error('unknown sender');
    return { ok: true, count: projects.approveSafeAll() };
  });
  // desktop permission popup → main (genuine clicks in that window are the answer)
  ipcMain.handle('approval-win:respond', async (event, p) => {
    if (!approvalWin || !approvalWin.alive() || event.sender !== approvalWin.win.webContents) throw new Error('unknown sender');
    v.obj(p);
    v.str(p.id, 100, 'id');
    v.oneOf(p.decision, ['once', 'always', 'deny', 'deny-reason'], 'decision');
    v.str(p.reason ?? '', 1000, 'reason');
    const projectId = v.projectId(p.projectId ?? 'main');
    return projects.respondApproval(projectId, { id: p.id, decision: p.decision, reason: p.reason });
  });
  handleOrb('orb:panel', (p) => {
    if (p === null) return orb.setPanel(null);
    v.obj(p);
    return orb.setPanel({ w: v.num(p.w, 'w', { min: 40, max: 400 }), h: v.num(p.h, 'h', { min: 20, max: 400 }) });
  });
  handleOrb('orb:focusable', (p) => { orb.setFocusable(v.bool(p, 'focusable')); return { ok: true }; });
  handleOrb('orb:hit', (p) => { orb.setHit(v.bool(p, 'hit')); return { ok: true }; });
  handleOrb('orb:menu', () => { orb.menu(); return { ok: true }; });
  handleOrb('orb:drag', (p) => {
    const phase = v.oneOf(p, ['start', 'move', 'end'], 'phase');
    if (phase === 'start') orb.dragStart();
    else if (phase === 'move') orb.dragMove();
    else orb.dragEnd();
    return { ok: true };
  });

  // ---- Serial monitor: Arduino / ESP32 on a COM port (lib/serial) ----
  handle('serial:ports', () => listPorts());
  handle('serial:open', (p) => {
    v.obj(p);
    try {
      serial.open(v.str(p.port, 8, 'port'), v.num(p.baud, 'baud', { min: 1200, max: 921600 }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  handle('serial:close', () => { serial.close(); return { ok: true }; });
  handle('serial:chart', () => (serial.isOpen || serial.buffer.lines.length ? serial.chart() : { error: 'ยังไม่ได้เปิดซีเรียล พูดว่า เปิดซีเรียล ก่อน' }));

  // ---- Vision (phase 3) ----
  handle('vision:status', () => vision.status());
  handle('vision:install', () => vision.install((p) => send('install:progress', { what: 'vision', ...p })));

  // ---- video editor ----
  handle('video:ffmpeg-status', () => ffmpeg.status());
  handle('video:ffmpeg-install', () => ffmpeg.install((p) => send('install:progress', { what: 'ffmpeg', ...p })));
  handle('video:state', () => video.snapshot());
  handle('video:choose', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'เลือกคลิปที่จะตัดต่อ',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'วิดีโอและเสียง', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return { added: [], rejected: [] };
    return video.importFiles(r.filePaths.slice(0, 20));
  });
  handle('video:import', (p) => {
    v.strArray(p, 20, 4096, 'paths');
    return video.importFiles(p);
  });
  handle('video:analyze', (p) => video.analyze(v.str(p, 16, 'sourceId')));
  handle('video:subtitles', () => video.makeSubtitles());
  handle('video:cancel', () => video.cancel());
  handle('video:cut-start', (p) => {
    v.obj(p);
    const captionStyle = p.captionStyle === undefined ? 'classic' : v.str(p.captionStyle, 20, 'captionStyle');
    if (!CAPTION_STYLES[captionStyle]) throw new Error('แบบซับไม่ถูกต้อง');
    if (p.director === true) return video.startDirect({ styleId: v.str(p.styleId, 20, 'styleId'), note: v.str(p.note, 1000, 'note', { optional: true }) || '' });
    return video.startCut({ styleId: v.str(p.styleId, 20, 'styleId'), note: v.str(p.note, 1000, 'note', { optional: true }) || '', captionStyle });
  });
  handle('video:cut-cancel', () => video.cancelCut());
  handle('video:direct-revise', (p) => {
    v.obj(p);
    return video.reviseDirect({ instruction: v.str(p.instruction, 1000, 'instruction') });
  });
  handle('video:edit', (p) => {
    v.obj(p);
    const id = () => v.str(p.id, 20, 'id');
    const num = (k) => { if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) throw new Error(`${k} ต้องเป็นตัวเลข`); return p[k]; };
    const opt = (k) => (p[k] === undefined ? undefined : num(k));
    const num2 = (x, k) => { if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${k} ต้องเป็นตัวเลข`); return x; };
    const optStr = (k) => (p[k] === undefined ? undefined : v.str(p[k], 20, k));
    switch (p.op) {
      case 'split': return video.edit({ op: 'split', at: num('at') });
      case 'trim': return video.edit({ op: 'trim', id: id(), in: opt('in'), out: opt('out') });
      case 'remove': return video.edit({ op: 'remove', id: id() });
      case 'move': return video.edit({ op: 'move', id: id(), to: Math.trunc(num('to')) });
      case 'speed': return video.edit({ op: 'speed', id: id(), speed: num('speed') });
      case 'overlay-add':
      case 'overlay-update': {
        v.obj(p.overlay);
        const o = p.overlay;
        const text = (k, max) => (o[k] === undefined ? undefined : v.str(o[k], max, k, { optional: true }) || '');
        const n = (k) => (o[k] === undefined ? undefined : num2(o[k], k));
        const overlay = { kind: o.kind === undefined ? undefined : v.str(o.kind, 20, 'kind'), text: text('text', 200), text2: text('text2', 200), suffix: text('suffix', 20), sfx: o.sfx === undefined ? undefined : v.str(o.sfx, 20, 'sfx'), x: n('x'), y: n('y'), size: n('size'), color: o.color === undefined ? undefined : v.str(o.color, 20, 'color', { optional: true }) || '', from: n('from'), to: n('to'), start: n('start'), end: n('end') };
        for (const k of Object.keys(overlay)) if (overlay[k] === undefined) delete overlay[k];
        return p.op === 'overlay-add' ? video.edit({ op: 'overlay-add', overlay }) : video.edit({ op: 'overlay-update', id: id(), overlay });
      }
      case 'overlay-remove': return video.edit({ op: 'overlay-remove', id: id() });
      case 'overlay-vars': {
        v.obj(p.values);
        const entries = Object.entries(p.values);
        if (entries.length > 8) throw new Error('ตัวแปรมากเกินไป');
        const values = {};
        for (const [k, x] of entries) {
          if (!/^[a-z][a-z0-9_]{0,19}$/.test(k)) throw new Error('ชื่อตัวแปรไม่ถูกต้อง');
          values[k] = v.str(x, 80, k, { optional: true }) || '';
        }
        return video.edit({ op: 'overlay-vars', id: id(), values });
      }
      case 'fx': return video.edit({ op: 'fx', id: id(), fx: optStr('fx'), sfx: optStr('sfx'), fxOut: optStr('fxOut') });
      case 'fx-all': return video.edit({ op: 'fx-all', fx: optStr('fx'), sfx: optStr('sfx'), fxOut: optStr('fxOut') });
      default: throw new Error('คำสั่งตัดต่อนี้ไม่รู้จัก');
    }
  });
  handle('video:caption-edit', (p) => {
    v.obj(p);
    return video.editCaption({ sourceId: v.str(p.sourceId, 20, 'sourceId'), i: Math.trunc(Number(p.i)), text: v.str(p.text, 400, 'text') });
  });
  handle('video:caption-time', (p) => {
    v.obj(p);
    return video.setCaptionTime({ sourceId: v.str(p.sourceId, 20, 'sourceId'), i: Math.trunc(Number(p.i)), start: p.start, end: p.end });
  });
  handle('video:caption-restore', (p) => {
    v.obj(p);
    return video.restoreCaption({ sourceId: v.str(p.sourceId, 20, 'sourceId'), i: Math.trunc(Number(p.i)) });
  });
  handle('video:caption-fix', (p) => {
    v.obj(p);
    return video.fixCaptions({ sourceId: v.str(p.sourceId, 20, 'sourceId'), hint: v.str(p.hint, 500, 'hint', { optional: true }) || '' });
  });
  handle('video:render-start', (p) => {
    v.obj(p);
    const captionStyle = v.str(p.captionStyle, 20, 'captionStyle');
    const quality = v.str(p.quality, 20, 'quality');
    if (!CAPTION_STYLES[captionStyle]) throw new Error('แบบซับไม่ถูกต้อง');
    if (!QUALITIES[quality]) throw new Error('คุณภาพไม่ถูกต้อง');
    return video.startRender({ captionStyle, quality });
  });
  handle('video:render-cancel', () => video.cancelRender());
  handle('video:export-presets', () => ({
    presets: Object.values(exportPresets.PRESETS).map((x) => ({ id: x.id, label: x.label, note: x.note, width: x.width, height: x.height, maxSec: x.maxSec, tipSec: x.tipSec })),
    fits: Object.entries(exportPresets.FITS).map(([id, label]) => ({ id, label })),
    fx: Object.values(effects.FX).map((x) => ({ id: x.id, label: x.label })),
    sfx: Object.values(effects.SFX).map((x) => ({ id: x.id, label: x.label })),
    fxOut: Object.values(effects.FX_OUT).map((x) => ({ id: x.id, label: x.label })),
  }));
  handle('video:export-start', async (p) => {
    v.obj(p);
    const captionStyle = v.str(p.captionStyle, 20, 'captionStyle');
    const presetId = v.str(p.preset, 20, 'preset');
    const fit = v.str(p.fit, 20, 'fit');
    if (!CAPTION_STYLES[captionStyle]) throw new Error('แบบซับไม่ถูกต้อง');
    const preset = exportPresets.preset(presetId);
    const first = [...video.sources.values()][0];
    const r = await dialog.showSaveDialog(win, {
      title: `บันทึกวิดีโอสำหรับ ${preset.label}`,
      defaultPath: path.join(app.getPath('videos'), exportPresets.suggestName(first && first.name, preset)),
      filters: [{ name: 'วิดีโอ MP4', extensions: ['mp4'] }],
    });
    if (r.canceled || !r.filePath) return { cancelled: true };
    const target = /\.mp4$/i.test(r.filePath) ? r.filePath : `${r.filePath}.mp4`;
    return video.startExport({ captionStyle, preset: presetId, fit, target });
  });
  handle('video:sfx-list', () => video.soundList());
  handle('video:sfx-find', (p) => {
    v.obj(p);
    return video.startSfxSearch({ query: v.str(p.query, 200, 'query', { optional: true }) || '' });
  });
  handle('video:sfx-cancel', () => video.cancelSfx());
  handle('video:sfx-remove', (p) => {
    v.obj(p);
    return video.removeSound(v.str(p.id, 20, 'id'));
  });
  handle('video:export-reveal', () => {
    const f = video.lastExportPath();
    if (!f) throw new Error('ยังไม่มีไฟล์ที่ส่งออก');
    shell.showItemInFolder(f);
    return { ok: true };
  });
  handle('video:undo', () => {
    if (video.cut) throw new Error('รอให้ JARVIS ตัดต่อเสร็จก่อน');
    video.history.undo();
    return video.snapshot();
  });
  handle('video:redo', () => {
    if (video.cut) throw new Error('รอให้ JARVIS ตัดต่อเสร็จก่อน');
    video.history.redo();
    return video.snapshot();
  });
  const stylesReply = (extra = {}) => ({ styles: videoStyles.list(), last: videoStyles.last().id, paces: Object.values(PACES).map((p) => ({ id: p.id, label: p.label })), ...extra });
  handle('video:styles', () => stylesReply());
  handle('video:style-save', (p) => {
    v.obj(p);
    const id = v.str(p.id, 20, 'id', { optional: true });
    const style = videoStyles.save({ id, name: p.name, prompt: p.prompt, pace: p.pace, targetSec: p.targetSec });
    return stylesReply({ saved: style.id });
  });
  // the path comes from the main-process dialog only, never from the page
  handle('video:skill-import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'เลือกไฟล์สกิลการตัดต่อ (SKILL.md)',
      properties: ['openFile'],
      filters: [{ name: 'สกิล (Markdown)', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (r.canceled || !r.filePaths.length) return stylesReply({ cancelled: true });
    const style = videoStyles.importSkill(readSkill(r.filePaths[0]));
    videoStyles.setLast(style.id);
    return stylesReply({ saved: style.id });
  });
  handle('video:style-remove', (p) => {
    videoStyles.remove(v.str(p, 20, 'id'));
    return stylesReply();
  });
  handle('video:style-reset', (p) => {
    videoStyles.reset(v.str(p, 20, 'id'));
    return stylesReply();
  });
  handle('video:style-pick', (p) => {
    videoStyles.setLast(v.str(p, 20, 'id'));
    return stylesReply();
  });
  handle('video:reset', () => {
    video.reset();
    return video.snapshot();
  });
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

/** A command from the orb (click / bubble / menu): window actions here, voice actions in the page. */
function orbCommand(action, extra = {}) {
  // "ดูเพิ่ม" (open-talk) restores the window like open-main, then opens the conversation in it
  if (action === 'open-main' || (action === 'open-talk' && mainCrashed)) return restoreMain();
  if (mainCrashed) {
    // the page is gone: the only useful action is relaunching it (double-click)
    orb.setMainCrashed(true);
    return undefined;
  }
  if (action === 'open-result' || action === 'open-talk') {
    restoreMain();
    return send('orb:cmd', { action });
  }
  // hands-free needs the consent dialog the first time: show the window for it
  if (action === 'hf-toggle' && !hf.on && !settings.get().handsFreeConsent) restoreMain();
  if (action === 'toggle-listen') return send('ptt', { at: Date.now() });
  return send('orb:cmd', { action, ...extra });
}

/**
 * Permission requests also open a popup in the middle of the desktop while the main
 * window is minimized or hidden (lib/approval-window.js), so they can be answered without
 * opening JARVIS. The popup shows the oldest open request in full; answers come back
 * through 'approval-win:respond'. With the main window up, its own dialog is used.
 */
const openApprovals = [];
const APPROVAL_DIFF_MAX = 400;
const APPROVAL_TEXT_MAX = 20000;
const mainHidden = () => !win || win.isDestroyed() || win.isMinimized() || !win.isVisible();

function approvalPayload(r, queue) {
  const input = r.input || {};
  // long strings are cut while serializing, so a multi-MB Write doesn't stall the main process
  const text = (x) => {
    if (typeof x === 'string') return x.slice(0, APPROVAL_TEXT_MAX + 1);
    try {
      return JSON.stringify(x, (_k, v) => (typeof v === 'string' && v.length > APPROVAL_TEXT_MAX ? v.slice(0, APPROVAL_TEXT_MAX + 1) : v), 2) ?? '';
    } catch { return '[ไม่สามารถแสดงข้อมูลนี้ได้]'; }
  };
  const kind = typeof input.command === 'string' ? 'command' : typeof input.url === 'string' ? 'url' : 'input';
  const raw = text(input.command ?? input.url ?? input);
  const diff = r.preview && Array.isArray(r.preview.diff) ? r.preview.diff : [];
  const hasDiff = diff.length > 0;
  const plan = r.preview && typeof r.preview.plan === 'string' ? r.preview.plan : ''; // ExitPlanMode: the plan to approve
  return {
    id: r.id,
    projectId: r.projectId || 'main',
    projectName: String(r.projectName || ''),
    tool: String(r.tool || ''),
    summary: String(r.summary || ''),
    reason: r.reason || '',
    rule: r.rule || '',
    timeoutSec: r.timeoutSec,
    createdAt: r.createdAt,
    queue,
    safe: !!r.safe,
    safeCount: openApprovals.filter((x) => x.safe).length,
    file: String((r.preview && r.preview.file) || input.file_path || input.notebook_path || ''),
    isNew: !!(r.preview && r.preview.isNew),
    // the raw input is only repeated when the diff doesn't already say it all
    plan: plan.slice(0, APPROVAL_TEXT_MAX),
    planCut: plan.length > APPROVAL_TEXT_MAX,
    detail: plan || (hasDiff && kind === 'input') ? '' : raw.slice(0, APPROVAL_TEXT_MAX),
    detailKind: kind,
    detailCut: raw.length > APPROVAL_TEXT_MAX,
    diff: diff.slice(0, APPROVAL_DIFF_MAX).map((d) => ({ op: d.op, line: String(d.line ?? '').slice(0, 500) })),
    diffCut: diff.length > APPROVAL_DIFF_MAX,
  };
}

function approvalFeed(channel, p) {
  if (channel === 'approval:request') openApprovals.push(p);
  else if (channel === 'approval:close') {
    const i = openApprovals.findIndex((r) => r.id === p.id);
    if (i >= 0) openApprovals.splice(i, 1);
  } else return;
  if (!approvalWin || approvalWin.quitting) return; // main window is gone: don't re-create the popup
  const r = openApprovals[0];
  approvalWin.update(r ? approvalPayload(r, openApprovals.length - 1) : null, mainHidden());
}

const SCREEN_MAX_W = 1600; // enough to read text on screen, small enough for the model

function ownWindows() {
  return [win, orb && orb.alive() ? orb.win : null].filter((w) => w && !w.isDestroyed() && w.isVisible());
}

/** WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+): JARVIS's own windows disappear from screen captures. */
function protectOwnWindows(on) {
  for (const w of ownWindows()) w.setContentProtection(on);
}

function packImage(img) {
  const size = img.getSize();
  const big = size.width > SCREEN_MAX_W ? img.resize({ width: SCREEN_MAX_W }) : img;
  const small = img.resize({ width: THUMB_W, height: THUMB_H, quality: 'good' });
  return {
    dataUrl: 'data:image/jpeg;base64,' + big.toJPEG(80).toString('base64'),
    thumb: grayThumb(small.toBitmap()),
  };
}

/** One picture of a target: { kind: 'screen', displayId } or { kind: 'window', id }. */
async function grabTarget(t) {
  if (t.kind === 'window') {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: SCREEN_MAX_W, height: SCREEN_MAX_W } });
    const src = sources.find((s) => s.id === t.id);
    if (!src || src.thumbnail.isEmpty()) throw new Error('จับภาพหน้าต่างไม่ได้ (อาจถูกย่อหรือปิดไปแล้ว)');
    return packImage(src.thumbnail);
  }
  const d = screen.getAllDisplays().find((x) => x.id === t.displayId) || screen.getPrimaryDisplay();
  if (screenWatch.on) protectOwnWindows(true); // a window opened since the last check (the orb)
  const width = Math.min(SCREEN_MAX_W, Math.round(d.size.width * d.scaleFactor));
  const height = Math.round((width * d.size.height) / d.size.width);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('จับภาพหน้าจอไม่ได้');
  return packImage(src.thumbnail);
}

/** Open windows the user could mean (JARVIS's own windows left out). */
async function listWindows() {
  const own = new Set([win, orb && orb.alive() ? orb.win : null].filter((w) => w && !w.isDestroyed()).map((w) => w.getMediaSourceId()));
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  return sources.filter((s) => s.name && !own.has(s.id)).map((s) => ({ id: s.id, name: s.name.slice(0, 120) }));
}

/** hint (spoken kind or words) or id -> { target } | { ok: false, error, choose? } */
async function resolveWindow(hint, id) {
  const wins = await listWindows();
  const found = id ? wins.filter((w) => w.id === id) : matchWindows(wins, hint);
  if (!found.length) return { ok: false, error: `ไม่พบหน้าต่าง ${hint || 'ที่เลือก'} ที่เปิดอยู่` };
  if (found.length > 1) return { ok: false, choose: found.slice(0, 8), error: `มี ${found.length} หน้าต่างที่ตรงกับ ${hint}` };
  return { target: { kind: 'window', id: found[0].id, name: found[0].name } };
}

/**
 * JPEG data URL of the display under the mouse. JARVIS's own windows (main + orb)
 * are excluded from the capture, so a fullscreen JARVIS doesn't hide what the user means.
 */
async function captureScreen() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const keep = screenWatch.on; // while watching the screen, protection stays on
  const own = ownWindows();
  for (const w of own) w.setContentProtection(true);
  try {
    if (own.length) await new Promise((done) => setTimeout(done, 120)); // let the compositor drop them
    return (await grabTarget({ kind: 'screen', displayId: d.id })).dataUrl;
  } finally {
    if (!keep) for (const w of own) if (!w.isDestroyed()) w.setContentProtection(false);
  }
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
  restoreMain();
}

function hideTray() {
  if (tray) { tray.destroy(); tray = null; }
}

// Push-to-talk hotkey. Electron's globalShortcut has no key-up event, so in "toggle" mode the
// hotkey toggles listening and VAD ends the recording on silence. In "hold" mode a native
// keyboard hook (uiohook-napi) reports key-down / key-up for the one configured combination
// only; if it cannot start, the toggle shortcut is used instead.
let pttHook = null; // { uIOhook, tracker, onDown, onUp }

function stopPttHook() {
  if (!pttHook) return;
  try {
    pttHook.uIOhook.off('keydown', pttHook.onDown);
    pttHook.uIOhook.off('keyup', pttHook.onUp);
    pttHook.uIOhook.stop();
  } catch { /* already stopped */ }
  pttHook = null;
}

function startPttHook(accelerator) {
  stopPttHook();
  let mod;
  try {
    mod = require('uiohook-napi');
  } catch (err) {
    send('notice', { level: 'warn', text: `โหลดตัวจับการกดค้างไม่ได้ ใช้แบบกดสลับแทน: ${err.message}` });
    return false;
  }
  const tracker = new PttTracker(accelerator, mod.UiohookKey);
  if (!tracker.valid) {
    send('notice', { level: 'warn', text: `คีย์ลัด ${accelerator} ใช้กับโหมดกดค้างไม่ได้ ใช้แบบกดสลับแทน` });
    return false;
  }
  const emit = (edge) => { if (edge) send(edge === 'down' ? 'ptt:down' : 'ptt:up', { at: Date.now() }); };
  const onDown = (e) => emit(tracker.feed('down', e.keycode));
  const onUp = (e) => emit(tracker.feed('up', e.keycode));
  try {
    mod.uIOhook.on('keydown', onDown);
    mod.uIOhook.on('keyup', onUp);
    mod.uIOhook.start();
  } catch (err) {
    send('notice', { level: 'warn', text: `เริ่มตัวจับการกดค้างไม่ได้ ใช้แบบกดสลับแทน: ${err.message}` });
    return false;
  }
  pttHook = { uIOhook: mod.uIOhook, tracker, onDown, onUp };
  return true;
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  stopPttHook();
  const s = settings.get();
  const pttKey = (s.pushToTalkKey || '').trim();
  const holding = s.pushToTalkMode === 'hold' && pttKey && startPttHook(pttKey);
  // push-to-talk (unless the hold hook owns it) + the orb's "listen from anywhere" key (works even when the orb is hidden)
  const keys = [...new Set([holding ? '' : pttKey, s.orbShortcut].map((k) => (k || '').trim()).filter(Boolean))];
  for (const key of keys) {
    try {
      const ok = globalShortcut.register(key, () => send('ptt', { at: Date.now() }));
      if (!ok) send('notice', { level: 'warn', text: `ลงทะเบียนคีย์ลัด ${key} ไม่ได้ (อาจมีโปรแกรมอื่นใช้อยู่)` });
    } catch (err) {
      send('notice', { level: 'warn', text: `คีย์ลัด ${key} ไม่ถูกต้อง: ${err.message}` });
    }
  }
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  settings = new SettingsStore(userData);
  mapsKeys = { google: new MapsKey({ dataDir: userData }), ion: new MapsKey({ dataDir: userData, kind: 'ion' }), sketchfab: new MapsKey({ dataDir: userData, kind: 'sketchfab' }), gemini: new MapsKey({ dataDir: userData, kind: 'gemini' }) };
  geminiTts = new GeminiTts({
    getKey: () => mapsKeys.gemini.get(),
    getConfig: () => settings.get(),
    usage: new TtsUsage({ file: path.join(userData, 'tts-usage.json') }),
  });
  tts = new HybridTts({ edge: new EdgeTts(), fallback: new WinRtTts(), gemini: geminiTts });
  modelSource = new Sketchfab({ getToken: () => mapsKeys.sketchfab.get(), modelsDir: path.join(userData, 'models') });
  imageTo3d = new ImageTo3d({ modelsDir: path.join(userData, 'models') });
  stt = new SttService({ dataDir: path.join(userData, 'stt'), tempDir: path.join(app.getPath('temp'), 'mee-jarvis') });
  stt.configure(settings.get());
  vision = new VisionAssets({ dataDir: path.join(userData, 'vision') });
  ffmpeg = new Ffmpeg({ dataDir: path.join(userData, 'video'), getCustomPath: () => settings.get().ffmpegPath });
  videoStyles = new StyleStore({ file: path.join(userData, 'video', 'styles.json') });
  video = new VideoService({
    registry: videoMedia,
    ffmpeg,
    analyzer: new ClipAnalyzer({ ffmpeg, stt, tempDir: path.join(app.getPath('temp'), 'mee-jarvis') }),
    styles: videoStyles,
    sfxDir: path.join(userData, 'video', 'sfx'),
    sfxLibrary: new SfxLibrary({ dir: path.join(userData, 'video', 'sfx-library'), ffmpeg }),
    hf: new HfRender({ root: path.join(userData, 'video', 'projects'), gsapFile: path.join(__dirname, 'lib', 'video', 'vendor', 'gsap.min.js'), fontsDir: path.join(__dirname, 'lib', 'video', 'vendor', 'fonts') }),
    // a separate Claude run with no tools (lib/video/ask-claude.js), not the user's conversation
    ask: (o) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      delete env.ELECTRON_RUN_AS_NODE;
      const dir = path.join(userData, 'video');
      fs.mkdirSync(dir, { recursive: true });
      return askClaude({ ...o, resolveCommand: () => resolveClaudeCommand({ customPath: settings.get().claudePath }), cwd: dir, env, model: settings.get().model });
    },
    // clip projects are edited by Claude Code as background projects (lib/projects.js); the folder must not be in AppData
    workspaceRoot: path.join(app.getPath('videos'), 'JARVIS-edits'),
    startProject: (o) => projects.start(o),
    stopProject: (id) => projects.stop(id),
    emit: send,
  });
  wakeAssets = new WakeAssets({ dataDir: path.join(userData, 'handsfree') });
  const coreUi = (channel, payload) => {
    send(channel, payload);
    approvalFeed(channel, payload);
  };
  memory = new MemoryStore(userData);
  reminders = new ReminderStore({
    dir: userData,
    onDue: ({ text, late }) => {
      const say = late ? `เตือนความจำที่พลาดไป ${text}` : `เตือนความจำ ${text}`;
      coreUi('tts:announce', { text: say });
      if (Notification.isSupported()) new Notification({ title: 'JARVIS', body: text }).show();
    },
  });
  core = new JarvisCore({
    settings,
    memory,
    reminders,
    modelSource,
    imageTo3d,
    confirmUpload,
    tempDir: path.join(app.getPath('temp'), 'mee-jarvis'),
    appRoot: APP_ROOT,
    logDir: userData,
    ui: coreUi,
    onCwd: (dir) => stt.setProject(path.basename(dir)),
    prepareFolders: true,
    onRateLimit: (info) => usage && usage.onRateLimit(info),
    onTurnEnd: () => usage && setTimeout(() => usage.refresh(), 1500), // the transcript line lands just after the result
    trash: (p) => shell.trashItem(p), // undo moves files Claude created to the Recycle Bin
  });
  await core.init();
  projects = new ProjectManager({
    main: core,
    settings,
    ui: (channel, payload) => {
      coreUi(channel, payload);
      if (channel === 'project:status') video.onProjectStatus(payload);
      if (channel === 'project:status') {
        const say = awayDigest.record(payload);
        if (say && settings.get().speakProjectEvents) coreUi('tts:announce', { text: say });
      }
    },
    stateFile: path.join(userData, 'projects.json'),
    createCore: ({ id, name, ui }) => new JarvisCore({
      settings,
      memory,
      reminders,
      modelSource,
      imageTo3d,
      confirmUpload,
      tempDir: path.join(app.getPath('temp'), 'mee-jarvis'),
      appRoot: APP_ROOT,
      logDir: userData,
      id,
      name,
      primary: false,
      ui,
      onRateLimit: (info) => usage && usage.onRateLimit(info),
      onTurnEnd: () => usage && setTimeout(() => usage.refresh(), 1500),
      trash: (p) => shell.trashItem(p),
    }),
  });
  projects.restore(); // background projects of the last run come back idle; their conversations resume on the next task
  usage = new UsageService({
    dataDir: userData,
    onChange: (snap) => send('usage', snap),
    resolveCommand: () => resolveClaudeCommand({ customPath: settings.get().claudePath }),
    env: () => core.claudeEnv(),
  });
  usage.refresh();
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
    pdf: new PdfReader({ browser: web }),
    summarizer: new Summarizer({ getSettings: () => settings.get(), tempDir: path.join(app.getPath('temp'), 'mee-jarvis') }),
    send,
    log: web.o.log,
  });

  orb = new OrbWindow({
    settings,
    preload: ORB_PRELOAD,
    url: `${APP_ORIGIN}/renderer/orb/orb.html`,
    command: (action) => orbCommand(action),
    openMain: () => restoreMain(),
    quit: () => app.quit(),
    onVisibility: () => sendBg(),
    log: process.env.JARVIS_SCREENSHOT ? (m) => fs.appendFileSync(process.env.JARVIS_SCREENSHOT.replace(/\.png$/i, '') + '.console.log', m + '\n') : null,
  });
  approvalWin = new ApprovalWindow({
    preload: APPROVAL_PRELOAD,
    url: `${APP_ORIGIN}/renderer/approval/approval.html`,
    log: process.env.JARVIS_SCREENSHOT ? (m) => fs.appendFileSync(process.env.JARVIS_SCREENSHOT.replace(/\.png$/i, '') + '.console.log', m + '\n') : null,
  });
  // monitors plugged / unplugged / rescaled: keep the orb on screen
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => orb.reclamp());

  registerIpc();
  createWindow();
  registerHotkey();
  // device sleep / screen lock pause hands-free listening; resume restarts it
  for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) {
    powerMonitor.on(ev, () => {
      if (ev === 'suspend' || ev === 'lock-screen') screenWatch.stop(ev);
      send('hf:power', { kind: ev });
    });
  }
});

// the popup's close button only hides it: let a real quit through
app.on('before-quit', () => { if (approvalWin) approvalWin.quitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopPttHook();
  screenWatch.stop('quit', { silent: true });
  if (reminders) reminders.stop();
  serial.close();
  hideTray();
  if (orb) orb.destroy();
  if (projects) projects.disposeAll(); // every project's CLI tree: taskkill /T
  else if (core) core.cleanup();
  if (tts) tts.dispose();  if (stt) stt.dispose();
  if (video) video.cancel(); // ffmpeg / whisper trees are killed
});

app.on('window-all-closed', () => app.quit());
