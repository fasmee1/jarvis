// Mee JARVIS renderer controller. Talks to main only through window.jarvis
// (a fixed allow-list of IPC channels). It never runs commands itself.

import { Home } from './ui/home.js';
import { Sections } from './ui/sections.js';
import { runBoot, bootPrefs } from './ui/boot.js';
import { CameraPanel } from './ui/camera-panel.js';
import { Speaker } from './tts.js';
import { sfx, setSfxEnabled, greetingLine } from './sfx.js';
import { el, blockCard, renderForTab, TAB_FOR_KIND } from './blocks.js';
import { Mic, webSpeechOnce } from './audio/mic.js';
import { Vision, listDevices } from './vision.js';
import { HandsFree, ST as HF } from './handsfree/controller.js';
import { OwwEngine } from './handsfree/engine.js';
import { parseCommand, wantsScreenLook, screenTarget } from './handsfree/commands.js';
import { StageViewer } from './ui/stage-viewer.js';
import { ResultViewer } from './ui/result-viewer.js';
import { WebViewer } from './ui/web-viewer.js';
import { ConversationPopup } from './ui/conversation.js';
import { linkParts } from './ui/result-utils.js';
import { SlashMenu } from './ui/slash-menu.js';
import { HistoryPanel } from './ui/history.js';
import { UsagePanel } from './ui/usage.js';
import { OrbBridge } from './orb-bridge.js';
import { checkReport, diffReport, undoLines } from './ui/code-report.js';
import { ProjectsPanel } from './ui/projects.js';
import { TaskStatus } from './ui/task-status.js';
import { toolPhase } from './ui/task-phase.js';

const api = window.jarvis;
const $ = (id) => document.getElementById(id);

const S = {
  settings: null,
  app: null, // snapshot from main
  coreState: 'STANDBY',
  listening: false,
  transcribing: false,
  speaking: false,
  busy: false,
  toolRunning: false,
  toolName: '', // tool Claude is using right now (task status pill)
  toolInput: null, // its input, for the file name on the pill
  stepInfo: null, // { current, total } of the latest jarvis-steps block
  lookArmed: false,
  lat: {},
  turnSpoke: false,
  approvals: [],
  muteThisTurn: false,
  ttsWarned: false,
  frameAtListenEnd: null,
  // HUD data (real values only)
  replyText: '',
  segTotal: 0,
  segSpoken: 0,
  latHist: [],
  sessionTokens: 0,
  dotErr: false,
  dotAtt: false,
  hfRec: false, // hands-free is recording a command (the MIC card shows dB only then)
  hfLat: null,
  webThinking: false, // the Web Viewer is reading / summarizing a page
  voiceAsk: null, // { cb, timer }: the next transcript answers "ถามหน้านี้" instead of going to Claude
  // Floating Orb
  micOff: false, // "ปิดไมค์" from the orb menu: no push-to-talk, hands-free paused
  voiceMuted: false, // "ปิดเสียง" from the orb menu: replies are shown, not spoken
  micLevel: 0, // last mic RMS (push-to-talk or hands-free)
};
let hands = null; // hands-free controller (set up below)
// the orb only mirrors state; levels: mic while listening, the voice while speaking
const orbBridge = new OrbBridge(api, { level: () => (S.speaking ? speaker.level() : Math.min(1, S.micLevel * 8)) });
let resultViewer = null; // Result Viewer (set up below)
let webViewer = null; // Web Viewer (set up below)
let talk = null; // Conversation popup (set up below)

const sections = new Sections({
  onTalk: () => talk.open(),
  onProjects: () => projectsPanel.open(),
  onChange: (name) => {
    home.setVisible(!name);
    if (name) { S.dotErr = false; S.dotAtt = false; updateDot(); }
  },
  beforeShow: (name) => {
    if (name === 'diagnostics') usagePanel.load();
    if (name === 'settings') {
      fillSettings();
      fillDevices();
      refreshInstallStatus();
    }
  },
});
const taskStatus = new TaskStatus();
const TASK_PHASE = { THINKING: 'กำลังคิด', STREAMING: 'กำลังตอบ', TOOL_RUNNING: 'กำลังทำงาน', AWAITING_APPROVAL: 'รอคุณกดอนุญาต' };
/** Task status pill: the latest command, what JARVIS is doing now, elapsed time. */
function updateTaskStatus() {
  const phase = TASK_PHASE[S.coreState] || '';
  taskStatus.update({
    running: !!phase,
    command: S.lastUserText || '',
    phase: S.coreState === 'TOOL_RUNNING' && S.toolName ? toolPhase(S.toolName, S.toolInput) : phase,
    attention: S.coreState === 'AWAITING_APPROVAL',
    step: S.stepInfo,
  });
}
const home = new Home({
  onOpen: (name) => sections.show(name),
  onCoreClick: () => voiceButton(),
});

function updateDot() {
  const dot = $('hb-dot');
  const err = S.dotErr || S.coreState === 'ERROR';
  const att = S.approvals.length > 0 || S.dotAtt;
  dot.hidden = !err && !att;
  dot.classList.toggle('err', err);
}

// ---------------- helpers ----------------

function notice(text, level = 'info', action = null, ms = 9000) {
  const n = el('div', { class: `notice ${level}` }, el('div', { text }));
  if (action) {
    const row = el('div', { class: 'row' });
    const label = { 'open-interactive': 'เปิด Claude Code แบบ interactive', 'new-from-summary': 'เริ่ม session ใหม่จากสรุป', 'install-thai-voice': 'ติดตั้งเสียงภาษาไทย', 'open-settings-voice': 'เปิด Settings เสียง', 'init-claude-md': 'สร้าง CLAUDE.md (/init)', 'choose-folder': 'เลือกโฟลเดอร์โปรเจกต์', 'open-settings-3d': 'เปิด Settings ใส่ token' }[action] || action;
    row.append(el('button', { class: 'btn small', text: label, onclick: () => { runAction(action); n.remove(); } }));
    n.append(row);
  }
  n.append(el('button', { class: 'btn small ghost', text: 'ปิด', onclick: () => n.remove() }));
  $('notices').append(n);
  if (ms) setTimeout(() => n.remove(), ms);
  if (level === 'error') sfx.error(); // low double buzz
  if (level === 'error') S.dotErr = true;
  if (level === 'warn') S.dotAtt = true;
  if (level === 'error') orbBridge.set({ error: String(text).slice(0, 300), errorId: Date.now() });
  updateDot();
}

function runAction(a) {
  if (a === 'open-interactive') openInteractive();
  if (a === 'new-from-summary') newFromSummary();
  if (a === 'install-thai-voice') installThaiVoice();
  if (a === 'open-settings-voice') openSettings('voice');
  if (a === 'open-settings-3d') openSettings('display');
  if (a === 'init-claude-md') send('/init');
  if (a === 'choose-folder') $('btn-folder').click();
}

// ---------------- local coding commands (voice) ----------------
// "รันเทสต์" / "รันเช็ก" / "ดู diff ล่าสุด" / "ยกเลิกการแก้ล่าสุด": handled in the app, no Claude turn.

function say(text) {
  if (!text || S.voiceMuted) return;
  speaker.enqueue(text);
  speaker.flush();
}

const failed = (err) => ({ ok: false, error: err.message });

async function codeCommand(cmd, heard) {
  if (heard) addSystemMsg(`🎙 ${heard}`);
  if (cmd.op === 'test' || cmd.op === 'check') return runProjectCheck(cmd.op);
  if (cmd.op === 'diff') return showProjectDiff();
  if (cmd.op === 'undo') return askUndo();
  return null;
}

async function serialCommand(cmd, heard) {
  if (heard) addSystemMsg(`🎙 ${heard}`);
  if (cmd.op === 'chart') {
    const r = await api.invoke('serial:chart').catch(failed);
    if (r.error) return say(r.error);
    resultViewer.display(r);
    return say(r.spokenSummary);
  }
  if (cmd.op === 'close') {
    await api.invoke('serial:close').catch(failed);
    return say('ปิดซีเรียลแล้ว');
  }
  const ports = await api.invoke('serial:ports').catch(() => []);
  const port = cmd.port || (ports.length === 1 ? ports[0] : null);
  if (!port) return say(ports.length ? `มีพอร์ต ${ports.join(' ')} ต้องการพอร์ตไหน` : 'ไม่พบพอร์ตซีเรียลที่เสียบอยู่');
  const r = await api.invoke('serial:open', { port, baud: cmd.baud || 9600 }).catch(failed);
  say(r.ok === false ? r.error : `เปิด ${port} แล้ว พูดว่า ดูกราฟบอร์ด เพื่อดูค่า`);
}

async function runProjectCheck(kind) {
  const label = kind === 'test' ? 'เทสต์' : 'เช็ก';
  const found = S.app && S.app.checks && S.app.checks[kind];
  addSystemMsg(`▶ กำลังรัน${label}${found ? `: ${found.command}` : ''}…`);
  const r = await api.invoke('code:run', { kind }).catch(failed);
  if (!r.done) {
    notice(r.error || `รัน${label}ไม่ได้`, 'warn');
    say(r.error);
    return;
  }
  const rep = checkReport(r);
  addSystemMsg(rep.line);
  if (!r.cancelled) resultViewer.display({ type: 'text', title: rep.title, spokenSummary: rep.speak, markdown: rep.markdown });
  if (!r.ok && !r.cancelled) sfx.error();
  say(rep.speak);
}

async function showProjectDiff() {
  const d = await api.invoke('code:diff').catch(failed);
  if (!d.ok) {
    notice(d.error, 'warn');
    say(d.error);
    return;
  }
  const rep = diffReport(d);
  if (!rep.empty) resultViewer.display({ type: 'text', title: rep.title, spokenSummary: rep.speak, markdown: rep.markdown });
  else addSystemMsg(rep.speak);
  say(rep.speak);
}

/** Undo is destructive: the file list is shown and only a click confirms it. */
async function askUndo() {
  const p = await api.invoke('code:undo-preview').catch(failed);
  if (!p.ok) {
    const why = p.reason || p.error;
    notice(why, 'info');
    say(why);
    return;
  }
  document.querySelector('.notice.undo-confirm')?.remove();
  const n = el('div', { class: 'notice warn undo-confirm', role: 'alertdialog', 'aria-label': 'ยืนยันการย้อนการแก้' });
  n.append(el('div', {}, el('b', { text: 'ย้อนการแก้ของงานล่าสุด?' })));
  for (const line of undoLines(p)) n.append(el('div', { class: 'mono', text: line }));
  const cancel = el('button', { class: 'btn small ghost', text: 'ยกเลิก', onclick: () => n.remove() });
  const ok = el('button', {
    class: 'btn small danger',
    text: 'ย้อนกลับ',
    onclick: async () => {
      ok.disabled = cancel.disabled = true;
      const r = await api.invoke('code:undo', { token: p.token }).catch(failed);
      n.remove();
      if (!r.ok) {
        notice(r.reason || r.error, 'error');
        return;
      }
      const msg = `↩ ย้อนแล้ว: คืนค่า ${r.restored.length} ไฟล์ · ย้ายไปถังขยะ ${r.removed.length} ไฟล์`;
      addSystemMsg(r.safety ? `${msg} — ถ้าต้องการกลับไปแบบก่อนย้อน: git restore --source=${r.safety} -- .` : msg);
      if (r.failed.length) notice(`ลบบางไฟล์ไม่ได้: ${r.failed.join(' · ')}`, 'warn');
      say('ย้อนการแก้เรียบร้อยครับ');
    },
  });
  n.append(el('div', { class: 'row' }, ok, cancel));
  $('notices').append(n);
  cancel.focus();
  const count = p.restore.length + p.remove.length;
  say(`จะย้อน ${count} ไฟล์ กดยืนยันบนจอครับ`);
}

/** Once per project: offer /init when a code project has no CLAUDE.md. */
function hintClaudeMd(snap) {
  if (!snap.cwd || snap.cwd === S.claudeMdChecked) return;
  S.claudeMdChecked = snap.cwd;
  if (!snap.isCodeProject || snap.hasClaudeMd) return;
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem('jarvis.claudeMdHinted') || '[]'); } catch { /* storage unavailable */ }
  if (seen.includes(snap.cwd)) return;
  try { localStorage.setItem('jarvis.claudeMdHinted', JSON.stringify([...seen, snap.cwd].slice(-200))); } catch { /* storage unavailable */ }
  notice('โปรเจกต์นี้ยังไม่มี CLAUDE.md — ไฟล์นี้บอก Claude ว่าโปรเจกต์ทำอะไร รัน build/test อย่างไร จะได้ไม่ต้องอธิบายซ้ำทุกครั้ง', 'info', 'init-claude-md', 30000);
}

function term(text, stream = 'event') {
  const pre = $('terminal');
  const line = el('div', { class: `t-${stream}`, text: `[${new Date().toLocaleTimeString()}] ${text}` });
  pre.append(line);
  while (pre.childElementCount > 1500) pre.firstChild.remove();
  if (!pre.hidden) pre.scrollTop = pre.scrollHeight;
  // the same log in the conversation popup's Terminal panel
  const cvLog = $('cv-term-log');
  const stick = cvLog.scrollHeight - cvLog.scrollTop - cvLog.clientHeight < 24;
  cvLog.append(line.cloneNode(true));
  while (cvLog.childElementCount > 1500) cvLog.firstChild.remove();
  if (stick) cvLog.scrollTop = cvLog.scrollHeight;
  if ((stream === 'bad' || stream === 'error' || stream === 'block') && pre.hidden) {
    const b = $('terminal-badge');
    b.hidden = false;
    b.textContent = String((Number(b.textContent) || 0) + 1);
  }
}

function displayState() {
  if (S.listening) return 'LISTENING';
  if (S.transcribing) return 'TRANSCRIBING';
  if (S.coreState === 'AWAITING_APPROVAL' || S.coreState === 'ERROR') return S.coreState;
  if (S.coreState === 'TOOL_RUNNING') return 'TOOL_RUNNING';
  if (S.speaking) return 'SPEAKING';
  if (S.webThinking && S.coreState === 'STANDBY') return 'THINKING';
  return S.coreState;
}

