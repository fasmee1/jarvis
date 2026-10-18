// Orbit cards, leader lines and framing marks for the home instrument.
// Cards only ever show real values; unknown values show a dim "—" + one short
// Thai line, in exactly the same layout as a real value.

import { cardRect, leaderPoints, nodePoint, CORE } from './layout.js';

const NS = 'http://www.w3.org/2000/svg';
const CUT = 6; // one subtle chamfer, top-left + bottom-right on every card
const ARM = 18; // corner accent arm length

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Lucide-style icons (24×24, drawn with a 1.5px stroke).
export const ICONS = {
  reply: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3',
  tts: 'M11 5 6 9H2v6h4l5 4z M15.5 8.5a5 5 0 0 1 0 7 M19 5a10 10 0 0 1 0 14',
  latency: 'M12 14l4-4 M3.34 19a10 10 0 1 1 17.32 0',
  step: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.3 7 12 12l8.7-5 M12 22V12',
  tokens: 'M12 3c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3z M3 6v12c0 1.66 4.03 3 9 3s9-1.34 9-3V6 M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3',
  elapsed: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M12 6v6l4 2',
  camera: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z M12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  x: 'M18 6 6 18 M6 6l12 12',
  chev: 'm9 18 6-6-6-6',
};

/** A 24×24 stroke icon as an <svg>. */
export function icon(name, cls) {
  const s = svgEl('svg', { class: cls || 'ico', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  s.append(svgEl('path', { d: ICONS[name] }));
  return s;
}

const TIPS = {
  reply: 'คำตอบล่าสุดของ JARVIS — คลิกเพื่อเปิดหน้า TALK · เส้นด้านล่างคือจำนวนช่วงที่พูดไปแล้ว / ทั้งหมด',
  mic: 'ระดับเสียงจากไมโครโฟนจริง (dBFS) — เป็นสีส้มขณะกำลังฟัง',
  tts: 'ระดับเสียงพูดของ JARVIS ที่กำลังเล่นอยู่จริง (%)',
  latency: 'เวลาตั้งแต่กดส่งจนเริ่มพูดประโยคแรก (t3−t0) — กราฟ 13 รอบล่าสุด · แท่งจางคือรอบที่ไม่มีเสียง จึงใช้เวลาถึงข้อความแรก (t2−t0) · คลิกเพื่อดู DIAGNOSTICS',
  step: 'ขั้นตอนปัจจุบันจากโหมดสอนประดิษฐ์ (บล็อก jarvis-steps ล่าสุด) — คลิกเพื่อเปิด MAKER',
  tokens: 'tokens รวมของ session นี้ (input + cache + output จากทุกรอบ) — คลิกเพื่อดู DIAGNOSTICS',
  elapsed: 'เวลาที่อยู่ในสถานะปัจจุบัน วงแหวนครบรอบทุก 60 วินาที',
  camera: 'กล้อง — เปิดเองด้วยปุ่มหรือ Ctrl+Shift+C เท่านั้น ไม่เปิดอัตโนมัติ · ภาพจะส่งให้ Claude เฉพาะตอนกด "ดูนี่" หรือพูดคำเรียกให้ดู',
};

export const NAMES = { reply: 'Last Reply', mic: 'Mic', tts: 'TTS', latency: 'Latency', step: 'Step', tokens: 'Tokens', elapsed: 'Elapsed', camera: 'Camera' };

const OPEN = { camera: null, reply: 'talk', latency: 'diagnostics', step: 'maker', tokens: 'diagnostics', mic: 'talk', tts: 'settings', elapsed: 'activity' };

function framePath(w, hh, cut, size = CUT, pad = 6) {
  const c = (k) => (cut.includes(k) ? size : 0);
  const pts = [
    [c('tl'), 0], [w - c('tr'), 0], [w, c('tr')], [w, hh - c('br')], [w - c('br'), hh], [c('bl'), hh], [0, hh - c('bl')], [0, c('tl')],
  ];
  return 'M' + pts.map((p) => `${p[0] + pad},${p[1] + pad}`).join(' L') + ' Z';
}

/**
 * Card border as an SVG overlay: a 1px outline all round plus two refined
 * corner accents (top-left and bottom-right) that follow the chamfer.
 * @param {SVGSVGElement} svg  overlay covering the box plus `pad` on every side
 */
export function drawFrame(svg, W0, H0, cut, { size = CUT, pad = 6, arm = ARM } = {}) {
  svg.setAttribute('viewBox', `0 0 ${W0 + pad * 2} ${H0 + pad * 2}`);
  if (!svg.querySelector('.base')) {
    svg.replaceChildren(svgEl('path', { class: 'base' }), svgEl('g', { class: 'acc acc-tl' }), svgEl('g', { class: 'acc acc-br' }));
  }
  // Border and accents share one centreline, inset by half the accent stroke,
  // so both sit exactly on the card's edge and nothing pokes outside it.
  const i = 0.75;
  const w = W0 - i * 2;
  const hh = H0 - i * 2;
  const o = pad + i;
  svg.querySelector('.base').setAttribute('d', framePath(w, hh, cut, size, o));
  const P = (x, y) => [x + o, y + o];
  const f = (n) => n.toFixed(1);
  const L = (pts) => 'M' + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(' L');
  const tl = cut.includes('tl') ? size : 0;
  const br = cut.includes('br') ? size : 0;
  const ax = Math.min(arm, w * 0.2);
  const ay = Math.min(arm, hh * 0.2);
  svg.querySelector('.acc-tl').replaceChildren(svgEl('path', { d: L([P(0, tl + ay), P(0, tl), P(tl, 0), P(tl + ax, 0)]) }));
  svg.querySelector('.acc-br').replaceChildren(svgEl('path', { d: L([P(w, hh - br - ay), P(w, hh - br), P(w - br, hh), P(w - br - ax, hh)]) }));
}

function clipPoly(w, hh, cut) {
  const c = (k) => (cut.includes(k) ? CUT : 0);
  return `polygon(${c('tl')}px 0, ${w - c('tr')}px 0, ${w}px ${c('tr')}px, ${w}px ${hh - c('br')}px, ${w - c('br')}px ${hh}px, ${c('bl')}px ${hh}px, 0 ${hh - c('bl')}px, 0 ${c('tl')}px)`;
}

export class Cards {
  constructor({ container, leaders, framing, core, tip, onOpen, onClose }) {
    this.container = container;
    this.leadersSvg = leaders;
    this.framingSvg = framing;
    this.core = core;
    this.tipEl = tip;
    this.onOpen = onOpen;
    this.onClose = onClose || (() => {});
    this.onBuilt = []; // callbacks run after every (re)build
    this.reactor = { x: 0, y: 0, s: 1, r: 0 }; // live transform of the reactor group (camera mode)
    this.cards = new Map();
    this.pulses = [];
    this.lastPulse = 0;
    this.hovered = null;
    this.waveHist = new Float32Array(160);
    this._framing();
  }

  /**
   * Four thin, short corner brackets — nothing else frames the screen. They sit
   * in window space (like the menu button), so they never collide with it.
   */
  _framing() {
    const home = document.getElementById('home');
    for (const c of ['tl', 'tr', 'br', 'bl']) {
      const b = h('i', `corner-brk ${c}`);
      b.dataset.corner = c;
      b.setAttribute('aria-hidden', 'true');
      home.append(b);
    }
  }

  build(layout) {
    this.container.replaceChildren();
    this.leadersSvg.replaceChildren();
    this.cards.clear();
    this.layout = layout;
    for (const def of layout.cards) {
      const el = h('div', `card card-${def.id} card-${def.size === 'small' ? 'small' : def.size}`);
      el.dataset.id = def.id;
      if (def.hidden) el.classList.add('hidden-card');
      if (def.compact) el.classList.add('compact');
      const fill = h('div', 'fill');
      const frame = svgEl('svg', { class: 'frame', 'aria-hidden': 'true' });
      this._shape(el, fill, frame, def);
      const inner = h('div', 'in');
      const head = h('div', 'head');
      const name = NAMES[def.id];
      const close = h('button', 'card-x');
      close.type = 'button';
      close.setAttribute('aria-label', `ปิดการ์ด ${name}`);
      close.title = `ปิดการ์ด ${name} — เก็บเข้าแกนกลาง`;
      close.append(icon('x', 'x-ico'));
      close.addEventListener('click', (e) => { e.stopPropagation(); this.onClose(def.id); });
      head.append(icon(def.id), h('span', 'lbl', name));
      if (def.id === 'mic') {
        const tag = h('span', 'hf-tag', 'HANDS-FREE');
        tag.hidden = !this.micHandsFree;
        head.append(tag);
      }
      head.append(close);
      inner.append(head, h('div', 'rule'));
      el.append(fill, frame, inner);
      const parts = this[`_body_${def.id}`](inner, def);
      el.addEventListener('mouseenter', (e) => this._hover(def, e));
      el.addEventListener('mousemove', (e) => this._moveTip(e));
      el.addEventListener('mouseleave', () => this._hover(null));
      el.addEventListener('click', () => { if (OPEN[def.id]) this.onOpen(OPEN[def.id]); });
      this.container.append(el);

      // leader line + a small end dot at the card
      const pl = svgEl('polyline', { class: 'ld', pathLength: 1 });
      const dot = svgEl('circle', { class: 'dot', r: 2.5 });
      this.leadersSvg.append(pl, dot);
      this.cards.set(def.id, { def, el, parts, pl, dot, last: {} });
    }
    this.core.setNodes(layout.cards.filter((c) => !c.hidden).map((c) => c.node));
    this.layoutLeaders();
    for (const fn of this.onBuilt) fn();
  }

  /** Size the card and (re)draw its frame for the current rect. */
  _shape(el, fill, frame, def) {
    const r = cardRect(def);
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    fill.style.clipPath = clipPoly(r.w, r.h, ['tl', 'br']);
    drawFrame(frame, r.w, r.h, ['tl', 'br']);
  }

  /** Change a card's rect at runtime (px in design space); leaders follow automatically. */
  setCardRect(id, px, anchor) {
    const c = this.cards.get(id);
    if (!c) return;
    c.def.px = px;
    if (anchor) c.def.anchor = anchor;
    this._shape(c.el, c.el.querySelector('.fill'), c.el.querySelector('.frame'), c.def);
  }

  /** Keep a node lit (e.g. the camera node while the camera is live). */
  setNodeLive(id, on) {
    this.live = this.live || new Set();
    if (on) this.live.add(id);
    else this.live.delete(id);
  }

  // ----- card bodies -----
  _body_camera(inner) {
    // The camera controller (ui/camera-panel.js) fills this in.
    const host = h('div', 'cam-host');
    inner.append(host);
    return { host };
  }

  _body_reply(inner) {
    const q = h('div', 'quote na', 'ยังไม่มีคำตอบ · พูดหรือพิมพ์เพื่อเริ่ม');
    const wave = h('canvas', 'wave');
    wave.width = 760;
    wave.height = 64;
    const foot = h('div', 'foot');
    const seg = this._meter();
    const cnt = h('span', 'mono', '—');
    foot.append(seg, cnt);
    inner.append(q, wave, foot);
    return { q, wave, seg, cnt };
  }
  _body_mic(inner) {
    return this._smallBody(inner, 'ไมค์ปิดอยู่ · Ctrl+Space', this._meter());
  }
  _body_tts(inner) {
    return this._smallBody(inner, 'ยังไม่ได้พูด', this._dots(10));
  }
  _smallBody(inner, hintText, seg) {
    const b = h('div', 'body');
    const val = h('div', 'val na', '—');
    const hint = h('div', 'hint', hintText);
    const row = h('div', 'vrow');
    row.append(val, hint);
    b.append(row, seg);
    inner.append(b);
    return { val, seg, hint };
  }
  _body_latency(inner) {
    const chart = h('div', 'chart');
    const bars = [];
    for (let i = 0; i < 8; i++) {
      const b = h('i', 'empty');
      bars.push(b);
      chart.append(b);
    }
    const avg = h('div', 'avg');
    avg.hidden = true;
    chart.append(avg);
    const row = h('div', 'lrow');
    const meta = h('div', 'meta', '0 / 8 TURNS');
    const val = h('div', 'val na', '—');
    row.append(meta, val);
    inner.append(chart, row);
    return { bars, meta, val, avg };
  }
  _body_step(inner) {
    const b = h('div', 'body');
    const val = h('div', 'val na', '—');
    const sub = h('div', 'sub', 'ยังไม่มีโปรเจกต์');
    const seg = this._meter();
    seg.classList.add('short');
    b.append(val, sub, icon('chev', 'chev'), seg);
    inner.append(b);
    return { val, sub, seg };
  }
  _body_tokens(inner) {
    const b = h('div', 'body');
    const val = h('div', 'val na', '—');
    const hint = h('div', 'hint', 'ยังไม่มีรอบสนทนา');
    const seg = this._dots(8);
    b.append(val, hint, seg);
    inner.append(b);
    return { val, hint, seg };
  }
  _body_elapsed(inner) {
    const b = h('div', 'body');
    const val = h('div', 'val', '0.0');
    const ring = svgEl('svg', { class: 'ring', viewBox: '0 0 40 40' });
    ring.append(svgEl('circle', { class: 'bg', cx: 20, cy: 20, r: 17 }));
    const fg = svgEl('circle', { class: 'fg', cx: 20, cy: 20, r: 17, 'stroke-dasharray': `0 ${2 * Math.PI * 17}` });
    ring.append(fg);
    b.append(val, ring);
    inner.append(b);
    return { val, fg };
  }

  /** A single thin 2px progress line. */
  _meter() {
    return h('div', 'meter');
  }
  /** A short row of small dots (8–10 at most). */
  _dots(n) {
    const s = h('div', 'dots');
    for (let i = 0; i < n; i++) s.append(h('i'));
    return s;
  }
  _seg(seg, frac) {
    const p = Math.max(0, Math.min(1, frac || 0));
    if (seg.classList.contains('meter')) {
      seg.style.setProperty('--p', p.toFixed(3));
      return;
    }
    const items = seg.children;
    const on = Math.round(p * items.length);
    for (let i = 0; i < items.length; i++) items[i].classList.toggle('on', i < on);
  }

  // ----- value plumbing -----
  /** live: a continuously streaming value (voice level) — no update pulse. */
  _setVal(id, el, text, unit, { na = false, hot = false, live = false } = {}) {
    const c = this.cards.get(id);
    if (!c) return;
    const key = `${text}|${unit}|${na}|${hot}`;
    if (c.last[el.dataset.k || 'v'] === key) return;
    const changed = c.last[el.dataset.k || 'v'] !== undefined;
    c.last[el.dataset.k || 'v'] = key;
    el.className = `val${na ? ' na' : ''}${hot ? ' hot' : ''}`;
    el.replaceChildren();
    el.append(h('span', changed && !hot ? 'roll' : '', text));
    if (unit) el.append(h('span', 'u', unit));
    if (changed && !na && !hot && !live) this._updated(c);
  }

  /** Data changed in a card: its node pulses and one small cyan dot runs along its connector. */
  _updated(c) {
    const now = performance.now();
    if (now - (c.pulsedAt || 0) < 1200) return; // live values (mic, voice) must not stream pulses
    c.pulsedAt = now;
    this.core.flashNode(c.def.node);
    this.pulse(c.def.id, true);
  }

  setReply(text, { spoken = 0, total = 0 } = {}) {
    const c = this.cards.get('reply');
    if (!c) return;
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (t && c.last.q !== t) {
      c.last.q = t;
      c.parts.q.className = 'quote';
      c.parts.q.textContent = `“${t}”`;
      this._updated(c);
    }
    if (total) {
      this._seg(c.parts.seg, spoken / total);
      c.parts.cnt.textContent = `${spoken}/${total}`;
    }
  }

  /** Hands-free on: a small HANDS-FREE label; the dB value shows only while a command records. */
  setMicMode(handsFree) {
    this.micHandsFree = !!handsFree;
    const c = this.cards.get('mic');
    if (!c) return;
    const tag = c.el.querySelector('.hf-tag');
    if (tag) tag.hidden = !this.micHandsFree;
  }

  setMic(db, { listening = false, active = false } = {}) {
    const c = this.cards.get('mic');
    if (!c) return;
    if (!active || db == null) {
      this._setVal('mic', c.parts.val, '—', 'dB', { na: true });
      c.parts.hint.textContent = this.micHandsFree ? 'พูด “จาร์วิส” เพื่อเรียก' : 'ไมค์ปิดอยู่ · Ctrl+Space';
      this._seg(c.parts.seg, 0);
      c.parts.seg.classList.remove('hot');
      return;
    }
    const v = Math.max(-90, Math.round(db));
    this._setVal('mic', c.parts.val, String(v), 'dB', { hot: true });
    c.parts.hint.textContent = listening ? 'กำลังฟัง' : '';
    c.parts.seg.classList.add('hot');
    this._seg(c.parts.seg, (v + 60) / 60);
  }

  setTts(pct, { speaking = false, engine = 'none' } = {}) {
    const c = this.cards.get('tts');
    if (!c) return;
    if (engine === 'none') {
      this._setVal('tts', c.parts.val, '—', '%', { na: true });
      c.parts.hint.textContent = 'ไม่มีเสียงพูดภาษาไทยในเครื่อง';
      this._seg(c.parts.seg, 0);
      return;
    }
    if (pct == null) {
      this._setVal('tts', c.parts.val, '—', '%', { na: true });
      c.parts.hint.textContent = speaking ? 'เสียงระบบไม่ให้ค่าระดับเสียง' : 'ยังไม่ได้พูด';
      this._seg(c.parts.seg, 0);
      return;
    }
    this._setVal('tts', c.parts.val, String(Math.round(pct)), '%', { live: true });
    c.parts.hint.textContent = speaking ? 'กำลังพูด' : '';
    this._seg(c.parts.seg, pct / 100);
  }

  /**
   * Always 8 bar slots (oldest → latest). Heights are relative to the largest
   * visible bar, so one value still reads as a proper bar; a faint dashed line
   * marks the average.
   * @param {{ms:number, kind:'speech'|'text'}[]} hist last turns (oldest first)
   */
  setLatency(hist) {
    const c = this.cards.get('latency');
    if (!c) return;
    const last8 = hist.slice(-8);
    const max = Math.max(1, ...last8.map((x) => x.ms));
    const PAD = 8; // highest bar stops just short of the chart top
    const pct = (ms) => Math.max(6, (ms / max) * (100 - PAD));
    c.parts.bars.forEach((b, i) => {
      const it = last8[i - (8 - last8.length)];
      if (!it) {
        b.className = 'empty';
        b.style.height = '';
        return;
      }
      b.className = `${it.kind === 'text' ? 'text' : ''}${i === 7 ? ' last' : ''}`;
      b.style.height = `${pct(it.ms)}%`;
    });
    const avg = c.parts.avg;
    avg.hidden = last8.length < 2;
    if (last8.length >= 2) avg.style.bottom = `${pct(last8.reduce((a, x) => a + x.ms, 0) / last8.length)}%`;
    c.parts.meta.textContent = `${last8.length} / 8 TURNS`;
    const cur = last8[last8.length - 1];
    if (!cur) this._setVal('latency', c.parts.val, '—', 's', { na: true });
    else this._setVal('latency', c.parts.val, (cur.ms / 1000).toFixed(2), 's');
  }

  setStep(step) {
    const c = this.cards.get('step');
    if (!c) return;
    if (!step) {
      this._setVal('step', c.parts.val, '00', '/00', { na: true });
      c.parts.sub.textContent = 'ยังไม่มีโปรเจกต์';
      this._seg(c.parts.seg, 0);
      return;
    }
    const pad = (n) => String(n).padStart(2, '0');
    this._setVal('step', c.parts.val, pad(step.current), `/${pad(step.total)}`);
    c.parts.sub.textContent = step.title || '';
    this._seg(c.parts.seg, step.current / step.total);
  }

  setTokens(n) {
    const c = this.cards.get('tokens');
    if (!c) return;
    if (n == null || n === 0) {
      this._setVal('tokens', c.parts.val, '—', '', { na: true });
      c.parts.hint.textContent = 'ยังไม่มีรอบสนทนา';
      this._seg(c.parts.seg, 0);
      return;
    }
    const txt = n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(n);
    this._setVal('tokens', c.parts.val, txt, '');
    c.parts.hint.textContent = 'tokens ใน session นี้';
    this._seg(c.parts.seg, Math.min(1, Math.log10(Math.max(1, n)) / 6));
  }

  setElapsed(ms) {
    const c = this.cards.get('elapsed');
    if (!c) return;
    const s = ms / 1000;
    const text = s < 60 ? s.toFixed(1) : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    // no roll every tick — update directly
    c.parts.val.replaceChildren(h('span', '', text), h('span', 'u', s < 60 ? 's' : ''));
    const circ = 2 * Math.PI * 17;
    c.parts.fg.setAttribute('stroke-dasharray', `${((s % 60) / 60) * circ} ${circ}`);
  }

  /** Real TTS envelope sample for the reply waveform (null when silent). */
  pushWave(v) {
    this.waveHist.copyWithin(0, 1);
    this.waveHist[this.waveHist.length - 1] = v || 0;
  }

  // ----- leaders, pulses, hover -----
  layoutLeaders(coreOff = { x: 0, y: 0 }) {
    const R = this.reactor;
    const cos = Math.cos((R.r * Math.PI) / 180) * R.s;
    const sin = Math.sin((R.r * Math.PI) / 180) * R.s;
    for (const c of this.cards.values()) {
      const off = c.float ? { x: c.float.x, y: c.float.y } : { x: 0, y: 0 };
      c.el.style.transform = off.x || off.y ? `translate(${off.x}px, ${off.y}px)` : '';
      const pts = leaderPoints(c.def);
      const n = pts.length - 1;
      const mapped = pts.map((p, i) => {
        if (i < n) return { x: p.x + off.x, y: p.y + off.y };
        // the node rides on the reactor group (translate · rotate · scale about its centre)
        const dx = p.x - CORE.x;
        const dy = p.y - CORE.y;
        return { x: CORE.x + R.x + dx * cos - dy * sin + coreOff.x * R.s, y: CORE.y + R.y + dx * sin + dy * cos + coreOff.y * R.s };
      });
      c.pts = mapped;
      c.pl.setAttribute('points', mapped.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
      c.dot.setAttribute('cx', mapped[0].x);
      c.dot.setAttribute('cy', mapped[0].y);
      c.pl.style.display = c.dot.style.display = c.def.hidden || c.noLeader ? 'none' : '';
    }
  }

  /** A small dot running from the core into a card (rate-limited). */
  pulse(id, force = false) {
    const now = performance.now();
    if (!force && now - this.lastPulse < 240) return;
    const c = this.cards.get(id);
    if (!c || c.def.hidden || c.noLeader) return;
    this.lastPulse = now;
    const dot = svgEl('circle', { class: 'pulse', r: 2 });
    this.leadersSvg.append(dot);
    this.pulses.push({ c, dot, t0: now });
  }

  frame(now, { speaking }) {
    for (const p of this.pulses) {
      const t = Math.min(1, (now - p.t0) / 600);
      const e = 1 - Math.pow(1 - t, 3);
      const pts = [...p.c.pts].reverse(); // core → card
      let total = 0;
      const seg = [];
      for (let i = 1; i < pts.length; i++) {
        const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        seg.push(l);
        total += l;
      }
      let d = e * total;
      let i = 0;
      while (i < seg.length - 1 && d > seg[i]) d -= seg[i++];
      const a = pts[i];
      const b = pts[i + 1];
      const f = seg[i] ? d / seg[i] : 0;
      p.dot.setAttribute('cx', a.x + (b.x - a.x) * f);
      p.dot.setAttribute('cy', a.y + (b.y - a.y) * f);
      p.dot.setAttribute('opacity', String(Math.sin(t * Math.PI)));
      if (t >= 1) p.dot.remove();
    }
    this.pulses = this.pulses.filter((p) => p.dot.isConnected);
    if (this.hovered) this.core.holdNode(this.hovered.node);
    if (this.live) for (const id of this.live) { const c = this.cards.get(id); if (c) this.core.holdNode(c.def.node); }
    this._drawWave(speaking);
  }

  /** LAST REPLY waveform: one thin line (1.5px, accent at 70%). */
  _drawWave(speaking) {
    const c = this.cards.get('reply');
    if (!c) return;
    const cv = c.parts.wave;
    const ctx = cv.getContext('2d');
    const key = speaking ? -1 : 0;
    if (!speaking && c.waveIdle === key) return; // flat line already drawn
    c.waveIdle = key;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const n = this.waveHist.length;
    const mid = cv.height / 2;
    ctx.lineWidth = 3; // canvas is drawn at 2× → 1.5px
    ctx.lineJoin = 'round';
    ctx.strokeStyle = speaking ? 'rgba(91,225,240,0.7)' : 'rgba(230,237,243,0.14)';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = speaking ? this.waveHist[i] : 0;
      const x = (i / (n - 1)) * cv.width;
      // alternate above / below the centre so the envelope reads as a waveform
      const y = mid + (i % 2 ? 1 : -1) * v * (cv.height * 0.45);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  _hover(def, e) {
    for (const c of this.cards.values()) c.pl.classList.toggle('on', !!def && c.def.id === def.id);
    this.hovered = def;
    if (!def) {
      this.tipEl.hidden = true;
      return;
    }
    this.tipEl.textContent = TIPS[def.id];
    this.tipEl.hidden = false;
    this._moveTip(e);
  }

  _moveTip(e) {
    if (this.tipEl.hidden || !e) return;
    const x = Math.min(innerWidth - 340, e.clientX + 16);
    this.tipEl.style.left = `${x}px`;
    this.tipEl.style.top = `${Math.min(innerHeight - 96, e.clientY + 16)}px`;
  }
}

export { nodePoint, CORE };
