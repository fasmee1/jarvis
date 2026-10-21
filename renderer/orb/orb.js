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

// ---------- the reactor's static drawing, scaled to the orb (viewBox 100) ----------
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const polar = (r, deg) => [50 + r * Math.sin((deg * Math.PI) / 180), 50 - r * Math.cos((deg * Math.PI) / 180)];

// tick ring: 5° minor, 45° major, 90° longest
{
  let d = '';
  for (let deg = 0; deg < 360; deg += 5) {
    const len = deg % 90 === 0 ? 2.2 : deg % 45 === 0 ? 1.7 : 0.85;
    const [x0, y0] = polar(40.6, deg);
    const [x1, y1] = polar(40.6 + len, deg);
    d += `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  $('ticks').append(sv('path', { d }));
}

// connector nodes at the HUD's angles (first one in the accent colour)
{
  [310, 50, 334, 26, 270, 90, 225, 135].forEach((deg, i) => {
    const [x, y] = polar(45.9, deg);
    $('hud').append(sv('circle', { class: i === 0 ? 'node on' : 'node', cx: x.toFixed(2), cy: y.toFixed(2), r: 0.9 }));
    $('hud').append(sv('circle', { class: 'node-ring', cx: x.toFixed(2), cy: y.toFixed(2), r: 1.8, fill: 'none' }));
  });
}

// wireframe icosahedron (subdivided once: 42 vertices, 120 edges). Turns about a vertex axis, so 72° is a
// full period: 12 keyframes of the path morph into each other and repeat, with no per-frame script.
const icoAnim = (() => {
  const T = (1 + Math.sqrt(5)) / 2;
  const norm = (p) => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; };
  const verts = [[-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0], [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T], [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1]].map(norm);
  const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const cache = new Map();
  const mid = (a, b) => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (!cache.has(k)) { verts.push(norm([verts[a][0] + verts[b][0], verts[a][1] + verts[b][1], verts[a][2] + verts[b][2]])); cache.set(k, verts.length - 1); }
    return cache.get(k);
  };
  const edges = new Set();
  const add = (a, b) => edges.add(a < b ? a * 100 + b : b * 100 + a);
  for (const [a, b, c] of faces) {
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    for (const [x, y, z] of [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]) { add(x, y); add(y, z); add(z, x); }
  }
  const list = [...edges].map((e) => [Math.floor(e / 100), e % 100]);
  const axis = verts[0];
  const rodrigues = (p, th) => {
    const c = Math.cos(th), s = Math.sin(th);
    const dot = axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2];
    const cr = [axis[1] * p[2] - axis[2] * p[1], axis[2] * p[0] - axis[0] * p[2], axis[0] * p[1] - axis[1] * p[0]];
    return [0, 1, 2].map((i) => p[i] * c + cr[i] * s + axis[i] * dot * (1 - c));
  };
  const R = 18.4; // 1.32 of the 3.3 hairline, like the HUD
  const ay = 0.3, ax = 0.45;
  const view = ([x, y, z]) => {
    const x1 = x * Math.cos(ay) + z * Math.sin(ay);
    const z1 = -x * Math.sin(ay) + z * Math.cos(ay);
    return [50 + x1 * R, 50 + (y * Math.cos(ax) - z1 * Math.sin(ax)) * R];
  };
  const FR = 12;
  const frames = [];
  for (let f = 0; f <= FR; f++) {
    const th = (f / FR) * ((Math.PI * 2) / 5);
    const pts = verts.map((v) => view(rodrigues(v, th)));
    frames.push(list.map(([i, j]) => `M${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}L${pts[j][0].toFixed(1)} ${pts[j][1].toFixed(1)}`).join(''));
  }
  const path = $('ico').querySelector('path');
  path.setAttribute('d', frames[0]);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const an = sv('animate', { attributeName: 'd', values: frames.join(';'), dur: '10s', repeatCount: 'indefinite', calcMode: 'linear' });
  path.append(an);
  return an;
})();
/** The icosahedron only turns while the orb is shown and not faded. */
function syncIco() {
  const svg = $('ico');
  if (!icoAnim) return;
  if (!shown || O.classList.contains('faded') || O.classList.contains('muted')) svg.pauseAnimations();
  else svg.unpauseAnimations();
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
  syncIco();
  if (!autoFade || !shown) return;
  if (st.state !== 'idle' || hover || mode || dragging) return;
  later('fade', FADE_MS, () => { O.classList.add('faded'); syncIco(); });
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