const STATE_TH = {
  STANDBY: 'พร้อมรับคำสั่ง',
  LISTENING: 'กำลังฟัง…',
  TRANSCRIBING: 'กำลังถอดเสียง…',
  THINKING: 'กำลังคิด…',
  STREAMING: 'กำลังตอบ…',
  SPEAKING: 'กำลังพูด…',
  TOOL_RUNNING: 'Claude กำลังใช้เครื่องมือ',
  AWAITING_APPROVAL: 'รอคุณกดอนุญาตบนจอ',
  ERROR: 'เกิดข้อผิดพลาด',
};

// Hands-free: reactor state + status text per conversation state
const HF_VIEW = {
  WAKE_LISTENING: { core: 'WAKE_LISTENING', label: 'SAY ‘JARVIS’', tone: 'tert' },
  WAKE_DETECTED: { core: 'WAKE_DETECTED', label: '' },
  COMMAND_LISTENING: { core: 'LISTENING', label: 'LISTENING' },
  PROCESSING: { core: 'THINKING', label: 'THINKING' },
  SPEAKING: { core: 'SPEAKING', label: 'SPEAKING' },
  FOLLOW_UP: { core: 'FOLLOW_UP', label: 'LISTENING' },
  PAUSED: { core: 'STANDBY', label: 'HANDS-FREE PAUSED', tone: 'tert' },
};

function refreshState(sub) {
  const st = displayState();
  const v = hands && hands.active && !['AWAITING_APPROVAL', 'ERROR'].includes(S.coreState) ? HF_VIEW[hands.state] : null;
  if (v) home.setState(v.core, '', { label: v.label, tone: v.tone });
  else home.setState(st, sub || STATE_TH[st] || '');
  updateDot();
  updateTaskStatus();
  if (hands) hands.assistant({ speaking: S.speaking, busy: S.busy });
  if (resultViewer) resultViewer.setAttention(S.speaking || S.listening || (!!hands && ['WAKE_DETECTED', 'COMMAND_LISTENING'].includes(hands.state)));
  orbBridge.set({
    state: orbState(),
    hf: !!(hands && hands.active),
    micOff: S.micOff,
    voiceMuted: S.voiceMuted,
    attention: S.coreState === 'AWAITING_APPROVAL' ? 'รอคุณกดอนุญาตในหน้าต่าง JARVIS' : '',
  });
}

/** Floating Orb state: idle · listening · thinking · speaking · muted · error */
function orbState() {
  if (S.coreState === 'ERROR') return 'error';
  if (S.micOff) return 'muted';
  const hs = hands && hands.active ? hands.state : null;
  if (S.listening || hs === HF.WAKE_DETECTED || hs === HF.COMMAND_LISTENING || hs === HF.FOLLOW_UP) return 'listening';
  if (S.speaking) return 'speaking';
  if (S.transcribing || S.busy || S.webThinking || hs === HF.PROCESSING) return 'thinking';
  return 'idle';
}

function fmtMs(ms) {
  return ms == null || Number.isNaN(ms) ? '—' : `${(ms / 1000).toFixed(2)}s`;
}

function showLatency() {
  const L = S.lat;
  if (!L.t0) return;
  const wait = L.awaitingMs || 0;
  const a = L.t2 ? L.t2 - L.t0 - wait : null;
  const b = L.t3 ? L.t3 - L.t0 - wait : null;
  const parts = [`t2−t0: ${fmtMs(a)}`, `t3−t0: ${fmtMs(b)}`];
  if (L.t_listen_end && L.t_transcribed) parts.unshift(`STT: ${fmtMs(L.t_transcribed - L.t_listen_end)}`);
  $('lat').textContent = parts.join(' · ');
  $('lat').title = `t1−t0 (เขียน stdin): ${fmtMs(L.t1 && L.t1 - L.t0)} · รออนุญาต: ${fmtMs(wait)}`;
}

function slowestStage() {
  const L = S.lat;
  const wait = L.awaitingMs || 0;
  const stages = [];
  if (L.t_listen_end && L.t_transcribed) stages.push(['ถอดเสียง (STT)', L.t_transcribed - L.t_listen_end]);
  if (L.t1) stages.push(['ส่งเข้า CLI', L.t1 - L.t0]);
  if (L.t2 && L.t1) stages.push(['รอ token แรกจาก Claude', L.t2 - L.t1 - wait]);
  if (L.t3 && L.t2) stages.push(['เริ่มพูดประโยคแรก', L.t3 - L.t2]);
  stages.sort((x, y) => y[1] - x[1]);
  return stages[0];
}

// Latency history for the HUD: time to first speech (t3−t0); if nothing was
// spoken, time to first text (t2−t0) is shown as a dimmer bar. Approval waits excluded.
function recordLatency(L) {
  if (!L.t0) return;
  const wait = L.awaitingMs || 0;
  let entry = null;
  if (L.t3) entry = { ms: L.t3 - L.t0 - wait, kind: 'speech' };
  else if (L.t2) entry = { ms: L.t2 - L.t0 - wait, kind: 'text' };
  if (!entry || entry.ms < 0) return;
  S.latHist.push(entry);
  if (S.latHist.length > 50) S.latHist.shift();
  home.latency(S.latHist);
  $('diag-history').textContent = S.latHist.slice(-8).map((x, i) => `#${String(i + 1).padStart(2, '0')}  ${(x.ms / 1000).toFixed(2)} s  ${x.kind === 'speech' ? 'เสียงแรก (t3−t0)' : 'ข้อความแรก (t2−t0)'}`).join('\n');
}

// ---------------- chat ----------------

let curMsg = null; // current assistant bubble
let curText = null;

function addUserMsg(text, image, source = 'camera') {
  const m = el('div', { class: 'msg user' });
  if (image) {
    m.append(el('div', { class: 'cam-badge', text: source === 'screen' ? '🖥 แนบภาพหน้าจอ' : '📷 แนบภาพจากกล้อง' }));
    const img = el('img', { class: 'thumb', src: image, alt: 'ภาพที่ส่ง' });
    m.append(img);
    m.append(el('button', { class: 'btn small', text: '💾 บันทึกขั้นตอนนี้', onclick: async (e) => {
      const r = await api.invoke('snapshot:save', { dataUrl: image }).catch((err) => ({ ok: false, error: err.message }));
      if (r.ok) { notice('บันทึกภาพแล้ว: ' + r.file); e.target.disabled = true; } else notice(r.error || 'บันทึกไม่ได้', 'error');
    } }));
  }
  m.append(linkedText(el('div'), text));
  $('chat').append(m);
  scrollChat();
}

/** Fill node with text, URLs as <a class="cv-link"> (opened externally by the click handler below). */
function linkedText(node, text) {
  node.replaceChildren(...linkParts(text).map((p) => (p.url
    ? el('a', { class: 'cv-link', href: p.url, title: p.url, text: p.text })
    : document.createTextNode(p.text))));
  return node;
}

// Links in chat and history open in the default browser; the app window itself never navigates.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.cv-link');
  if (!a) return;
  e.preventDefault();
  api.invoke('web:open-external', a.href).then((r) => {
    if (r && !r.ok) notice(r.error || 'เปิดลิงก์ไม่ได้', 'error');
  }).catch(() => notice('เปิดลิงก์ไม่ได้', 'error'));
});

function addSystemMsg(text) {
  $('chat').append(el('div', { class: 'msg system', text }));
  scrollChat();
}

function scrollChat() {
  const c = $('chat');
  c.scrollTop = c.scrollHeight;
}

function ensureAssistant() {
  if (!curMsg) {
    curMsg = el('div', { class: 'msg assistant' });
    $('chat').append(curMsg);
    curText = null;
  }
  return curMsg;
}

function appendText(t) {
  const m = ensureAssistant();
  if (!curText) {
    curText = el('span');
    curText._raw = '';
    m.append(curText);
  }
  curText._raw += t;
  linkedText(curText, curText._raw);
  scrollChat();
}

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    // fallback for when the async clipboard is unavailable
    const ta = el('textarea', { class: 'cv-copy-tmp' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (btn) {
    btn.textContent = ok ? 'คัดลอกแล้ว' : 'คัดลอกไม่ได้';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = 'คัดลอก'; }, 1500);
  }
}

/** A code block with a copy button. */
function codeBlock(code) {
  const wrap = el('div', { class: 'cv-code' });
  const btn = el('button', { class: 'cv-copy', type: 'button', text: 'คัดลอก', title: 'คัดลอกโค้ด', onclick: () => copyText(code, btn) });
  wrap.append(btn, el('pre', { class: 'code mono', text: code }));
  return wrap;
}

/** "result arrived while the conversation is open": a card in the chat that opens the viewer. */
function addResultLink(title, open) {
  const m = ensureAssistant();
  const card = el('div', { class: 'cv-result' },
    el('span', { class: 'cv-result-t', text: title }),
    el('button', { class: 'cv-result-open', type: 'button', text: 'เปิดดู', onclick: () => open() }));
  m.append(card);
  curText = null;
  scrollChat();
}

// tool calls inside the conversation (collapsible, dim)
const toolRows = new Map();

function addToolRow(a) {
  if (a.name === 'TodoWrite') return;
  const m = ensureAssistant();
  curText = null;
  const status = el('span', { class: 'cv-tool-st', text: '● กำลังทำงาน' });
  const d = el('details', { class: `cv-tool running${a.parent ? ' sub' : ''}` },
    el('summary', {}, el('span', { class: 'cv-tool-n', text: a.name }), el('span', { class: 'cv-tool-s', text: a.summary || '' }), status));
  if (a.preview && a.preview.diff) d.append(diffDetails(a.preview));
  else d.append(el('pre', { class: 'cv-tool-io mono', text: JSON.stringify(a.input, null, 2) }));
  m.append(d);
  toolRows.set(a.id, { d, status });
  if (toolRows.size > 400) toolRows.delete(toolRows.keys().next().value);
  scrollChat();
}

function finishToolRow(a) {
  const r = toolRows.get(a.id);
  if (!r) return;
  toolRows.delete(a.id);
  r.d.classList.remove('running');
  r.d.classList.add(a.isError ? 'err' : 'ok');
  r.status.textContent = a.isError ? (a.decision === 'reject' || /denied|ปฏิเสธ/i.test(a.text) ? '✕ ถูกปฏิเสธ' : '✕ ผิดพลาด') : '✓ เสร็จ';
  if (a.text) r.d.append(el('div', { class: 'cv-tool-lbl', text: 'ผลลัพธ์' }), el('pre', { class: 'cv-tool-io mono', text: a.text.slice(0, 3000) }));
}

function onChatItem(item) {
  const m = ensureAssistant();
  if (item.type === 'text') {
    S.replyText += item.text;
    orbBridge.set({ reply: S.replyText.slice(0, 800) });
    home.delta();
    home.reply(S.replyText, { spoken: S.segSpoken, total: S.segTotal });
    return appendText(item.text);
  }
  curText = null;
  if (item.type === 'code') {
    m.append(codeBlock(item.code));
  } else if (item.type === 'block') {
    m.append(blockCard(item));
    if (item.kind === 'result') { resultViewer.show(item.data); orbBridge.set({ result: true }); }
    if (item.kind === 'steps') {
      const st = item.data.steps;
      const firstOpen = st.findIndex((x) => !x.done);
      const cur = Math.min(st.length, item.data.current || (firstOpen >= 0 ? firstOpen + 1 : st.length));
      home.step({ current: cur, total: st.length, title: st[cur - 1].title });
      S.stepInfo = { current: cur, total: st.length };
      updateTaskStatus();
    }
    const tab = TAB_FOR_KIND[item.kind];
    const node = renderForTab(item);
    if (tab && node) {
      const body = $(`tab-${tab}`);
      if (tab === 'code') {
        body.querySelector('.placeholder')?.remove();
        body.prepend(node);
      } else {
        body.replaceChildren(node);
      }
      selectTab(tab);
    }
  } else if (item.type === 'block-error') {
    m.append(el('div', { class: 'block-card', text: `⚠ บล็อก jarvis-${item.kind} ผิดรูปแบบ (ดู Terminal)` }));
  }
  scrollChat();
}

function selectTab(name) {
  for (const b of $('display-tabs').querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of ['steps', 'diagram', 'bom', 'code', 'model3d']) $(`tab-${t}`).hidden = t !== name;
}

// ---------------- activity ----------------

const acts = new Map();

function onActivity(a) {
  if (a.kind === 'tool-use' && a.name === 'WebSearch' && !a.parent) resultViewer.searchStarted(a.input && a.input.query);
  if (a.kind === 'tool-use') addToolRow(a);
  else if (a.kind === 'tool-result') finishToolRow(a);
  if (a.kind === 'tool-use') {
    const card = el('div', { class: `act running${a.parent ? ' sub' : ''}` });
    const head = el('div', { class: 'act-head' }, el('span', { class: 'act-name', text: a.name }), el('span', { class: 'act-status', text: '● กำลังทำงาน' }));
    card.append(head, el('div', { class: 'act-body', text: a.summary }));
    if (a.preview && a.preview.diff) card.append(diffDetails(a.preview));
    else if (a.name !== 'TodoWrite') {
      const d = el('details', {}, el('summary', { text: 'input' }), el('pre', { class: 'mono', text: JSON.stringify(a.input, null, 2) }));
      card.append(d);
    }
    acts.set(a.id, card);
    $('activity').prepend(card);
    $('activity-count').textContent = `(${acts.size})`;
    S.toolRunning = true;
    if (!a.parent && S.coreState === 'TOOL_RUNNING') {
      S.toolInput = a.input;
      updateTaskStatus();
    }
  } else if (a.kind === 'tool-result') {
    const card = acts.get(a.id);
    if (!card) return;
    card.classList.remove('running');
    card.classList.add(a.isError ? 'err' : 'ok');
    const status = card.querySelector('.act-status');
    status.textContent = a.isError ? (a.decision === 'reject' || /denied|ปฏิเสธ/i.test(a.text) ? '✕ ถูกปฏิเสธ' : '✕ ผิดพลาด') : '✓ เสร็จ';
    if (a.text) card.append(el('details', {}, el('summary', { text: 'ผลลัพธ์' }), el('pre', { class: 'mono', text: a.text.slice(0, 3000) })));
  }
}

