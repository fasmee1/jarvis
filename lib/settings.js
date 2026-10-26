'use strict';
// Persistent app settings (userData/settings.json) with strict validation.
// bypassPermissions is never persisted: it always loads back as 'default'.

const fs = require('fs');
const path = require('path');
const { defaultGuardConfig } = require('./hooks/guard-rules');
const { PERMISSION_MODES } = require('./claude/args');
const { DEFAULT_VOCAB, DEFAULT_CORRECTIONS } = require('./stt/vocab');

const DEFAULT_TRIGGERS = ['ดูนี่', 'ดูให้หน่อย', 'เห็นไหม', 'อันนี้', 'ตรงนี้', 'ดูสิ', 'มองดู'];

function defaults() {
  const g = defaultGuardConfig();
  return {
    claudePath: '',
    ffmpegPath: '', // video editor: ffmpeg.exe or its folder ('' = our copy, then PATH)
    model: '',
    userProfile: '', // "about you": language, level of detail, tools you use — added to the system prompt
    permissionMode: 'default',
    persistentProcess: true,
    mcpConfigPaths: [],
    addDirs: [],
    approvalTimeoutSec: 120,
    guardEnabled: g.enabled,
    guardBlock: g.block,
    guardAsk: g.ask,
    guardBlockPaths: g.blockPaths,
    confirmVoiceBeforeSend: false,
    speakProjectEvents: true, // background tasks say aloud when they finish, fail or wait for a decision
    autoCompactAt: 80, // percent of the context window at which JARVIS compacts the conversation (0 = leave it to Claude Code, which compacts near 95%)
    autoApproveSafe: true, // safe actions (installs, builds, edits in the project) run without asking — see lib/permissions/safe.js
    maxBackgroundProjects: 3, // background tasks running at once, one per folder (lib/projects.js)
    sfx: true,
    ttsRate: 1.0,
    ttsVoice: '',
    ttsGemini: true, // Gemini voice first when an API key is saved (lib/tts/gemini.js)
    geminiModel: 'gemini-2.5-flash-preview-tts',
    geminiVoice: 'Kore',
    geminiStyle: 'Say in a warm, natural, friendly conversational Thai tone:',
    geminiDailyCap: 0, // requests per day before falling back to Edge; 0 = no cap (fall back when Gemini returns 429)
    lastCwd: '',
    // Phase 2 — speech input
    sttProvider: 'whisper',
    whisperModel: 'small',
    azureRegion: '',
    sttVocabulary: [...DEFAULT_VOCAB], // words whisper should expect (--prompt)
    sttCorrections: [...DEFAULT_CORRECTIONS], // 'heard=meant' fixes applied to every transcript
    vadSilenceMs: 800,
    pushToTalkKey: 'Control+Space',
    pushToTalkMode: 'toggle', // 'hold' = speak while the key is held (native key hook)
    micDeviceId: '',
    speakerDeviceId: '', // audio output for voice + sound effects ('' = system default)
    screenWatchIntervalSec: 5, // how often the watched screen / window is checked for changes
    screenWatchMaxMin: 10, // watching stops by itself after this many minutes
    // Phase 3 — camera
    cameraDeviceId: '',
    snapshotWidth: 640,
    snapshotHeight: 480,
    snapshotQuality: 0.8,
    visionOverlay: true,
    triggerWords: DEFAULT_TRIGGERS,
    // Hands-free (wake word) — always OFF at launch unless handsFreeAutoStart
    handsFreeConsent: false, // the user accepted the first-enable explanation
    handsFreeAutoStart: false,
    handsFreeSensitivity: 'medium',
    handsFreeEndSilence: 'normal', // how long a pause ends the command: fast 0.8 s · normal 1.2 s · patient 1.8 s
    handsFreeBargeVoice: true, // clear speech over the reply also interrupts it
    handsFreeLiveTranscript: true,
    handsFreeBackground: 'pause', // 'pause' | 'tray' (keep listening from the system tray)
    saveVoiceHistory: false, // raw audio is never kept unless this is on
    // Floating Orb (shown while the main window is minimized)
    orbEnabled: true,
    orbOnTopFullscreen: false, // 'screen-saver' layer: above the taskbar and fullscreen apps
    orbSize: 'M', // S 64 · M 88 · L 120
    orbAutoFade: false, // fade to 40% after 10 s idle
    orbShortcut: 'Control+Shift+Space', // start listening from anywhere
    orbAutoOpenResults: false, // restore the window when a reply has visual results
    orbPos: null, // { x, y, displayId } in DIP, null = bottom-right of the primary display
  };
}

