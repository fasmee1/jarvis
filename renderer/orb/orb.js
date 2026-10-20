// Floating Orb page. Mirrors the main window's state (sent through main) and
// sends commands back. No audio runs here.

const orb = window.orb;
const $ = (id) => document.getElementById(id);
const O = $('orb');
const P = $('panel');
const card = $('card');

const REPLY_W = 320;
const REPLY_H = 236; // room for 2 lines of transcript + 4 of reply + the row + the text box
const HIDE_MS = 6000; // bubble auto-hide after JARVIS finishes
const TIP_MS = 600;
const ERR_MS = 4500;
const FADE_MS = 10000;
const CLICK_MS = 240; // single click waits this long for a double click
const DRAG_PX = 5;
const TIP_TEXT = 'คลิกเพื่อพูด · ดับเบิลคลิกเพื่อเปิด JARVIS';

const st = { state: 'idle', hf: false, micOff: false, voiceMuted: false, transcript: '', reply: '', replyDone: false, result: false, error: '', errorId: 0, typeId: 0, attention: '' };
let autoFade = false;
let shown = false;

// what the bubble should show: input > error > reply > hover tip
const want = { reply: false, error: '', tip: false, input: false };
let mode = null; // the bubble currently on screen: null | 'tip' | 'error' | 'reply'
let dragging = false;
let hover = null; // 'orb' | 'card' | null
let lastErrorId = 0;
let lastTypeId = 0;
const timers = {};
const later = (name, ms, fn) => { clearTimeout(timers[name]); timers[name] = setTimeout(fn, ms); };
const cancel = (name) => { clearTimeout(timers[name]); timers[name] = null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// bezel scale: 72 ticks, every 6th one long
{
  const NS = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(NS, 'path');
  let d = '';
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const r0 = i % 6 === 0 ? 43.2 : 44.6;
    const c = Math.cos(a), s = Math.sin(a);
    d += `M${(50 + r0 * c).toFixed(2)} ${(50 + r0 * s).toFixed(2)}L${(50 + 46.6 * c).toFixed(2)} ${(50 + 46.6 * s).toFixed(2)}`;
  }
  g.setAttribute('d', d);
  $('ticks').append(g);
}

// ---------- layout from main ----------

function applyLayout(l) {
  if (!l) return;
  O.style.left = `${l.orb.x}px`;
  O.style.top = `${l.orb.y}px`;
  if (l.panel) {
    Object.assign(P.style, { left: `${l.panel.x}px`, top: `${l.panel.y}px`, width: `${l.panel.w}px`, height: `${l.panel.h}px` });
    P.classList.toggle('h-left', l.dir.h === 'left');
    P.classList.toggle('h-right', l.dir.h === 'right');
    P.classList.toggle('v-down', l.dir.v === 'down');
    P.classList.toggle('v-up', l.dir.v === 'up');
  }
}
orb.on('orb:layout', applyLayout);

// ---------- bubble ----------

function desired() {
  if (!shown || dragging) return null;
  if (want.input || want.reply) return 'reply';
  if (want.error) return 'error';
  if (want.tip) return 'tip';
  return null;
}

let busy = false;
let again = false;
/** Serialized: one open / close / switch at a time, always toward the latest wish. */
async function syncPanel() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    do { again = false; await step(); } while (again);
  } finally {
    busy = false;
  }
}

async function step() {
  const next = desired();
  if (next === mode) { render(); return; }
  if (mode) {
    P.classList.remove('show');
    await sleep(170);
  }
  if (!next) {
    mode = null;
    P.hidden = true;
    applyLayout(await orb.invoke('orb:panel', null));
    return;
  }
  mode = next;
  render();
  P.classList.toggle('tip', next !== 'reply');
  const box = next === 'reply' ? { w: REPLY_W, h: REPLY_H } : measure();
  applyLayout(await orb.invoke('orb:panel', box));
  P.hidden = false;
  await frame();
  if (mode === next) P.classList.add('show');
}

/** Size of a one-line tip / short error card. */
function measure() {
  P.style.visibility = 'hidden';
  P.style.width = `${REPLY_W}px`;
  P.style.height = '400px';
  P.hidden = false;
  const w = Math.min(REPLY_W, Math.ceil(card.offsetWidth) + 1);
  const h = Math.ceil(card.offsetHeight) + 1;
  P.hidden = true;
  P.style.visibility = '';
  return { w, h };
}

function show(el, text) {
  el.hidden = !text;
  if (text) el.textContent = text;
}