function diffDetails(preview) {
  const box = el('div', { class: 'diff mono' });
  for (const d of preview.diff.slice(0, 400)) {
    const cls = d.op === '+' ? 'add' : d.op === '-' ? 'del' : d.op === '@' || d.op === '!' ? 'hdr' : '';
    box.append(el('div', { class: cls, text: `${d.op === '@' || d.op === '!' ? '' : d.op} ${d.line}` }));
  }
  return el('details', { open: '' }, el('summary', { text: `diff ${preview.file || ''}${preview.isNew ? ' (ไฟล์ใหม่)' : ''}` }), box);
}

function onTodos({ todos }) {
  const box = $('todos');
  box.hidden = !todos.length;
  box.replaceChildren(el('div', { class: 'accent', text: 'รายการงานของ Claude' }));
  for (const t of todos) {
    const mark = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐';
    box.append(el('div', { class: `todo ${t.status}` }, el('span', { text: mark }), el('span', { text: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content })));
  }
}

// ---------------- approvals (click only) ----------------

// each request also leaves an amber line in the conversation (the click-only dialog stays the place to answer)
const approvalRows = new Map();

function onApprovalRequest(req) {
  // a background project's request: answered in the same dialog, but kept out of this chat
  if (req.projectId && req.projectId !== 'main') {
    S.approvals.push(req);
    updateDot();
    sfx.approval();
    if (S.approvals.length === 1) showApproval();
    else $('ap-queue').textContent = `มีคำขอรออีก ${S.approvals.length - 1} รายการ`;
    return;
  }
  const row = el('div', { class: 'cv-perm', role: 'status' },
    el('span', { class: 'cv-perm-k', text: 'ขออนุญาต' }),
    el('span', { class: 'mono cv-perm-t', text: req.tool }),
    el('span', { class: 'cv-perm-s', text: req.summary || '' }),
    el('span', { class: 'cv-perm-st', text: 'รอคุณกดอนุญาตบนจอ' }));
  ensureAssistant().append(row);
  curText = null;
  approvalRows.set(req.id, row);
  scrollChat();
  S.approvals.push(req);
  updateDot();
  sfx.approval();
  if (S.approvals.length === 1) showApproval();
  else $('ap-queue').textContent = `มีคำขอรออีก ${S.approvals.length - 1} รายการ`;
}

let apTimer = null;
function showApproval() {
  const req = S.approvals[0];
  const box = $('approval');
  if (!req) {
    box.hidden = true;
    clearInterval(apTimer);
    return;
  }
  box.hidden = false;
  $('ap-tool').textContent = req.tool;
  $('ap-summary').textContent = req.summary;
  $('ap-reason').hidden = !req.reason;
  $('ap-reason').textContent = req.reason ? `ตัวกันพลาด: ${req.reason}` : '';
  const i = req.input || {};
  const detail = i.command ?? i.url ?? i.file_path ?? i.notebook_path ?? JSON.stringify(i, null, 2);
  $('ap-detail').textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
  const diff = $('ap-diff');
  if (req.preview && req.preview.diff) {
    diff.hidden = false;
    diff.replaceChildren(diffDetails(req.preview));
  } else diff.hidden = true;
  $('ap-always').hidden = !req.rule;
  $('ap-rule').textContent = req.rule ? `"อนุญาตเสมอ" จะเพิ่ม rule: ${req.rule} ลง .claude/settings.local.json` : '';
  $('ap-queue').textContent = S.approvals.length > 1 ? `มีคำขอรออีก ${S.approvals.length - 1} รายการ` : '';
  $('ap-deny-reason-wrap').hidden = true;
  $('ap-deny-reason').value = '';
  clearInterval(apTimer);
  const end = req.createdAt + req.timeoutSec * 1000;
  const tick = () => { $('ap-timer').textContent = `ปฏิเสธอัตโนมัติใน ${Math.max(0, Math.ceil((end - Date.now()) / 1000))} วิ`; };
  tick();
  apTimer = setInterval(tick, 500);
}

async function answerApproval(decision, ev) {
  // Only genuine user clicks count — never synthetic events from voice/gesture code.
  if (!ev || !ev.isTrusted) return;
  const req = S.approvals[0];
  if (!req) return;
  const reason = decision === 'deny-reason' ? $('ap-deny-reason').value.trim() : '';
  await api.invoke('approval:respond', { id: req.id, projectId: req.projectId || 'main', decision, reason });
}

function onApprovalClose({ id }) {
  const row = approvalRows.get(id);
  if (row) {
    approvalRows.delete(id);
    row.classList.add('done');
    row.querySelector('.cv-perm-st').textContent = 'ตอบแล้ว';
  }
  const idx = S.approvals.findIndex((r) => r.id === id);
  if (idx >= 0) S.approvals.splice(idx, 1);
  updateDot();
  if (idx === 0 || !S.approvals.length) showApproval();
}

// ---------------- TTS ----------------

const speaker = new Speaker({
  // share the sound engine's AudioContext (one context for the whole app)
  getContext: () => sfx.context(),
  voiceFx: (src) => sfx.voiceFx(src),
  onStart: () => {
    if (!S.speaking) {
      S.speaking = true;
      refreshState();
    }
    S.segSpoken = Math.min(S.segTotal, S.segSpoken + 1);
    if (S.replyText) home.reply(S.replyText, { spoken: S.segSpoken, total: S.segTotal });
    if (!S.turnSpoke && S.lat.t0) {
      S.turnSpoke = true;
      S.lat.t3 = Date.now();
      showLatency();
    }
  },
  onIdle: () => {
    S.speaking = false;
    home.tts(0, { speaking: false, engine: speaker.engine });
    refreshState();
  },
  onLevel: (v) => home.tts(v, { speaking: S.speaking, engine: speaker.engine }),
  onProblem: (code) => {
    if (code === 'NO_THAI_VOICE' && !S.ttsWarned) {
      S.ttsWarned = true;
      notice('ไม่พบเสียงพูดภาษาไทยในเครื่อง — ข้อความยังแสดงบนจอตามปกติ', 'warn', 'install-thai-voice', 0);
    }
  },
});

async function setupTts() {
  const r = await speaker.detect();
  speaker.setRate(S.settings.ttsRate);
  const label = r.engine === 'none' ? 'TTS: ไม่มีเสียงไทย' : `TTS: ${r.engine === 'winrt' ? 'Windows OneCore' : 'speechSynthesis'} · ${r.voice}`;
  $('tts-engine').textContent = label;
  home.tts(null, { speaking: false, engine: r.engine });
  $('tts-status').textContent = label;
  if (r.engine === 'none') onProblemNoVoice();
}

function onProblemNoVoice() {
  if (S.ttsWarned) return;
  S.ttsWarned = true;
  notice('ยังไม่มีเสียงพูดภาษาไทย (th-TH) ในเครื่อง — ระบบจะติดตั้งให้ (Windows จะขอสิทธิ์ admin) ระหว่างนี้ข้อความแสดงบนจอตามปกติ', 'warn', 'install-thai-voice', 0);
}

async function installThaiVoice() {
  notice('กำลังติดตั้งเสียงภาษาไทย… กดยอมรับหน้าต่าง UAC ของ Windows', 'info', null, 6000);
  const r = await api.invoke('tts:install-thai-voice');
  if (r.ok) {
    S.ttsWarned = false;
    await setupTts();
    notice(speaker.engine === 'none' ? 'ติดตั้งแล้ว แต่ยังไม่พบเสียงไทย อาจต้องรีสตาร์ท Windows' : 'ติดตั้งเสียงภาษาไทยสำเร็จ', speaker.engine === 'none' ? 'warn' : 'info');
  } else notice('ติดตั้งเสียงไทยไม่สำเร็จ: ' + r.error, 'error', null, 0);
}

// ---------------- sending ----------------

function needsTranscriptConfirm() {
  const m = S.settings.permissionMode;
  return S.settings.confirmVoiceBeforeSend || m === 'acceptEdits' || m === 'bypassPermissions';
}

/** A picture of the screen or one window (while watching: the latest changed frame). null when it failed. */
async function lookAtScreen(opts = {}) {
  let r = await api.invoke('screen:capture', opts).catch(failed);
  if (!r.ok && r.choose) {
    const id = await pickWindow(r.choose, r.error);
    if (!id) return null;
    r = await api.invoke('screen:capture', { windowId: id }).catch(failed);
  }
  if (r.ok) {
    sfx.shutter();
    return r.dataUrl;
  }
  notice(`จับภาพหน้าจอไม่ได้: ${r.error}`, 'warn', null, 5000);
  return null;
}

/** Several windows fit the spoken name: the user picks one with a real click. Resolves to its id or null. */
function pickWindow(choices, why) {
  return new Promise((resolve) => {
    const box = $('win-pick');
    const list = $('win-pick-list');
    $('win-pick-why').textContent = why || '';
    list.textContent = '';
    const done = (id) => { box.hidden = true; resolve(id); };
    for (const c of choices) {
      list.append(el('button', { class: 'btn', onclick: (ev) => { if (ev.isTrusted) done(c.id); } }, el('span', { text: c.name })));
    }
    $('win-pick-cancel').onclick = (ev) => { if (ev.isTrusted) done(null); };
    box.hidden = false;
    (list.firstElementChild || $('win-pick-cancel')).focus();
    say('มีหลายหน้าต่างที่ตรงกัน เลือกบนจอได้เลยครับ');
  });
}

async function screenWatchCommand(cmd, heard) {
  if (heard) addSystemMsg(`🎙 ${heard}`);
  if (cmd.op === 'stop') {
    const was = S.watch && S.watch.on;
    await api.invoke('screen:watch', { op: 'stop' }).catch(failed);
    return say(was ? 'หยุดดูหน้าจอแล้วครับ' : 'ตอนนี้ไม่ได้ดูหน้าจออยู่ครับ');
  }
  let r = await api.invoke('screen:watch', { op: 'start', windowHint: cmd.windowHint || '' }).catch(failed);
  if (!r.ok && r.choose) {
    const id = await pickWindow(r.choose, r.error);
    if (!id) return;
    r = await api.invoke('screen:watch', { op: 'start', windowId: id }).catch(failed);
  }
  if (!r.ok) return say(r.error);
  const what = r.target.kind === 'window' ? `หน้าต่าง ${r.target.name.slice(0, 40)}` : 'ทั้งหน้าจอ';
  say(`เริ่มดู${what}แล้วครับ พูดว่า ดูนี่ เมื่อต้องการให้ผมดู หยุดเองใน ${S.settings.screenWatchMaxMin} นาที`);
}

/** Badge shown the whole time the screen or a window is being watched (click = stop). */
function paintWatch() {
  const w = S.watch;
  const b = $('watch-badge');
  b.hidden = !(w && w.on);
  if (b.hidden) return;
  const name = w.target && w.target.kind === 'window' ? w.target.name : 'ทั้งหน้าจอ';
  $('watch-badge-text').textContent = `กำลังดู: ${name}`;
  b.title = `กำลังดู ${name} — ภาพจะส่งให้ Claude เมื่อคุณถามเท่านั้น คลิกเพื่อหยุด`;
}

function onWatchState(st) {
  const wasOn = S.watch && S.watch.on;
  S.watch = st;
  paintWatch();
  if (wasOn && !st.on && st.reason && st.reason !== 'manual') {
    const why = { timeout: 'ครบเวลาแล้ว', error: 'จับภาพไม่ได้ต่อเนื่อง', suspend: 'เครื่องเข้าโหมดสลีป', 'lock-screen': 'หน้าจอถูกล็อก' }[st.reason] || '';
    notice(`หยุดดูหน้าจอแล้ว${why ? ` (${why})` : ''}`, 'info', null, 5000);
  }
}

function hasTrigger(text) {
  return (S.settings.triggerWords || []).some((w) => w && text.includes(w));
}