const SPEC = {
  claudePath: ['string', 1024],
  ffmpegPath: ['string', 1024],
  model: ['string', 120],
  userProfile: ['string', 2000],
  permissionMode: ['enum', PERMISSION_MODES],
  persistentProcess: ['boolean'],
  mcpConfigPaths: ['strings', 20, 1024],
  addDirs: ['strings', 20, 1024],
  approvalTimeoutSec: ['int', 10, 3600],
  guardEnabled: ['boolean'],
  guardBlock: ['strings', 200, 500],
  guardAsk: ['strings', 200, 500],
  guardBlockPaths: ['strings', 100, 500],
  confirmVoiceBeforeSend: ['boolean'],
  speakProjectEvents: ['boolean'],
  autoCompactAt: ['int', 0, 95],
  autoApproveSafe: ['boolean'],
  maxBackgroundProjects: ['int', 1, 8],
  sfx: ['boolean'],
  ttsRate: ['num', 0.5, 2],
  ttsVoice: ['string', 200],
  ttsGemini: ['boolean'],
  geminiModel: ['string', 100],
  geminiVoice: ['string', 40],
  geminiStyle: ['string', 300],
  geminiDailyCap: ['int', 0, 100000],
  lastCwd: ['string', 1024],
  sttProvider: ['enum', ['whisper', 'typhoon', 'azure', 'webspeech']],
  whisperModel: ['enum', ['base', 'small', 'medium', 'large-v3-turbo', 'thonburian-medium']],
  azureRegion: ['string', 40],
  sttVocabulary: ['strings', 100, 60],
  sttCorrections: ['strings', 200, 120],
  vadSilenceMs: ['int', 300, 5000],
  pushToTalkKey: ['string', 60],
  pushToTalkMode: ['enum', ['toggle', 'hold']],
  screenWatchIntervalSec: ['int', 2, 60],
  screenWatchMaxMin: ['int', 1, 60],
  micDeviceId: ['string', 300],
  speakerDeviceId: ['string', 300],
  cameraDeviceId: ['string', 300],
  snapshotWidth: ['int', 160, 1920],
  snapshotHeight: ['int', 120, 1080],
  snapshotQuality: ['num', 0.3, 1],
  visionOverlay: ['boolean'],
  triggerWords: ['strings', 50, 40],
  handsFreeConsent: ['boolean'],
  handsFreeAutoStart: ['boolean'],
  handsFreeSensitivity: ['enum', ['low', 'medium', 'high']],
  handsFreeEndSilence: ['enum', ['fast', 'normal', 'patient']],
  handsFreeBargeVoice: ['boolean'],
  handsFreeLiveTranscript: ['boolean'],
  handsFreeBackground: ['enum', ['pause', 'tray']],
  saveVoiceHistory: ['boolean'],
  orbEnabled: ['boolean'],
  orbOnTopFullscreen: ['boolean'],
  orbSize: ['enum', ['S', 'M', 'L']],
  orbAutoFade: ['boolean'],
  orbShortcut: ['string', 60],
  orbAutoOpenResults: ['boolean'],
  orbPos: ['pos'],
};

function check(key, v) {
  const s = SPEC[key];
  if (!s) return false;
  switch (s[0]) {
    case 'string': return typeof v === 'string' && v.length <= s[1];
    case 'boolean': return typeof v === 'boolean';
    case 'enum': return s[1].includes(v);
    case 'int': return Number.isInteger(v) && v >= s[1] && v <= s[2];
    case 'num': return typeof v === 'number' && Number.isFinite(v) && v >= s[1] && v <= s[2];
    case 'pos': return v === null || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 3 && ['x', 'y'].every((k) => Number.isInteger(v[k]) && Math.abs(v[k]) <= 100000) && Number.isSafeInteger(v.displayId));
    case 'strings': return Array.isArray(v) && v.length <= s[1] && v.every((x) => typeof x === 'string' && x.length <= s[2]);
    default: return false;
  }
}

/** Validate a partial update; returns {ok, value?, errors[]} */
function sanitize(partial) {
  const errors = [];
  const value = {};
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return { ok: false, errors: ['ต้องเป็น object'] };
  for (const [k, v] of Object.entries(partial)) {
    if (!(k in SPEC)) errors.push(`ไม่รู้จัก ${k}`);
    else if (!check(k, v)) errors.push(`ค่า ${k} ไม่ถูกต้อง`);
    else value[k] = v;
  }
  return { ok: errors.length === 0, value, errors };
}

class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = defaults();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const { value } = sanitize(Object.fromEntries(Object.entries(saved).filter(([k]) => k in SPEC)));
      Object.assign(this.data, value);
    } catch { /* first run */ }
    if (this.data.permissionMode === 'bypassPermissions') this.data.permissionMode = 'default';
  }

  get() {
    return { ...this.data };
  }

  update(partial) {
    const r = sanitize(partial);
    if (!r.ok) return r;
    if (r.value.permissionMode === 'bypassPermissions') {
      return { ok: false, errors: ['เปิด bypassPermissions ได้จากหน้า Settings พร้อมพิมพ์ยืนยันเท่านั้น'] };
    }
    Object.assign(this.data, r.value);
    this.save();
    return { ok: true, value: this.get(), errors: [] };
  }

  // Only path that may set bypass: requires the exact confirmation word.
  setPermissionMode(mode, confirmText) {
    if (!PERMISSION_MODES.includes(mode)) return { ok: false, errors: ['โหมดไม่ถูกต้อง'] };
    if (mode === 'bypassPermissions' && confirmText !== 'ยืนยัน') {
      return { ok: false, errors: ['ต้องพิมพ์คำว่า "ยืนยัน" ก่อนเปิด bypassPermissions'] };
    }
    this.data.permissionMode = mode;
    this.save();
    return { ok: true, value: this.get(), errors: [] };
  }

  save() {
    const persisted = { ...this.data };
    if (persisted.permissionMode === 'bypassPermissions') persisted.permissionMode = 'default';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(persisted, null, 2), 'utf8');
  }

  guardConfig() {
    return {
      enabled: this.data.guardEnabled,
      block: this.data.guardBlock,
      ask: this.data.guardAsk,
      blockPaths: this.data.guardBlockPaths,
    };
  }
}

module.exports = { SettingsStore, sanitize, defaults, DEFAULT_TRIGGERS };