function render() {
  card.classList.toggle('tip-mode', mode === 'tip' || mode === 'error');
  show($('tip'), mode === 'tip' ? (st.state === 'error' && st.error ? st.error : TIP_TEXT) : '');
  show($('err'), mode === 'error' ? want.error : '');
  const reply = mode === 'reply';
  show($('you'), reply ? st.transcript : '');
  let text = st.reply;
  if (!text && st.attention) text = st.attention;
  if (!text && st.state === 'thinking') text = '…';
  show($('reply'), reply ? text : '');
  $('row').hidden = !reply;
  $('chip').hidden = !st.result;
  $('form').hidden = !(reply && want.input);
  $('kb').classList.toggle('on', want.input);
}

// thin frame + corner accents (top-left, bottom-right), like the HUD cards
new ResizeObserver(() => {
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const svg = card.querySelector('.frame');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const c = 6;
  const i = 0.75;
  const arm = Math.min(16, w * 0.2, h * 0.3);
  svg.querySelector('.base').setAttribute('d', `M${c + i} ${i} L${w - i} ${i} L${w - i} ${h - c - i} L${w - c - i} ${h - i} L${i} ${h - i} L${i} ${c + i} Z`);
  svg.querySelector('.acc').setAttribute('d', `M${i} ${c + i + arm} L${i} ${c + i} L${c + i} ${i} L${c + i + arm} ${i} M${w - i} ${h - c - i - arm} L${w - i} ${h - c - i} L${w - c - i} ${h - i} L${w - c - i - arm} ${h - i}`);
}).observe(card);

/** Auto-hide 6 s after JARVIS is done (idle again); hovering or typing keeps it open. */
function armHide() {
  cancel('hide');
  if (!want.reply || hover || want.input) return;
  if (!['idle', 'muted', 'error'].includes(st.state)) return;
  later('hide', HIDE_MS, () => { want.reply = false; syncPanel(); });
}

// ---------- state ----------

function applyState() {
  const s = st.state;
  for (const k of ['idle', 'listening', 'thinking', 'speaking', 'muted', 'error']) O.classList.toggle(k, s === k);
  if (s !== 'listening' && s !== 'speaking') O.style.setProperty('--lv', '0');
  O.classList.toggle('active', s !== 'idle' || !!mode);
  refreshFade();
  armHide();
  syncPanel();
}

orb.on('orb:state', (p) => {
  const fresh = (k) => k in p && p[k] && p[k] !== st[k];
  if (fresh('transcript') || fresh('reply') || fresh('attention')) want.reply = true;
  Object.assign(st, p);
  if (st.errorId && st.errorId !== lastErrorId && st.error) {
    lastErrorId = st.errorId;
    O.classList.remove('pulsing');
    void O.offsetWidth; // restart the pulse
    O.classList.add('pulsing');
    later('pulse', 1300, () => O.classList.remove('pulsing'));
    if (!want.reply) {
      want.error = st.error;
      later('err', ERR_MS, () => { want.error = ''; syncPanel(); });
    }
  }
  applyState();
  // the mic can't be used (none plugged in / denied / off): open the text box so the user can type right away
  checkTypeSignal();
});

// typeId is a timestamp: it is only consumed while the orb is on screen, and a stale one
// (replayed state after a reload) is ignored instead of re-opening the box
function checkTypeSignal() {
  if (!st.typeId || st.typeId === lastTypeId || !shown) return;
  lastTypeId = st.typeId;
  if (Date.now() - st.typeId < 5000 && !want.input) openInput();
}

orb.on('orb:level', (v) => {
  if (st.state === 'listening' || st.state === 'speaking') O.style.setProperty('--lv', String(Math.max(0, Math.min(1, Number(v) || 0)).toFixed(3)));
});

orb.on('orb:config', (c) => {
  document.documentElement.style.setProperty('--s', `${c.size}px`);
  autoFade = !!c.autoFade;
  refreshFade();
});

orb.on('orb:visible', ({ on }) => {
  shown = on;
  document.body.classList.toggle('shown', on);
  if (!on) {
    want.reply = false;
    want.tip = false;
    want.error = '';
    if (want.input) closeInput();
  }
  refreshFade();
  syncPanel();
  if (on) checkTypeSignal(); // a "type instead" signal that arrived while the orb was hidden
});

// ---------- idle fade (animations pause while faded) ----------

function refreshFade() {
  O.classList.remove('faded');
  cancel('fade');
  if (!autoFade || !shown) return;
  if (st.state !== 'idle' || hover || mode || dragging) return;
  later('fade', FADE_MS, () => O.classList.add('faded'));
}