async function send(text, { fromVoice = false, latency = {}, image: presetImage = null, imageSource: presetSource = 'camera' } = {}) {
  text = (text || '').trim();
  let image = presetImage; // a queued message keeps the picture taken when it was said
  let imageSource = presetSource;
  const winHint = !image && !text.startsWith('/') ? screenTarget(text) : null;
  if (winHint) {
    // "ดู error ในหน้าต่าง terminal": that window, even when the camera is on
    const shot = await lookAtScreen({ windowHint: winHint });
    if (shot) { image = shot; imageSource = 'screen'; }
  } else if (!image && vision.on && !text.startsWith('/')) {
    const wantLook = S.lookArmed || hasTrigger(text);
    if (wantLook) {
      image = (fromVoice && S.frameAtListenEnd) || vision.snapshot(S.settings.snapshotWidth, S.settings.snapshotHeight, S.settings.snapshotQuality);
      if (image) sfx.shutter();
    }
  } else if (!image && !text.startsWith('/') && wantsScreenLook(text)) {
    // camera off + "ดูนี่": JARVIS looks at the screen instead (its own windows are left out)
    const shot = await lookAtScreen();
    if (shot) { image = shot; imageSource = 'screen'; }
  }
  S.frameAtListenEnd = null;
  const attached = (S.app && S.app.attachments) || [];
  if (!text && !image && !attached.length) return false;
  if (!text && !image) text = 'ดูไฟล์ที่แนบมาให้หน่อย';
  orbBridge.set({ transcript: (text || '(ดูภาพนี้)').slice(0, 500), reply: '', replyDone: false, result: false });
  // ask for the folder first, so cancelling the popup leaves the running answer alone
  if (text.startsWith('/') && !image && await api.invoke('folder:needs', text).catch(() => false)) {
    if (!(await pickFolder(text))) {
      notice('ยกเลิกแล้ว — ยังไม่ได้เลือกโฟลเดอร์', 'info', null, 4000);
      return false;
    }
  }
  // a new command replaces the old one: stop reading the previous answer and cancel the running turn
  speaker.stop();
  if (S.busy && S.toolRunning) {
    // a tool is running: don't kill it on a stray message, ask first
    if (await askBarge()) await waitIdle();
    else if (S.busy) await api.invoke('chat:stop');
  } else if (S.busy) {
    // busy is cleared by the old turn's own end event, not forced here, so a late event can't clobber the new turn
    await api.invoke('chat:stop');
  }
  if (text) S.lastUserText = text;
  const t0 = Date.now();
  S.lat = { ...latency, t0 };
  S.turnSpoke = false;
  S.muteThisTurn = false;
  speaker.muted = false;
  showLatency();
  addUserMsg(text || '(ดูภาพนี้)', image, imageSource);
  setLook(false);
  sfx.send();
  const payload = { text, images: image ? [image] : [], imageSource, t0 };
  let r = await api.invoke('chat:send', payload);
  if (!r.ok && (r.code === 'PICK_FOLDER' || r.code === 'NO_CWD')) {
    // no folder picked in this conversation yet: ask in a popup, then send the same message
    if (await pickFolder(text)) r = await api.invoke('chat:send', payload);
    else {
      notice('ยกเลิกแล้ว — ยังไม่ได้เลือกโฟลเดอร์', 'info', null, 4000);
      return false;
    }
  }
  if (!r.ok) {
    notice(r.error, r.code === 'NO_CWD' ? 'warn' : 'error');
    if (r.code === 'NO_CWD' && talk.isFront) $('btn-folder').focus();
    return false;
  }
  return true;
}

/** Centre popup: folders already added to JARVIS + "choose a new folder". Resolves true once a folder is set. */
let cancelPick = null; // settles the popup that is open, if any
function pickFolder(text) {
  if (cancelPick) cancelPick(); // a second call replaces the first instead of leaving it hanging
  return new Promise(async (resolve) => {
    const box = $('folder-pick');
    const list = $('folder-pick-list');
    $('folder-pick-why').textContent = `คำสั่ง ${String(text).split(/\s+/)[0]} ต้องรู้ว่าจะทำงานกับโฟลเดอร์ไหน เลือกครั้งเดียว ใช้ต่อได้ตลอดบทสนทนานี้`;
    list.textContent = '';
    const opts = await api.invoke('folder:options').catch(() => []);
    const done = (ok) => {
      box.hidden = true;
      if (cancelPick === cancel) cancelPick = null;
      resolve(ok);
    };
    const cancel = () => resolve(false); // popup stays up for the new call
    cancelPick = cancel;
    const fail = (err) => notice(err.message, 'error');
    for (const o of opts) {
      list.append(el('button', {
        class: 'btn',
        onclick: async (ev) => {
          if (!ev.isTrusted) return; // a real click only
          const r = await api.invoke('folder:select', o.path).catch(fail);
          if (r && r.ok) {
            addSystemMsg(`โฟลเดอร์งาน: ${r.cwd}`);
            done(true);
          }
        },
      }, el('span', { text: o.path }), el('span', { class: 'tag', text: [o.current ? 'ปัจจุบัน' : '', o.git ? 'git' : 'ไม่ใช่ git'].filter(Boolean).join(' · ') })));
    }
    $('folder-pick-new').onclick = async (ev) => {
      if (!ev.isTrusted) return;
      const r = await api.invoke('folder:choose').catch(fail);
      if (r && r.ok) {
        addSystemMsg(`โฟลเดอร์งาน: ${r.cwd}`);
        done(true);
      }
    };
    $('folder-pick-cancel').onclick = (ev) => { if (ev.isTrusted) done(false); };
    box.hidden = false;
    (list.firstElementChild || $('folder-pick-new')).focus();
    say('เลือกโฟลเดอร์ที่จะให้ทำงานบนจอครับ');
  });
}

// true = let the running tool finish and send afterwards, false = stop everything
function askBarge() {
  return new Promise((resolve) => {
    const box = $('barge');
    box.hidden = false;
    $('barge-keep').focus();
    const done = (keep) => (ev) => {
      if (!ev.isTrusted) return; // a real click only
      box.hidden = true;
      resolve(keep);
    };
    $('barge-stop').onclick = done(false);
    $('barge-keep').onclick = done(true);
  });
}

function waitIdle(maxMs = 600000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (!S.busy || Date.now() - t0 > maxMs ? resolve() : setTimeout(tick, 300));
    tick();
  });
}

async function stopAll() {
  speaker.stop();
  await api.invoke('chat:stop');
}

function setLook(on) {
  S.lookArmed = on;
  $('btn-look').classList.toggle('on', on);
}

// ---------------- voice input ----------------

const mic = new Mic({
  onLevel: (_v, rms) => { S.micLevel = rms || 0; home.mic(rms, { listening: S.listening }); },
  onSpeechStart: () => {},
  onEnd: (r) => onMicEnd(r),
  onError: (code, msg) => {
    S.listening = false;
    $('btn-mic').classList.remove('listening');
    refreshState();
    const th = { MIC_DENIED: 'ไม่ได้รับสิทธิ์ใช้ไมโครโฟน — อนุญาตใน Windows Settings › Privacy › Microphone', MIC_NOT_FOUND: 'ไม่พบไมโครโฟน' }[code] || `ไมโครโฟนผิดพลาด: ${msg}`;
    notice(th, 'error');
    if (code === 'MIC_DENIED' || code === 'MIC_NOT_FOUND') typeInstead();
  },
});
let webRec = null;

function micOffNotice() {
  notice('ไมค์ปิดอยู่ — เปิดได้จากเมนูคลิกขวาที่ไอคอน JARVIS', 'warn', null, 4000);
  orbBridge.set({ error: 'ไมค์ปิดอยู่ — คลิกขวาที่ไอคอนเพื่อเปิด', errorId: Date.now() });
  typeInstead();
}

/** The mic can't be used: open the Floating Orb's text box so the user can type instead. */
function typeInstead() {
  orbBridge.set({ typeId: Date.now() });
}

async function hasMicDevice() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === 'audioinput');
  } catch {
    return true; // can't tell: let getUserMedia decide
  }
}

async function startListening({ hold = false } = {}) {
  if (S.micOff) return micOffNotice();
  if (hands && hands.active) return hands.manual();
  if (!(await hasMicDevice())) {
    notice('ไม่พบไมโครโฟน — พิมพ์ข้อความแทนได้เลย', 'warn', null, 4000);
    typeInstead();
    return;
  }
  // Barge-in: stop reading the answer so the mic doesn't hear it. The running turn is cancelled
  // only when the new command is actually sent (see send()).
  if (S.speaking) speaker.stop();
  if (S.settings.sttProvider === 'webspeech') {
    S.listening = true;
    refreshState();
    $('btn-mic').classList.add('listening');
    sfx.micOn();
    webRec = webSpeechOnce({
      onResult: (t) => afterTranscript(t, { t_listen_end: Date.now(), t_transcribed: Date.now() }),
      onError: (code, msg) => notice(msg, 'error', code === 'network' ? 'open-settings-voice' : null),
      onEnd: () => { S.listening = false; $('btn-mic').classList.remove('listening'); sfx.micOff(); refreshState(); },
    });
    return;
  }
  S.listening = true;
  $('btn-mic').classList.add('listening');
  refreshState();
  sfx.micOn();
  // holding the key: only the key release ends the recording (no VAD cut-off, no no-speech timeout)
  await mic.start(hold
    ? { deviceId: S.settings.micDeviceId, silenceMs: HOLD_LIMIT_MS, noSpeechMs: HOLD_LIMIT_MS }
    : { deviceId: S.settings.micDeviceId, silenceMs: S.settings.vadSilenceMs });
}

function stopListening() {
  if (webRec) { try { webRec.stop(); } catch { /* ignore */ } webRec = null; }
  mic.stop('manual');
}

async function onMicEnd({ pcm, hadSpeech, tListenEnd }) {
  S.listening = false;
  $('btn-mic').classList.remove('listening');
  sfx.micOff();
  if (vision.on) S.frameAtListenEnd = vision.snapshot(S.settings.snapshotWidth, S.settings.snapshotHeight, S.settings.snapshotQuality);
  if (!hadSpeech) {
    refreshState();
    notice('ไม่ได้ยินเสียงพูด', 'warn', null, 3000);
    return;
  }
  S.transcribing = true;
  refreshState();
  const r = await api.invoke('stt:transcribe', { pcm });
  S.transcribing = false;
  refreshState();
  const tTranscribed = Date.now();
  if (!r.ok) {
    const act = r.code === 'NO_WHISPER' || r.code === 'NO_MODEL' || r.code === 'NO_AZURE_KEY' ? 'open-settings-voice' : null;
    notice(r.error, 'error', act, 0);
    return;
  }
  if (!r.text) {
    notice('ถอดความได้ข้อความว่าง ลองพูดใหม่อีกครั้ง', 'warn', null, 4000);
    return;
  }
  afterTranscript(r.text, { t_listen_end: tListenEnd, t_transcribed: tTranscribed });
}

/** The next transcript goes to cb (Web Viewer "ถามหน้านี้" by voice). */
function voiceAsk(cb) {
  if (S.voiceAsk) { clearTimeout(S.voiceAsk.timer); S.voiceAsk.cb(null); }
  S.voiceAsk = { cb, timer: setTimeout(() => takeVoiceAsk(null), 30000) };
  startListening();
}

function takeVoiceAsk(text) {
  const va = S.voiceAsk;
  if (!va) return false;
  S.voiceAsk = null;
  clearTimeout(va.timer);
  va.cb(text);
  return true;
}

/** "เปิดเว็บ pantip" / "ไปที่ github.com": known sites open here, anything else goes to Claude. */
async function openSite(cmd, fallback) {
  let url = null;
  try { url = await api.invoke('web:resolve', cmd.name); } catch { /* not resolvable */ }
  if (url) { webViewer.open(url, { initiator: 'jarvis' }); orbBridge.set({ result: true }); }
  else fallback(cmd.text);
}

function afterTranscript(text, latency) {
  if (takeVoiceAsk(text)) return;
  const cmd = parseCommand(text, resultViewer ? resultViewer.context() : {});
  if (cmd && (cmd.action === 'talk-open' || cmd.action === 'talk-close')) {
    talkCommand(cmd.action);
    return;
  }
  if (cmd && cmd.action === 'viewer' && resultViewer && resultViewer.isOpen) {
    addSystemMsg(`🎙 ${text}`);
    resultViewer.command(cmd);
    return;
  }
  if (cmd && cmd.action === 'open-site') {
    addSystemMsg(`🎙 ${text}`);
    openSite(cmd, (t) => send(t, { fromVoice: true, latency }));
    return;
  }
  if (cmd && cmd.action === 'code') {
    codeCommand(cmd, text);
    return;
  }
  if (cmd && cmd.action === 'screen-watch') {
    screenWatchCommand(cmd, text);
    return;
  }
  if (cmd && cmd.action === 'serial') {
    serialCommand(cmd, text);
    return;
  }
  if (needsTranscriptConfirm()) {
    // the confirm box lives in the conversation popup: open it so JARVIS never looks silent
    if (sections.current) sections.home();
    $('transcript-confirm').hidden = false;
    $('transcript-text').value = text;
    talk.open({ focus: $('transcript-text') });
    S.pendingTranscriptLatency = latency;
    return;
  }
  addSystemMsg(`🎙 ถอดเสียงได้: ${text}`);
  send(text, { fromVoice: true, latency });
}

// ---------------- camera ----------------

const vision = new Vision({
  video: $('cam'),
  overlay: $('cam-overlay'),
  onError: (code, msg) => { if (!/^CAM_/.test(code)) notice(`MediaPipe: ${msg}`, 'error'); },
  onStatus: (t) => { $('vision-status').textContent = t; term(t, 'info'); },
});

// one large viewer for camera + results (same transition, never two at once)
const viewer = new StageViewer({ home, openExternal: (u) => resultViewer.openExternal(u) });

// "/" menu of Claude Code skills — made before the popup so it sees Tab / Esc / Enter first
const slashMenu = new SlashMenu({
  input: $('input'),
  load: async () => {
    const r = await api.invoke('skills:list');
    return r && r.ok ? r.items : [];
  },
  onChange: () => talk.inputChanged(),
});

// the conversation: a popup over the HUD, another surface of the same viewer
talk = new ConversationPopup({
  viewer,
  home,
  canKey: () => home.visible && !home.booting && !sections.current && ['menu', 'approval', 'barge', 'hf-consent'].every((id) => $(id).hidden),
  onOpenInteractive: () => openInteractive(),
  onEscape: () => historyPanel.escape(),
});

const usagePanel = new UsagePanel({
  api,
  notice: (text, level) => notice(text, level || 'info', null, 6000),
  onSnapshot: (s) => home.usage(s),
});
usagePanel.load();
setInterval(() => { if (usagePanel.snap) home.usage(usagePanel.snap); }, 60000); // keep the card's countdown fresh

// "/" menu of the background project's message box — made before the popup, like the main one
const projectSlash = new SlashMenu({
  id: 'proj-slash-menu',
  input: $('proj-input'),
  load: async () => {
    const r = await api.invoke('skills:list');
    return r && r.ok ? r.items : [];
  },
});

// background projects: PROJECTS popup (a surface of the viewer, like the conversation) + the HUD chip
const projectsPanel = new ProjectsPanel({
  api,
  slash: projectSlash,
  el,
  notice: (text, level) => notice(text, level || 'info', null, 7000),
  viewer,
  canKey: () => home.visible && !home.booting && !sections.current && ['menu', 'approval', 'barge', 'hf-consent'].every((id) => $(id).hidden),
  isHomeVisible: () => home.visible && !sections.current,
  onPromoted: (messages, title) => showResumed(messages, title),
});
/** A past conversation became the HUD's chat (history panel, or a background project taken over). */
function showResumed(messages, title) {
  curMsg = null;
  curText = null;
  $('chat').replaceChildren();
  for (const m of messages) {
    if (m.role === 'user') addUserMsg(m.text);
    else $('chat').append(linkedText(el('div', { class: 'msg assistant' }), m.text));
  }
  addSystemMsg(`ทำต่อจากบทสนทนา "${title}" — JARVIS จำเนื้อหาเดิมได้ พิมพ์หรือพูดต่อได้เลย`);
}

const historyPanel = new HistoryPanel({
  api,
  notice: (text, level) => notice(text, level || 'info', null, 5000),
  onResumed: (messages, item) => showResumed(messages, item.title),
});

/** "เปิดบทสนทนา" / "ปิดบทสนทนา" (voice, push-to-talk or hands-free). */
function talkCommand(action) {
  if (action === 'talk-open') {
    if (sections.current) sections.home();
    talk.open();
  } else {
    talk.close();
  }
}
webViewer = new WebViewer({
  viewer,
  api,
  home,
  speak: (text) => resultViewer.speak(text),
  notice: (text, level) => notice(text, level || 'info', null, 6000),
  onThinking: (on) => { S.webThinking = on; refreshState(); },
  voiceAsk,
});
resultViewer = new ResultViewer({
  viewer,
  home,
  api,
  speaker,
  sfx,
  web: webViewer,
  retry: () => { if (S.lastUserText) send(S.lastUserText); },
  // the conversation is open: the result opens in the viewer right away and also
  // leaves a "เปิดดู" card in the chat to open it again later
  defer: () => talk.isFront,
  onDeferred: (data, open) => {
    S.deferredResult = null;
    addResultLink(`ผลลัพธ์: ${data.title || data.type || 'ผลลัพธ์'}`, () => open());
    open();
  },
});
window.jarvisViewer = Object.freeze({
  show: (data) => resultViewer.show(data),
  openWeb: (url, opts) => { orbBridge.set({ result: true }); return webViewer.open(url, { initiator: 'jarvis', ...(opts || {}) }); },
  close: () => viewer.closeAll(),
  get open() { return viewer.isOpen; },
});

const cameraPanel = new CameraPanel({
  cards: home.cards,
  home,
  viewer,
  vision,
  getDeviceId: () => (S.settings ? S.settings.cameraDeviceId : ''),
  setDeviceId: (id) => saveSetting({ cameraDeviceId: id }),
  overlayOn: () => (S.settings ? S.settings.visionOverlay : true),
  onChange: (state) => {
    $('btn-cam').classList.toggle('on', state === 'on');
    if (state !== 'on') setLook(false);
  },
  onError: (msg) => notice(`กล้อง: ${msg}`, 'error'),
});

function toggleCamera() {
  cameraPanel.toggle();
}

// ---------------- hands-free (wake word) ----------------

const HF_ERRORS = {
  MIC_DENIED: 'ไม่ได้รับสิทธิ์ใช้ไมโครโฟน — อนุญาตใน Windows Settings › Privacy › Microphone แล้วเปิด Hands-free อีกครั้ง',
  MIC_NOT_FOUND: 'ไม่พบไมโครโฟน — Hands-free จะกลับมาฟังเองทันทีที่เสียบไมค์',
  MIC_LOST: 'ไมโครโฟนถูกถอดออก — Hands-free หยุดชั่วคราว และจะกลับมาฟังเองเมื่อเสียบไมค์อีกครั้ง',
  MIC_ERROR: 'เปิดไมโครโฟนไม่ได้',
  ENGINE_FAILED: 'โหลดระบบฟังคำเรียก “จาร์วิส” ไม่สำเร็จ — ใช้ Ctrl+Space (กดเพื่อพูด) แทนได้',
  WORKER: 'ระบบฟังคำเรียกผิดพลาด',
};

function loadHfStats() {
  try { return JSON.parse(localStorage.getItem('jarvis.hfStats') || '{}'); } catch { return {}; }
}

const hfEngine = new OwwEngine({
  onEvent: (e) => hands.onEngine(e),
  onLevel: (rms) => {
    S.micLevel = rms || 0;
    home.signals.mic = rms; // reactor: command + follow-up
    if (S.hfRec) home.mic(rms, { listening: true }); // MIC card: live dB only while recording
  },
});

// Web Speech fallback (sttProvider = webspeech): recognition runs live during the command
let hfWeb = null;
function hfWebStart() {
  if (S.settings.sttProvider !== 'webspeech' || hfWeb) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const r = new SR();
  r.lang = 'th-TH';
  r.interimResults = true;
  r.continuous = true;
  const st = { text: '', err: null, done: null };
  st.ended = new Promise((res) => { st.done = res; });
  r.onresult = (e) => {
    st.text = Array.from(e.results).map((x) => x[0].transcript).join(' ');
    if (hands.state === HF.COMMAND_LISTENING) home.hfTranscript(st.text, false);
  };
  r.onerror = (e) => { st.err = e.error; };
  r.onend = () => st.done();
  try { r.start(); } catch { return; }
  hfWeb = { r, st };
}

async function hfTranscribe(pcm, { partial, verify }) {
  if (verify) return api.invoke('stt:transcribe', { pcm, verify: true });
  if (S.settings.sttProvider === 'webspeech') {
    if (partial) return null;
    const w = hfWeb;
    hfWeb = null;
    if (!w) return { ok: false, code: 'UNSUPPORTED', error: 'เครื่องนี้ไม่มี Web Speech API' };
    try { w.r.stop(); } catch { /* ended */ }
    await Promise.race([w.st.ended, new Promise((r) => setTimeout(r, 3000))]);
    if (w.st.err && !w.st.text) return { ok: false, code: w.st.err, error: w.st.err === 'network' ? 'Web Speech ใช้ไม่ได้ใน Electron (error "network") — เลือก whisper ใน Settings › เสียง' : w.st.err };
    return { ok: true, text: w.st.text };
  }
  const tEnd = Date.now();
  const r = await api.invoke('stt:transcribe', { pcm, partial: !!partial });
  if (!partial) S.hfLat = { t_listen_end: tEnd, t_transcribed: Date.now() };
  return r;
}

async function hfSend(text) {
  if (takeVoiceAsk(text)) return false; // answered by the Web Viewer, no Claude turn to wait for
  addSystemMsg(`🎙 ${text}`);
  if (needsTranscriptConfirm()) {
    // acceptEdits / bypassPermissions: voice text is confirmed on screen first (by click)
    afterTranscript(text, S.hfLat || {});
    notice('โหมดสิทธิ์นี้ต้องยืนยันข้อความเสียงบนจอก่อนส่ง', 'info', null, 4000);
    return false;
  }
  return send(text, { fromVoice: true, latency: S.hfLat || {} });
}

function hfLocal(cmd) {
  switch (cmd.action) {
    case 'camera-on': cameraPanel.turnOn(); break;
    case 'camera-off': cameraPanel.turnOff(); break;
    case 'card-close': home.docking.close(cmd.card); break;
    case 'card-open': home.docking.open(cmd.card); break;
    case 'handsfree-off': addSystemMsg('ปิดโหมด Hands-free'); break;
    case 'talk-open':
    case 'talk-close': talkCommand(cmd.action); break;
    case 'viewer': resultViewer.command(cmd); break;
    case 'open-site': openSite(cmd, (t) => hfSend(t)); break;
    case 'code': codeCommand(cmd); break;
    case 'serial': serialCommand(cmd); break;
    case 'stop': api.invoke('code:cancel').catch(() => {}); break; // also stops a running test/check
    default: break;
  }
}

hands = new HandsFree({
  engine: hfEngine,
  transcribe: hfTranscribe,
  send: hfSend,
  local: hfLocal,
  context: () => resultViewer.context(),
  stopSpeaking: (ms) => speaker.stop(ms),
  abortTurn: () => {
    // running tools are never killed by voice: they finish silently instead
    if (S.toolRunning) S.muteThisTurn = speaker.muted = true;
    else if (S.busy) api.invoke('chat:stop');
  },
  sfx,
  stats: loadHfStats(),
  saveStats: (st) => { try { localStorage.setItem('jarvis.hfStats', JSON.stringify(st)); } catch { /* storage unavailable */ } },
  settings: () => ({
    sensitivity: S.settings.handsFreeSensitivity,
    bargeVoice: S.settings.handsFreeBargeVoice,
    liveTranscript: S.settings.handsFreeLiveTranscript && S.settings.sttProvider === 'whisper',
    verifyWake: S.settings.sttProvider === 'whisper', // local only
    deviceId: S.settings.micDeviceId,
    debug: (() => { try { return localStorage.getItem('jarvis.hfDebug') === '1'; } catch { return false; } })(),
  }),
  ui: {
    state: (st) => {
      if (st === HF.WAKE_DETECTED) home.hfWake();
      renderHandsFree();
      refreshState();
    },
    transcript: (text, final) => {
      home.hfTranscript(text, final);
      if (text) orbBridge.set({ transcript: String(text).slice(0, 500), reply: '', replyDone: false, result: false });
    },
    rec: (on) => {
      S.hfRec = on;
      home.hfRec(on);
      if (!on) home.mic(null, { listening: false });
    },
    follow: (ms) => home.hfFollow(ms),
    error: (code, msg) => {
      const th = HF_ERRORS[code];
      if (th) notice(code === 'ENGINE_FAILED' && msg ? `${th} (${msg})` : th, code === 'MIC_LOST' || code === 'MIC_NOT_FOUND' ? 'warn' : 'error', null, code === 'ENGINE_FAILED' ? 0 : 9000);
      else notice(msg || code, 'error', ['NO_WHISPER', 'NO_MODEL', 'NO_AZURE_KEY', 'network'].includes(code) ? 'open-settings-voice' : null);
      term(`hands-free: ${code} ${msg || ''}`, 'error');
    },
    log: (t) => { term(`hands-free: ${t}`, 'info'); if (/^score/.test(t)) console.log('[HF]', t); },
  },
});

hands.on('command:start', () => hfWebStart());
hands.on('command:end', () => {
  if (vision.on) S.frameAtListenEnd = vision.snapshot(S.settings.snapshotWidth, S.settings.snapshotHeight, S.settings.snapshotQuality);
});
hands.on('handsfree:on', () => api.invoke('hf:active', { on: true }).catch(() => {}));
hands.on('handsfree:off', () => {
  api.invoke('hf:active', { on: false }).catch(() => {});
  if (hfWeb) { try { hfWeb.r.abort(); } catch { /* ended */ } hfWeb = null; }
});

// Other modules: window.jarvisHandsFree.on('wake:detected' | 'command:start' |
// 'command:end' | 'assistant:speaking' | 'followup:timeout', fn)
window.jarvisHandsFree = {
  on: (name, fn) => hands.on(name, fn),
  get state() { return hands.state; },
  get stats() { return { ...hands.stats }; },
  enable: () => toggleHandsFree(true),
  disable: () => hands.disable(),
};
try { if (localStorage.getItem('jarvis.hfDebug') === '1') { window.jarvisHandsFree._dev = hands; window.__resultViewer = resultViewer; window.__cameraPanel = cameraPanel; window.__webViewer = webViewer; } } catch { /* storage unavailable */ }

function renderHandsFree() {
  const b = $('btn-handsfree');
  const on = hands.active;
  b.classList.toggle('on', on);
  b.classList.toggle('paused', hands.state === HF.PAUSED);
  b.setAttribute('aria-pressed', String(on));
  home.cards.setMicMode(on);
  if (!S.hfRec) home.mic(null, { listening: false });
  const st = $('hf-status');
  if (st) {
    const cpu = hands.lastCpu ? ` · ${hands.lastCpu.msPerFrame.toFixed(1)} ms ต่อ 80 ms (${((hands.lastCpu.msPerFrame / 80) * 100).toFixed(1)}% ของ 1 core)` : '';
    const info = hfEngine.info ? ` · VAD ${hfEngine.info.vad ? 'Silero' : 'energy'} · “จาร์วิส” ${hfEngine.info.head ? '✓' : '✕'}` : '';
    st.textContent = `${on ? (hands.state === HF.PAUSED ? 'หยุดชั่วคราว' : 'กำลังฟัง') : 'ปิดอยู่'} · ${hfEngine.name}${info}${cpu} · false triggers ${hands.stats.falseTriggers} (กรองระหว่างพูด ${hands.stats.suppressed})`;
  }
}

function askHfConsent() {
  return new Promise((resolve) => {
    const box = $('hf-consent');
    box.hidden = false;
    $('hf-consent-yes').focus();
    const done = (v) => (ev) => {
      if (!ev.isTrusted) return; // consent is a real click only
      box.hidden = true;
      resolve(v);
    };
    $('hf-consent-yes').onclick = done(true);
    $('hf-consent-no').onclick = done(false);
  });
}

async function toggleHandsFree(forceOn = false) {
  if (hands.active && !forceOn) {
    hands.disable();
    return;
  }
  if (hands.active || hands.enabling) return;
  if (!S.settings.handsFreeConsent) {
    if (!(await askHfConsent())) return;
    await saveSetting({ handsFreeConsent: true });
  }
  if (S.listening) { mic.cancel(); S.listening = false; $('btn-mic').classList.remove('listening'); }
  const b = $('btn-handsfree');
  b.classList.add('busy');
  if (!hfEngine.worker) notice('กำลังเตรียมระบบฟังคำเรียก (ครั้งแรกจะดาวน์โหลดโมเดล ~5 MB)…', 'info', null, 4000);
  await hands.enable();
  b.classList.remove('busy');
  renderHandsFree();
  if (hands.active) term(`hands-free: เปิด · ${hfEngine.name} · VAD ${hfEngine.info && hfEngine.info.vad ? 'Silero' : 'energy'} · mic “${hfEngine.deviceLabel || 'default'}”`, 'info');
}