// ---------- click-through: only the circle and the bubble take the mouse ----------

let hit = false;
function setHit(on) {
  if (on === hit) return;
  hit = on;
  orb.invoke('orb:hit', on).catch(() => {});
}

function hitAt(x, y) {
  const r = O.getBoundingClientRect();
  if (Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) <= r.width / 2 + 2) return 'orb';
  if (!P.hidden) {
    const c = card.getBoundingClientRect();
    if (x >= c.left && x <= c.right && y >= c.top && y <= c.bottom) return 'card';
  }
  return null;
}

function setHover(h) {
  if (h === hover) return;
  const wasOrb = hover === 'orb';
  hover = h;
  O.classList.toggle('hover', h === 'orb');
  if (h === 'orb' && !wasOrb && !dragging) later('tip', TIP_MS, () => { if (hover === 'orb' && !dragging) { want.tip = true; syncPanel(); } });
  if (h !== 'orb') {
    cancel('tip');
    if (want.tip) { want.tip = false; syncPanel(); }
  }
  refreshFade();
  armHide();
}

document.addEventListener('mousemove', (e) => {
  if (dragging) return;
  const h = hitAt(e.clientX, e.clientY);
  setHit(!!h);
  setHover(h);
});
document.addEventListener('mouseout', (e) => {
  if (e.relatedTarget || dragging) return;
  setHit(false);
  setHover(null);
});

// ---------- click / double-click / drag ----------

let down = null;
let moveQueued = false;

O.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
  O.setPointerCapture(e.pointerId);
});

O.addEventListener('pointermove', (e) => {
  if (!down) return;
  if (!dragging && Math.hypot(e.screenX - down.x, e.screenY - down.y) > DRAG_PX) startDrag();
  if (dragging && !moveQueued) {
    // one window move per display frame
    moveQueued = true;
    requestAnimationFrame(() => { moveQueued = false; if (dragging) orb.invoke('orb:drag', 'move').catch(() => {}); });
  }
});

function startDrag() {
  dragging = true;
  cancel('tip');
  want.tip = false;
  // main collapses the window to the orb before it moves
  P.classList.remove('show');
  P.hidden = true;
  mode = null;
  O.classList.add('dragging');
  document.body.classList.add('grabbing');
  refreshFade();
  orb.invoke('orb:drag', 'start').catch(() => {});
}

function endPointer(e) {
  if (!down) return;
  down = null;
  try { O.releasePointerCapture(e.pointerId); } catch { /* released */ }
  if (dragging) {
    dragging = false;
    O.classList.remove('dragging');
    document.body.classList.remove('grabbing');
    orb.invoke('orb:drag', 'end').catch(() => {});
    refreshFade();
    syncPanel();
    return;
  }
  if (e.type === 'pointerup') click();
}
O.addEventListener('pointerup', endPointer);
O.addEventListener('pointercancel', endPointer);

let clickTimer = null;
function click() {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    orb.invoke('orb:cmd', { action: 'open-main' }).catch(() => {});
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    orb.invoke('orb:cmd', { action: 'toggle-listen' }).catch(() => {});
  }, CLICK_MS);
}

O.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  orb.invoke('orb:menu').catch(() => {});
});
O.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); orb.invoke('orb:cmd', { action: 'toggle-listen' }).catch(() => {}); }
});

// ---------- bubble actions ----------

$('more').onclick = () => orb.invoke('orb:cmd', { action: 'open-talk' }).catch(() => {}); // restores JARVIS straight into the conversation
$('chip').onclick = () => orb.invoke('orb:cmd', { action: 'open-result' }).catch(() => {});
$('kb').onclick = () => (want.input ? closeInput() : openInput());
$('kb').addEventListener('mousedown', (e) => e.preventDefault()); // keep the text box focused, so ⌨ toggles

async function openInput() {
  want.input = true;
  want.reply = true;
  cancel('hide');
  render();
  await orb.invoke('orb:focusable', true).catch(() => {});
  $('text').focus();
}

function closeInput() {
  if (!want.input) return;
  want.input = false;
  $('text').blur();
  orb.invoke('orb:focusable', false).catch(() => {});
  render();
  armHide();
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  orb.invoke('orb:cmd', { action: 'send-text', text }).catch(() => {});
  closeInput();
});
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeInput(); }
});
$('text').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('text')) closeInput(); }, 0));

orb.invoke('orb:ready').catch(() => {});