const HOLD_LIMIT_MS = 60000;
const HOLD_TAP_MS = 250; // released sooner than this = a tap: keep listening with normal VAD

/** Hold-to-talk key went down (native hook, pushToTalkMode 'hold'). */
function pttDown() {
  if (S.pttHeldAt) return;
  S.pttHeldAt = Date.now();
  S.pttStart = null;
  if (S.micOff) return micOffNotice();
  if (hands.active) {
    if (hands.state !== HF.COMMAND_LISTENING) hands.manual();
    return;
  }
  if (!S.listening) S.pttStart = startListening({ hold: true });
}

/** Key released: a real hold sends what was said; a quick tap behaves like the old toggle. */
async function pttUp() {
  const heldMs = S.pttHeldAt ? Date.now() - S.pttHeldAt : 0;
  S.pttHeldAt = 0;
  if (S.micOff) return;
  if (S.pttStart) await S.pttStart;
  S.pttStart = null;
  const tap = heldMs < HOLD_TAP_MS;
  if (hands.active) {
    if (!tap && hands.state === HF.COMMAND_LISTENING) hands.manual();
    return;
  }
  if (!S.listening) return;
  if (tap) {
    if (mic.opts) Object.assign(mic.opts, { silenceMs: S.settings.vadSilenceMs, noSpeechMs: 8000 });
    return;
  }
  stopListening();
}

/** Mic button / reactor click / Ctrl+Space: push-to-talk, or "listen now" in hands-free. */
function voiceButton() {
  if (S.micOff) return micOffNotice();
  if (hands.active) return hands.manual();
  return S.listening ? stopListening() : startListening();
}

/** Commands from the Floating Orb (relayed and validated by main). */
function onOrbCommand({ action, text }) {
  switch (action) {
    case 'toggle-listen':
      voiceButton();
      break;
    case 'send-text':
      send(text);
      break;
    case 'open-result':
      // the main window is already restored: bring the Result / Web Viewer to the front
      if (sections.current) sections.home();
      if (!viewer.showViewer() && S.deferredResult) {
        // the result was held as a card in the conversation: open it now
        const open = S.deferredResult;
        S.deferredResult = null;
        open();
      }
      break;
    case 'open-talk':
      // floating orb "ดูเพิ่ม": the main window is restored straight into the conversation
      if (sections.current) sections.home();
      talk.open();
      break;
    case 'mic-toggle':
      S.micOff = !S.micOff;
      if (S.micOff) {
        if (S.listening) { mic.cancel(); if (webRec) { try { webRec.stop(); } catch { /* ended */ } webRec = null; } S.listening = false; $('btn-mic').classList.remove('listening'); }
        hands.pause('mic-off');
        notice('ปิดไมค์แล้ว — JARVIS จะไม่ฟังจนกว่าจะเปิดอีกครั้ง', 'info', null, 4000);
      } else {
        hands.resume('mic-off');
        notice('เปิดไมค์แล้ว', 'info', null, 3000);
      }
      refreshState();
      break;
    case 'hf-toggle':
      toggleHandsFree();
      break;
    case 'mute-toggle':
      S.voiceMuted = !S.voiceMuted;
      if (S.voiceMuted) speaker.stop();
      notice(S.voiceMuted ? 'ปิดเสียงพูดของ JARVIS — คำตอบยังแสดงบนจอ' : 'เปิดเสียงพูดของ JARVIS', 'info', null, 3000);
      refreshState();
      break;
    default:
      break;
  }
}

function wireHandsFree() {
  $('btn-handsfree').onclick = () => toggleHandsFree();
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyH') {
      e.preventDefault();
      toggleHandsFree();
    }
  });
  // background (minimized / hidden): main reports it, since the page never throttles
  // (audio has to keep running for the Floating Orb). Wake listening keeps going while
  // the orb is on screen or in tray mode; otherwise it pauses as before.
  api.on('window:bg', ({ background, orb }) => {
    home.setPaused(background);
    orbBridge.setVisible(orb);
    if (background && !orb && S.settings.handsFreeBackground !== 'tray') hands.pause('background');
    else hands.resume('background');
  });
  api.on('orb:cmd', (c) => onOrbCommand(c));
  api.on('hf:power', ({ kind }) => {
    if (kind === 'suspend') hands.pause('sleep');
    if (kind === 'resume') hands.resume('sleep');
    if (kind === 'lock-screen') hands.pause('lock');
    if (kind === 'unlock-screen') hands.resume('lock');
  });
  api.on('hf:command', ({ action }) => { if (action === 'off') hands.disable(); });
  // settings tab
  for (const k of ['handsFreeBargeVoice', 'handsFreeLiveTranscript', 'handsFreeAutoStart', 'saveVoiceHistory']) {
    $(`s-${k}`).onchange = async (e) => { await saveSetting({ [k]: e.target.checked }); hands.reconfigure(); };
  }
  for (const k of ['handsFreeSensitivity', 'handsFreeBackground']) {
    $(`s-${k}`).onchange = async (e) => {
      await saveSetting({ [k]: e.target.value });
      hands.reconfigure();
      if (hands.active) api.invoke('hf:active', { on: true }).catch(() => {});
    };
  }
  $('ui-wake-chime').onchange = (e) => { sfx.setWakeChime(e.target.checked); if (e.target.checked) sfx.wakeChime(); };
  $('s-hf-history').onclick = () => api.invoke('hf:open-history');
}

function fillHandsFreeSettings() {
  const s = S.settings;
  for (const k of ['handsFreeBargeVoice', 'handsFreeLiveTranscript', 'handsFreeAutoStart', 'saveVoiceHistory']) $(`s-${k}`).checked = !!s[k];
  $('s-handsFreeSensitivity').value = s.handsFreeSensitivity;
  $('s-handsFreeBackground').value = s.handsFreeBackground;
  $('ui-wake-chime').checked = sfx.wakeChimeOn;
  renderHandsFree();
}

// ---------------- session / misc actions ----------------

async function openInteractive() {
  const r = await api.invoke('terminal:open-interactive');
  if (!r.ok) notice(r.error, 'error');
  else notice(r.resumed ? 'เปิด Claude Code ในหน้าต่างใหม่ (session เดียวกัน)' : 'เปิด Claude Code ในหน้าต่างใหม่');
}

async function newFromSummary() {
  const r = await api.invoke('session:new-from-summary');
  if (!r.ok) notice(r.errors.join(', '), 'warn');
  else if (!r.empty) addSystemMsg('กำลังให้ Claude สรุปความคืบหน้า เพื่อเริ่ม session ใหม่…');
}

function applyAppState(snap) {
  S.app = snap;
  talk.setCwd(snap.cwd); // middle-ellipsized on the button, full path in its tooltip
  $('menu-project').textContent = `${snap.cwd || 'ยังไม่ได้เลือกโฟลเดอร์'} · ${snap.permissionMode}`;
  $('session-id').textContent = snap.sessionId ? `· ${snap.sessionId.slice(0, 8)}` : '';
  $('btn-teach').classList.toggle('on', !!snap.teachMode);
  $('btn-code').classList.toggle('on', !!snap.codingMode);
  renderAttachments(snap.attachments);
  applyBuildState(snap);
  $('btn-teach').setAttribute('aria-pressed', String(!!snap.teachMode));
  $('btn-code').setAttribute('aria-pressed', String(!!snap.codingMode));
  applyMode(snap.permissionMode);
  applyModel(snap.model);
  hintClaudeMd(snap);
}

function applyModel(model = '') {
  const sel = $('home-model');
  // A full model id typed in Settings (e.g. claude-opus-5-5) gets its own entry.
  sel.querySelector('option[data-custom]')?.remove();
  if (![...sel.options].some((o) => o.value === model)) {
    sel.append(el('option', { value: model, text: model.toUpperCase(), 'data-custom': '' }));
  }
  sel.value = model;
  sel.classList.toggle('custom', sel.selectedOptions[0]?.hasAttribute('data-custom'));
}

function applyMode(mode) {
  $('perm-mode').value = mode;
  $('bypass-bar').hidden = mode !== 'bypassPermissions';
  if (S.settings) S.settings.permissionMode = mode;
}

// ---------------- settings dialog ----------------

const FIELDS = {
  text: ['claudePath', 'model', 'userProfile', 'azureRegion', 'pushToTalkKey', 'orbShortcut', 'geminiVoice'],
  num: ['approvalTimeoutSec', 'geminiDailyCap', 'vadSilenceMs', 'screenWatchIntervalSec', 'screenWatchMaxMin', 'snapshotWidth', 'snapshotHeight'],
  float: ['ttsRate', 'snapshotQuality'],
  bool: ['persistentProcess', 'ttsGemini', 'guardEnabled', 'confirmVoiceBeforeSend', 'autoApproveSafe', 'visionOverlay', 'orbEnabled', 'orbOnTopFullscreen', 'orbAutoFade', 'orbAutoOpenResults'],
  select: ['sttProvider', 'whisperModel', 'micDeviceId', 'speakerDeviceId', 'cameraDeviceId', 'orbSize', 'pushToTalkMode'],
};

async function applySpeaker() {
  const ok = await sfx.setOutputDevice(S.settings.speakerDeviceId);
  if (!ok && S.settings.speakerDeviceId) notice('ไม่พบลำโพงที่เลือก ใช้ลำโพงค่าเริ่มต้นของระบบแทน', 'warn');
}

async function saveSetting(partial) {
  const r = await api.invoke('settings:update', partial);
  if (!r.ok) notice(r.errors.join(', '), 'error');
  else S.settings = r.value;
  return r;
}

function fillSettings() {
  const s = S.settings;
  for (const k of [...FIELDS.text, ...FIELDS.num, ...FIELDS.float]) $(`s-${k}`).value = s[k];
  for (const k of FIELDS.bool) $(`s-${k}`).checked = !!s[k];
  for (const k of ['sttProvider', 'whisperModel', 'orbSize', 'pushToTalkMode']) $(`s-${k}`).value = s[k];
  $('s-guardBlock').value = s.guardBlock.join('\n');
  $('s-guardAsk').value = s.guardAsk.join('\n');
  $('s-guardBlockPaths').value = s.guardBlockPaths.join('\n');
  $('s-triggerWords').value = s.triggerWords.join('\n');
  $('s-sttVocabulary').value = s.sttVocabulary.join('\n');
  $('s-sttCorrections').value = s.sttCorrections.join('\n');
  const list = (ul, items, key) => {
    ul.replaceChildren();
    items.forEach((p, i) => ul.append(el('li', {}, el('span', { text: p }), el('button', { class: 'btn small ghost', text: '✕', onclick: async () => {
      const next = items.filter((_, j) => j !== i);
      await saveSetting({ [key]: next });
      fillSettings();
    } }))));
    if (!items.length) ul.append(el('li', { class: 'dim', text: '(ไม่มี)' }));
  };
  list($('s-mcp-list'), s.mcpConfigPaths, 'mcpConfigPaths');
  list($('s-dir-list'), s.addDirs, 'addDirs');
  fillHandsFreeSettings();
}

async function fillDevices() {
  const fill = async (sel, kind, cur) => {
    const devs = await listDevices(kind);
    sel.replaceChildren(el('option', { value: '', text: 'ค่าเริ่มต้นของระบบ' }));
    devs.forEach((d, i) => sel.append(el('option', { value: d.deviceId, text: d.label || `${kind} ${i + 1}` })));
    sel.value = cur || '';
  };
  await fill($('s-micDeviceId'), 'audioinput', S.settings.micDeviceId);
  await fill($('s-speakerDeviceId'), 'audiooutput', S.settings.speakerDeviceId);
  await fill($('s-cameraDeviceId'), 'videoinput', S.settings.cameraDeviceId);
}

async function refreshInstallStatus() {
  const st = await api.invoke('stt:status');
  const w = st.whisper;
  $('stt-status').textContent = `whisper: ${w.hasExe ? '✓' : '✕'} โปรแกรม · ${w.hasModel ? '✓' : '✕'} โมเดล ${w.modelName} · Typhoon key: ${st.typhoon.hasKey ? '✓' : '✕'} · Azure key: ${st.azure.hasKey ? '✓' : '✕'}`;
  const g = await api.invoke('tts:gemini-status');
  const n = (x) => x.toLocaleString('en-US');
  $('gemini-usage').textContent = `Gemini key: ${g.hasKey ? '✓' : '✕'} · วันนี้ ${n(g.day.requests)}/${n(g.dailyCap)} ครั้ง ${n(g.day.chars)} ตัวอักษร · เดือนนี้ ${n(g.month.requests)} ครั้ง ${n(g.month.chars)} ตัวอักษร${g.coolingDown ? ' · พักชั่วคราว (ใช้ Edge แทน)' : ''}${g.lastError ? ` · ผิดพลาดล่าสุด: ${g.lastError}` : ''}`;
  const vs = await api.invoke('vision:status');
  $('vision-status').textContent = `MediaPipe: face ${vs.models.face ? '✓' : '✕'} · hand ${vs.models.hand ? '✓' : '✕'} · gesture ${vs.models.gesture ? '✓' : '✕'}`;
  return { st, vs };
}

function openSettings(tab = 'claude') {
  fillSettings();
  fillDevices();
  refreshInstallStatus();
  if (sections.current !== 'settings') sections.show('settings');
  for (const b of $('settings-tabs').querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.stab === tab);
  for (const t of ['claude', 'perm', 'voice', 'camera', 'handsfree', 'display', 'web']) $(`stab-${t}`).hidden = t !== tab;
}

function wireSettings() {
  $('settings-close').onclick = () => sections.home();
  let quality = 'high';
  try { quality = localStorage.getItem('jarvis.quality') || 'high'; } catch { /* storage unavailable */ }
  $('ui-quality').value = quality;
  home.setQuality(quality);
  $('ui-boot-mode').value = bootPrefs.mode;
  $('ui-boot-mode').onchange = (e) => { bootPrefs.mode = e.target.value; };
  // HUD sound: 🔊/🔇 next to the menu button, ON/OFF + volume in the menu, and
  // settings. Everything is persisted by the sound engine (sfx.js).
  const syncHud = () => {
    const pct = Math.round(sfx.volume * 100);
    $('ui-boot-sound').checked = sfx.enabled;
    $('ui-hud-volume').value = String(pct);
    $('ui-hud-volume-val').textContent = `${pct}%`;
    $('ui-boot-mute').checked = sfx.bootMuted;
    $('ui-voice-greeting').checked = sfx.greeting;
    $('menu-snd-vol').value = String(pct);
    $('menu-snd-val').textContent = `${pct}%`;
    const t = $('menu-snd-toggle');
    t.textContent = sfx.enabled ? 'ON' : 'OFF';
    t.classList.toggle('on', sfx.enabled);
    t.setAttribute('aria-pressed', String(sfx.enabled));
    const b = $('btn-hud-sound');
    b.classList.toggle('off', !sfx.enabled);
    b.setAttribute('aria-pressed', String(sfx.enabled));
    b.title = sfx.enabled ? 'ปิดเสียง HUD' : 'เปิดเสียง HUD';
  };
  sfx.onChange(syncHud);
  syncHud();
  const toggleSound = () => {
    sfx.setEnabled(!sfx.enabled);
    if (sfx.enabled) sfx.micOn(); // short audible confirmation
  };
  $('ui-boot-sound').onchange = (e) => sfx.setEnabled(e.target.checked);
  $('ui-hud-volume').oninput = (e) => sfx.setVolume(Number(e.target.value) / 100);
  $('menu-snd-vol').oninput = (e) => sfx.setVolume(Number(e.target.value) / 100);
  $('ui-boot-mute').onchange = (e) => sfx.setBootMuted(e.target.checked);
  $('ui-voice-greeting').onchange = (e) => sfx.setGreeting(e.target.checked);
  $('btn-hud-sound').onclick = toggleSound;
  $('menu-snd-toggle').onclick = toggleSound;
  $('ui-quality').onchange = (e) => {
    home.setQuality(e.target.value);
    try { localStorage.setItem('jarvis.quality', e.target.value); } catch { /* ignore */ }
  };
  $('settings-tabs').onclick = (e) => {
    const t = e.target.dataset.stab;
    if (t) openSettings(t);
  };
  for (const k of FIELDS.text) $(`s-${k}`).onchange = (e) => saveSetting({ [k]: e.target.value.trim() });
  for (const k of FIELDS.num) $(`s-${k}`).onchange = (e) => saveSetting({ [k]: parseInt(e.target.value, 10) });
  for (const k of FIELDS.float) $(`s-${k}`).onchange = async (e) => { await saveSetting({ [k]: parseFloat(e.target.value) }); speaker.setRate(S.settings.ttsRate); };
  for (const k of FIELDS.bool) $(`s-${k}`).onchange = (e) => saveSetting({ [k]: e.target.checked });
  for (const k of FIELDS.select) $(`s-${k}`).onchange = async (e) => {
    await saveSetting({ [k]: e.target.value });
    if (k === 'speakerDeviceId') { await applySpeaker(); sfx.send(); } // short blip so you hear where it goes
    refreshInstallStatus();
  };
  const lines = (id) => $(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
  $('s-guard-save').onclick = async () => {
    const r = await saveSetting({ guardBlock: lines('s-guardBlock'), guardAsk: lines('s-guardAsk'), guardBlockPaths: lines('s-guardBlockPaths') });
    if (r.ok) notice('บันทึกรายการตัวกันพลาดแล้ว (มีผลทันที)');
  };
  $('s-guard-reset').onclick = async () => {
    const r = await api.invoke('settings:reset-guard');
    if (r.ok) { S.settings = r.value; fillSettings(); }
  };
  $('s-trigger-save').onclick = () => saveSetting({ triggerWords: lines('s-triggerWords') });
  $('s-stt-words-save').onclick = () => saveSetting({ sttVocabulary: lines('s-sttVocabulary'), sttCorrections: lines('s-sttCorrections') });
  $('s-bypass-on').onclick = async (ev) => {
    if (!ev.isTrusted) return;
    const r = await api.invoke('mode:set', { mode: 'bypassPermissions', confirmText: $('s-bypass-confirm').value.trim() });
    $('s-bypass-confirm').value = '';
    if (!r.ok) notice(r.errors.join(', '), 'error');
    else {
      S.settings = r.value;
      applyMode('bypassPermissions');
      notice('เปิด bypassPermissions แล้ว', 'warn');
    }
  };
  $('s-mcp-add').onclick = async () => {
    const p = await api.invoke('mcp:choose-config').catch((err) => { notice('ไฟล์ MCP config ไม่ใช่ JSON ที่ถูกต้อง: ' + err.message, 'error'); return null; });
    if (p && !S.settings.mcpConfigPaths.includes(p)) { await saveSetting({ mcpConfigPaths: [...S.settings.mcpConfigPaths, p] }); fillSettings(); }
  };
  $('s-dir-add').onclick = async () => {
    const p = await api.invoke('dir:choose-extra');
    if (p && !S.settings.addDirs.includes(p)) { await saveSetting({ addDirs: [...S.settings.addDirs, p] }); fillSettings(); }
  };
  $('s-web-clear').onclick = async (e) => {
    if (!e.isTrusted) return;
    e.target.disabled = true;
    $('s-web-clear-status').textContent = 'กำลังล้าง…';
    const r = await api.invoke('web:clear-data').catch((err) => ({ ok: false, error: err.message }));
    e.target.disabled = false;
    $('s-web-clear-status').textContent = r.ok ? 'ล้างข้อมูลเว็บแล้ว' : `ล้างไม่สำเร็จ: ${r.error}`;
  };
  $('s-stt-install').onclick = async (e) => {
    e.target.disabled = true;
    const r = await api.invoke('stt:install');
    e.target.disabled = false;
    notice(r.ok ? 'ติดตั้ง whisper.cpp และโมเดลเรียบร้อย' : 'ติดตั้งไม่สำเร็จ: ' + r.error, r.ok ? 'info' : 'error');
    refreshInstallStatus();
  };
  $('s-vision-install').onclick = async (e) => {
    e.target.disabled = true;
    const r = await api.invoke('vision:install');
    e.target.disabled = false;
    notice(r.ok ? 'ดาวน์โหลดโมเดล MediaPipe แล้ว' : 'ดาวน์โหลดไม่สำเร็จ: ' + r.error, r.ok ? 'info' : 'error');
    refreshInstallStatus();
    if (r.ok && vision.on) vision.initDetectors();
  };
  $('s-typhoon-save').onclick = async () => {
    const key = $('s-typhoon-key').value.trim();
    await api.invoke('stt:set-typhoon-key', key).then(() => notice(key ? 'บันทึก Typhoon key (เข้ารหัส) แล้ว' : 'ลบ Typhoon key แล้ว'), (err) => notice(err.message, 'error'));
    $('s-typhoon-key').value = '';
    refreshInstallStatus();
  };
  $('s-ion-save').onclick = async () => {
    const key = $('s-ion-key').value.trim();
    await api.invoke('maps:set-ion-key', key).then(() => notice(key ? 'บันทึก Cesium ion token (เข้ารหัส) แล้ว — แผนที่จะมีปุ่ม Earth' : 'ลบ Cesium ion token แล้ว'), (err) => notice(err.message, 'error'));
    $('s-ion-key').value = '';
  };
  $('s-google-maps-save').onclick = async () => {
    const key = $('s-google-maps-key').value.trim();
    await api.invoke('maps:set-google-key', key).then(() => notice(key ? 'บันทึก Google Maps key (เข้ารหัส) แล้ว — แผนที่จะมีปุ่ม Earth' : 'ลบ Google Maps key แล้ว'), (err) => notice(err.message, 'error'));
    $('s-google-maps-key').value = '';
  };
  $('s-sketchfab-save').onclick = async () => {
    const key = $('s-sketchfab-key').value.trim();
    await api.invoke('model3d:set-sketchfab-token', key).then(() => notice(key ? 'บันทึก Sketchfab token (เข้ารหัส) แล้ว' : 'ลบ Sketchfab token แล้ว'), (err) => notice(err.message, 'error'));
    $('s-sketchfab-key').value = '';
  };
  $('s-orb-reset').onclick = async () => {
    const r = await saveSetting({ orbPos: null });
    if (r.ok) notice('รีเซ็ตตำแหน่งไอคอนแล้ว (มุมขวาล่างของจอหลัก)', 'info', null, 3000);
  };
  $('s-azure-save').onclick = async () => {
    const key = $('s-azure-key').value.trim();
    await api.invoke('stt:set-azure-key', key).then(() => notice(key ? 'บันทึก Azure key (เข้ารหัส) แล้ว' : 'ลบ Azure key แล้ว'), (err) => notice(err.message, 'error'));
    $('s-azure-key').value = '';
    refreshInstallStatus();
  };
  $('s-gemini-save').onclick = async () => {
    const key = $('s-gemini-key').value.trim();
    await api.invoke('tts:set-gemini-key', key).then(() => notice(key ? 'บันทึก Gemini key (เข้ารหัส) แล้ว' : 'ลบ Gemini key แล้ว'), (err) => notice(err.message, 'error'));
    $('s-gemini-key').value = '';
    refreshInstallStatus();
  };
  $('s-thai-voice').onclick = installThaiVoice;
  $('s-speech-settings').onclick = () => api.invoke('system:open-speech-settings');
}

// ---------------- auto-install on first run ----------------

async function autoInstall() {
  const { st, vs } = await refreshInstallStatus();
  if (st.provider === 'whisper' && (!st.whisper.hasExe || !st.whisper.hasModel) && !st.installing) {
    notice('กำลังติดตั้ง whisper.cpp และโมเดลภาษาไทยให้อัตโนมัติ (ครั้งแรกเท่านั้น)…', 'info', null, 8000);
    api.invoke('stt:install').then((r) => {
      notice(r.ok ? 'พร้อมรับเสียงภาษาไทยแล้ว (whisper.cpp)' : 'ติดตั้ง whisper ไม่สำเร็จ: ' + r.error, r.ok ? 'info' : 'error', r.ok ? null : 'open-settings-voice', r.ok ? 6000 : 0);
      refreshInstallStatus();
    });
  }
  if (!vs.ready && !vs.installing) api.invoke('vision:install').then(refreshInstallStatus);
}

let lastProgress = 0;
function onInstallProgress(p) {
  const now = Date.now();
  if (!p.done && now - lastProgress < 3000) return;
  lastProgress = now;
  const pct = p.total ? ` ${Math.floor((p.received / p.total) * 100)}%` : '';
  term(`ติดตั้ง ${p.what}: ${p.step}${pct}${p.done ? ' ✓' : ''}`, 'info');
}

// ---------------- events from main ----------------

// ---------------- build timer (coding mode) ----------------

const buildClock = { since: null, totalMs: 0, timer: null };

/** 125000 → "2:05", 3725000 → "1:02:05" */
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function renderBuildClock() {
  const running = buildClock.since != null;
  $('build-now').textContent = running ? clock(Date.now() - buildClock.since) : '';
  $('build-total').textContent = `${running ? ' · ' : ''}รวม ${clock(buildClock.totalMs + (running ? Date.now() - buildClock.since : 0))}`;
}

function setBuildRunning(since) {
  buildClock.since = since || null;
  clearInterval(buildClock.timer);
  buildClock.timer = since ? setInterval(renderBuildClock, 1000) : null;
  renderBuildClock();
}

function applyBuildState(snap) {
  const b = snap.build || {};
  buildClock.totalMs = b.totalMs || 0;
  $('build-timer').hidden = !snap.codingMode && !b.runningSince;
  if ((b.runningSince || null) !== buildClock.since) setBuildRunning(b.runningSince);
  else renderBuildClock();
}

// ---------------- attachments (drag & drop, ＋ button) ----------------

function showAttachResult(r) {
  if (!r || !r.added) return;
  for (const a of r.added) {
    if (a.kind === 'project') addSystemMsg(`ตั้ง ${a.path} เป็นโฟลเดอร์โปรเจกต์แล้ว`);
  }
  if (r.added.some((a) => a.kind !== 'project') && sections.current !== 'talk') sections.show('talk');
  if (r.added.length) $('input').focus();
}

function renderAttachments(list) {
  const box = $('attach-chips');
  box.replaceChildren();
  for (const a of list || []) {
    const name = a.path.split(/[\\/]/).filter(Boolean).pop() || a.path;
    const chip = el('span', { class: 'attach-chip', title: a.path },
      el('span', { text: a.kind === 'folder' ? '📁' : '📄' }),
      el('span', { class: 'name', text: name }));
    if (a.kind === 'folder') {
      chip.append(el('button', { type: 'button', text: 'ใช้เป็นโปรเจกต์', title: 'ตั้งโฟลเดอร์นี้เป็นโฟลเดอร์โปรเจกต์ (เริ่ม session ใหม่)', onclick: async () => {
        const r = await api.invoke('attach:make-project', a.path).catch((err) => ({ ok: false, error: err.message }));
        if (r.ok) addSystemMsg(`ตั้ง ${r.cwd} เป็นโฟลเดอร์โปรเจกต์แล้ว`);
        else notice(r.error, 'error');
      } }));
    }
    chip.append(el('button', { type: 'button', text: '✕', 'aria-label': `เอา ${name} ออก`, onclick: () => api.invoke('attach:remove', a.path) }));
    box.append(chip);
  }
  box.hidden = !box.childElementCount;
}

function wireAttachments() {
  const menu = $('attach-menu');
  const closeMenu = () => { menu.hidden = true; };
  $('btn-attach').onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) menu.querySelector('button').focus();
  };
  for (const b of menu.querySelectorAll('button')) {
    b.onclick = async () => {
      closeMenu();
      showAttachResult(await api.invoke('attach:choose', b.dataset.kind).catch((err) => notice(err.message, 'error')));
    };
  }
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); $('btn-attach').focus(); } });

  // drag & drop anywhere on the window
  const overlay = $('drop-overlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean).slice(0, 20);
    if (!paths.length) return notice('ลากได้เฉพาะไฟล์หรือโฟลเดอร์ในเครื่อง', 'warn', null, 4000);
    showAttachResult(await api.invoke('attach:add', paths).catch((err) => notice(err.message, 'error')));
  });
}

function wireEvents() {
  api.on('state', ({ state, tool }) => {
    S.coreState = state;
    S.busy = !['STANDBY', 'ERROR'].includes(state);
    S.toolName = state === 'TOOL_RUNNING' && tool ? String(tool) : '';
    S.toolInput = null; // the activity event right after this one carries the input
    if (state === 'STANDBY' || state === 'ERROR') S.toolRunning = false;
    if (state === 'ERROR') taskStatus.finish(false);
    refreshState(state === 'TOOL_RUNNING' && tool ? `Claude กำลังใช้ ${tool}` : undefined);
  });
  api.on('app-state', applyAppState);
  api.on('settings', (s) => { S.settings = s; applyMode(s.permissionMode); applyModel(s.model); });
  api.on('turn:start', (t) => {
    if (t && t.buildStartedAt) {
      $('build-timer').hidden = false;
      setBuildRunning(t.buildStartedAt);
    }
    resultViewer.startTurn();
    S.stepInfo = null;
    S.turnSpokenChars = 0;
    curMsg = null;
    curText = null;
    S.busy = true;
    S.replyText = '';
    S.segTotal = 0;
    S.segSpoken = 0;
  });
  api.on('chat:item', onChatItem);
  api.on('notice', (n) => notice(n.text, n.level, n.action, 0));
  api.on('activity', onActivity);
  api.on('todos', onTodos);
  api.on('terminal', ({ stream, text }) => term(text, stream));
  api.on('notice', ({ level, text, action }) => notice(text, level, action));
  api.on('error', ({ code, message, stderr }) => {
    notice(message, 'error', code === 'NOT_LOGGED_IN' ? 'open-interactive' : null, 0);
    term(`${code}: ${message}${stderr ? '\n' + stderr : ''}`, 'error');
  });
  api.on('session', (e) => {
    if (e.kind === 'new' || e.kind === 'new-from-summary' || e.kind === 'resumed') {
      S.sessionTokens = 0;
      home.tokens(null);
      home.step(null);
      S.stepInfo = null;
    }
    if (e.kind === 'new') {
      $('chat').replaceChildren();
      addSystemMsg('เริ่ม session ใหม่');
      onTodos([]);
    }
    if (e.kind === 'new-from-summary') addSystemMsg('เริ่ม session ใหม่จากสรุปแล้ว — สรุปจะถูกส่งเป็นบริบทพร้อมข้อความถัดไป');
    if (e.kind === 'init') term(`session ${e.sessionId} · model ${e.model} · ${e.tools} tools · mode ${e.permissionMode}`, 'info');
  });
  api.on('latency', (l) => {
    Object.assign(S.lat, Object.fromEntries(Object.entries(l).filter(([k, v]) => v != null && k !== 't0')));
    showLatency();
  });
  api.on('build:time', (b) => {
    buildClock.totalMs = b.totalMs;
    setBuildRunning(null);
    addSystemMsg(b.text);
  });
  api.on('turn:result', (r) => {
    const m = ensureAssistant();
    const u = r.usage || {};
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    S.sessionTokens += tokens + (u.output_tokens || 0);
    home.tokens(S.sessionTokens);
    $('cost').textContent = `tokens: in ${tokens.toLocaleString()} / out ${(u.output_tokens || 0).toLocaleString()} · $${(r.costUsd || 0).toFixed(4)}`;
    if (r.denials && r.denials.length) {
      m.append(el('div', { class: 'meta denials', text: `ถูกปฏิเสธรอบนี้: ${r.denials.map((d) => d.summary).join(' · ')}` }));
    }
    if (r.isError) m.append(el('div', { class: 'meta denials', text: `ผิดพลาด: ${r.resultText || r.subtype}` }));
    // tool / permission rows are not an answer: fall back to the result text when nothing else was said
    const said = [...m.childNodes].some((n) => (n.nodeType === 3 || !n.matches('.cv-tool, .cv-perm')) && n.textContent.trim());
    if (!said && r.resultText) appendText(r.resultText);
    if (r.latency) Object.assign(S.lat, { t1: r.latency.t1, t2: r.latency.t2, awaitingMs: r.latency.awaitingMs });
    showLatency();
    const slow = slowestStage();
    m.append(el('div', { class: 'meta', text: `${slow ? `ช้าสุด: ${slow[0]} ${fmtMs(slow[1])} · ` : ''}$${(r.costUsd || 0).toFixed(4)}` }));
    // Report once speech has (probably) started; t3 may be missing if nothing was spoken.
    setTimeout(() => {
      api.invoke('latency:report', S.lat).catch(() => {});
      recordLatency({ ...S.lat });
    }, 1500);
    if (r.isError) resultViewer.fail(r.resultText || 'โหลดไม่สำเร็จ');
    resultViewer.endTurn(S.replyText);
    orbBridge.set({ reply: (S.replyText || r.resultText || '').slice(0, 800), replyDone: true });
    curMsg = null;
    curText = null;
    taskStatus.finish(!r.isError);
    if (r.isError) sfx.error();
    else sfx.done();
  });
  api.on('tts:segment', ({ text }) => {
    if (S.muteThisTurn || S.voiceMuted) return;
    // results are on screen: say the short summary, not everything
    if (resultViewer.turn && resultViewer.turn.hadResult && S.turnSpokenChars > 320) return;
    S.turnSpokenChars = (S.turnSpokenChars || 0) + text.length;
    if (speaker.engine !== 'none') S.segTotal++;
    speaker.enqueue(text);
  });
  api.on('tts:announce', ({ text }) => { if (S.voiceMuted) return; speaker.enqueue(text); speaker.flush(); });
  api.on('tts:stop', () => speaker.stop());
  api.on('tts:flush', () => speaker.flush());
  api.on('approval:request', onApprovalRequest);
  api.on('approval:close', onApprovalClose);
  api.on('ptt', () => voiceButton());
  api.on('screen:watch', onWatchState);
  api.on('ptt:down', () => pttDown());
  api.on('ptt:up', () => pttUp());
  api.on('camera:cmd', ({ action }) => { if (action === 'on') cameraPanel.turnOn(); });
  api.on('install:progress', onInstallProgress);
}

// ---------------- DOM wiring ----------------

function wireDom() {
  $('btn-send').onclick = () => { const t = $('input').value; $('input').value = ''; talk.inputChanged(); slashMenu.paint(); send(t); };
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('btn-send').click();
    }
  });
  $('btn-stop').onclick = stopAll;
  $('watch-badge').onclick = (ev) => { if (ev.isTrusted) api.invoke('screen:watch', { op: 'stop' }).catch(failed); };
  $('btn-mic').onclick = () => voiceButton();
  $('btn-cam').onclick = toggleCamera;
  $('btn-look').onclick = () => {
    if (!vision.on) return notice('เปิดกล้องก่อนใช้ "ดูนี่"', 'warn', null, 3000);
    setLook(!S.lookArmed);
  };
  // Tab on the HUD opens the conversation popup (ui/conversation.js handles Tab / Esc / focus)
  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); $('btn-look').click(); }
    if (e.key === 'Escape' && S.speaking) speaker.stop();
  });
  $('btn-folder').onclick = async () => {
    const r = await api.invoke('folder:choose').catch((err) => notice(err.message, 'error'));
    if (r && r.ok) addSystemMsg(`โฟลเดอร์งาน: ${r.cwd}`);
  };
  $('home-model').onchange = async (e) => {
    const model = e.target.value;
    const r = await saveSetting({ model });
    if (!r.ok) return applyModel(S.settings.model);
    applyModel(model);
    notice(S.busy ? `จะเปลี่ยนเป็น ${model || 'DEFAULT'} หลังตอบรอบนี้เสร็จ` : `เปลี่ยนโมเดลเป็น ${model || 'DEFAULT'} แล้ว — บทสนทนาเดิมยังอยู่`, 'info', null, 4000);
  };
  $('perm-mode').onchange = async (e) => {
    const mode = e.target.value;
    if (mode === 'bypassPermissions') {
      // Only the Settings page (with typed confirmation) may enable bypass.
      applyMode(S.app ? S.app.permissionMode : 'default');
      openSettings('perm');
      notice('เปิด bypassPermissions ได้จากหน้า Settings โดยพิมพ์คำว่า "ยืนยัน" เท่านั้น', 'warn');
      return;
    }
    const r = await api.invoke('mode:set', { mode, confirmText: '' });
    if (!r.ok) {
      notice(r.errors.join(', '), 'warn');
      applyMode(S.settings.permissionMode);
    } else {
      S.settings = r.value;
      applyMode(mode);
      if (mode === 'acceptEdits') notice('acceptEdits: เปิด "ยืนยันข้อความเสียงก่อนส่ง" อัตโนมัติ', 'info', null, 4000);
    }
  };
  $('btn-teach').onclick = async () => {
    const on = !$('btn-teach').classList.contains('on');
    await api.invoke('session:teach-mode', on);
    addSystemMsg(on ? 'เปิดโหมดสอนประดิษฐ์ — JARVIS จะสอนทีละขั้น' : 'ปิดโหมดสอนประดิษฐ์');
  };
  $('btn-code').onclick = async () => {
    const on = !$('btn-code').classList.contains('on');
    await api.invoke('session:coding-mode', on);
    addSystemMsg(on ? 'เปิดโหมดโค้ด — JARVIS จะอ่านก่อนแก้ ตรวจผลก่อนสรุป และไม่อ่านโค้ดออกเสียง' : 'ปิดโหมดโค้ด');
  };
  wireAttachments();
  $('build-reset').onclick = async () => {
    if (buildClock.since) return notice('รอให้งานรอบนี้เสร็จก่อนเริ่มนับใหม่', 'warn', null, 3000);
    await api.invoke('build:reset');
    addSystemMsg('เริ่มนับเวลาสร้างระบบใหม่แล้ว');
  };
  $('btn-new').onclick = () => api.invoke('session:new');
  $('btn-new-summary').onclick = newFromSummary;
  // ⌨ Terminal: a panel inside the conversation popup (conversation.js); the
  // interactive Claude Code window opens from the panel's own button
  $('btn-sfx').onclick = async () => {
    const on = !S.settings.sfx;
    await saveSetting({ sfx: on });
    setSfxEnabled(on);
    $('btn-sfx').classList.toggle('on', on);
    $('btn-sfx').setAttribute('aria-pressed', String(on));
  };
  $('terminal-toggle').onclick = () => {
    const pre = $('terminal');
    pre.hidden = !pre.hidden;
    $('terminal-badge').hidden = true;
    $('terminal-badge').textContent = '';
    if (!pre.hidden) pre.scrollTop = pre.scrollHeight;
  };
  $('display-tabs').onclick = (e) => { if (e.target.dataset.tab) selectTab(e.target.dataset.tab); };
  $('ap-once').onclick = (e) => answerApproval('once', e);
  $('ap-always').onclick = (e) => answerApproval('always', e);
  $('ap-deny').onclick = (e) => answerApproval('deny', e);
  $('ap-deny-why').onclick = () => { $('ap-deny-reason-wrap').hidden = false; $('ap-deny-reason').focus(); };
  $('ap-deny-reason-send').onclick = (e) => answerApproval('deny-reason', e);
  $('btn-transcript-send').onclick = () => {
    $('transcript-confirm').hidden = true;
    send($('transcript-text').value, { fromVoice: true, latency: S.pendingTranscriptLatency || {} });
  };
  $('btn-transcript-cancel').onclick = () => { $('transcript-confirm').hidden = true; S.frameAtListenEnd = null; };
}

// ---------------- boot ----------------

(async function boot() {
  // Cinematic boot sequence; the rest of startup continues underneath it.
  const bootDone = runBoot({ home });
  sfx.bindUi(); // hover ticks + click blips on buttons and cards
  wireDom();
  wireEvents();
  wireSettings();
  wireHandsFree();
  // real spectra for the reactor segments (mic: hands-free engine or push-to-talk; voice: TTS output)
  home.bandsProvider = (k) => (k === 'tts' ? speaker.bands() : hands.active ? hfEngine.bands() : mic.bands());
  const init = await api.invoke('app:init');
  S.settings = init.settings;
  applyAppState(init.snapshot);
  setSfxEnabled(S.settings.sfx);
  applySpeaker();
  $('btn-sfx').classList.toggle('on', S.settings.sfx);
  $('btn-sfx').setAttribute('aria-pressed', String(!!S.settings.sfx));
  refreshState();
  if (!init.snapshot.cwd) addSystemMsg('สวัสดีครับ เลือกโฟลเดอร์โปรเจกต์ (📁) แล้วพิมพ์หรือกด 🎙 เพื่อเริ่มคุยกับ JARVIS');
  else addSystemMsg(`โฟลเดอร์งาน: ${init.snapshot.cwd}`);
  await setupTts();
  autoInstall();
  const { greet: greetAt } = await bootDone;
  await greetAt;
  greet();
  if (await api.invoke('camera:autostart')) cameraPanel.turnOn();
  // hands-free never starts by itself unless the user consented and asked for it
  if (S.settings.handsFreeAutoStart && S.settings.handsFreeConsent) toggleHandsFree(true);
})();

/**
 * Voice greeting after the ready chime (ON by default, can be turned off in settings).
 * Skipped silently when turned off in settings or when no Thai TTS voice exists.
 */
function greet() {
  if (!sfx.greeting) return;
  const text = greetingLine();
  addSystemMsg(text);
  if (speaker.engine === 'none' || speaker.muted) return;
  // fx: light robotic color (ring mod + highpass + reverb) on the Windows voice
  speaker.enqueue(text, { rate: 0.95, pitch: 0.9, fx: true });
  speaker.flush();
}
