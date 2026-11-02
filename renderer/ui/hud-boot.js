// HUD boot sequence (~4.8 s), ported from the reference: ONE GSAP timeline, every time in the TIMING table.
// Phases: 0 power-on · 1 grid & frame · 2 reactor assembly · 3 boot text + log · 4 connector lines · 5 panels deploy · 6 ready.
// Truthfulness: the log lines show real checks of this machine's capabilities and panels count up to REAL values.
// Cyan #00E5FF / orange #FF8A1F, power3.out / expo.out everywhere (linear only for the scan lines).

import { CX_REF, CY_REF } from './hud-reactor.js';

export const TIMING = {
  crtIn: 0.15, crtOut: 0.15, veilAt: 0.3, veilDur: 0.3, bgAt: 0.3,
  gridAt: 0.3, gridDur: 0.7,
  cornersAt: 0.3, frameFadeAt: 0.8,
  rulersAt: 0.4, rulerTick: 0.003, labelsAt: 0.5, labelsDur: 0.5,
  ringsAt: 0.6, ringGap: 0.1, ringDur: 0.9,
  rotateDur: 1.6, rotateFrom: -15,
  ticksAt: 0.8, tickStagger: 0.001, tickDur: 0.12,
  degreesAt: 1.0, degreeStagger: 0.035,
  blocksAt: 1.0, blockStagger: 0.015,
  layersAt: 1.1, arcsAt: 1.3, arcsDur: 0.9, dashArcsAt: 1.6,
  textAt: 1.2, msgEvery: 0.4, msgDecode: 0.28,
  logAt: 1.2, logEvery: 0.28, logFadeAt: 3.9, logFadeDur: 0.3,
  logoAt: 1.5, flashAt: 1.65,
  nodesAt: 2.2, nodeGap: 0.08, lineDur: 0.25,
  panelsAt: 2.5, panelGap: 0.15,
  borderDur: 0.3, expandDur: 0.25, glitchDur: 0.15, scanDur: 0.35, contentDelay: 0.45, countDur: 0.5,
  readyAt: 4.4, pulseDur: 0.2, endAt: 4.8,
  skipFade: 0.2, reducedFade: 0.4,
};
export const MESSAGES = ['INITIALIZING...', 'CALIBRATING SENSORS...', 'SYSTEMS ONLINE'];
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ORDER = ['reply', 'mic', 'tts', 'latency', 'tokens', 'elapsed', 'step'];
const $ = (id) => document.getElementById(id);

/** Character scramble: characters left of progress*len are resolved, the rest cycle through A-Z/0-9 (spaces stay). */
export function scramble(target, p, rnd = Math.random) {
  const n = Math.floor(Math.max(0, Math.min(1, p)) * target.length);
  let out = '';
  for (let i = 0; i < target.length; i++) out += i < n || target[i] === ' ' ? target[i] : CHARS[Math.floor(rnd() * CHARS.length)];
  return out;
}

/** Real capability checks for the boot log. */
function realChecks(sfx) {
  const md = typeof navigator !== 'undefined' && navigator.mediaDevices;
  return [
    { label: 'DISPLAY', ok: true, text: 'OK' },
    { label: 'AUDIO', ok: !!(sfx && !sfx.failed), text: 'OFF' },
    { label: 'MICROPHONE', ok: !!(md && md.getUserMedia), text: 'N/A' },
    { label: 'VOICE', ok: typeof speechSynthesis !== 'undefined', text: 'N/A' },
  ];
}

/**
 * @param {object} o
 * @param {import('./home.js').Home} o.home
 * @param {object} o.sfx
 * @param {HTMLElement} o.overlay  #boot-overlay (the black veil)
 * @param {Function} o.ready       emits app:ready + resolves the caller
 * @param {Function} o.greetIn     schedules the optional voice greeting
 * @param {Function} o.chimeOnly   plain ready chime (skip path)
 * @param {Function} o.countUp     count-up helper shared with the calm boot
 */
export function playHudBoot({ home, sfx, overlay, ready, greetIn, chimeOnly, countUp }) {
  const G = window.gsap, T = TIMING, body = document.body, stage = $('stage');
  const hud = home.hud, bd = home.backdrop;
  const parts = hud.parts();
  const finals = []; // work to do when the sequence ends or is skipped, so the live UI takes over cleanly
  const clearAll = [];
  let finished = false, skipping = false, tl = null;
  const q = (sel, root = stage) => [...root.querySelectorAll(sel)];

  function finish(skipped) {
    if (finished) return;
    finished = true;
    removeEventListener('keydown', skip, true); removeEventListener('mousedown', skip, true);
    for (const f of finals) { try { f(); } catch (e) { console.warn('[boot] cleanup', e); } }
    hud.setBootArc(1); hud.setBooting(false); hud.resyncBlocks();
    for (const [els, props] of clearAll) G.set(els, { clearProps: props });
    body.classList.remove('booting');
    label.classList.remove('boot');
    for (const id of ['bootLine', 'bootLog']) { const e = $(id); if (e) e.remove(); }
    for (const c of home.cards.cards.values()) { c.el.style.pointerEvents = ''; c.el.style.opacity = ''; }
    if (home.docking) home.docking.restoreDocked();
    home.booting = false;
    home.applyLabel();
    if (skipped) { sfx.fadeGroup('boot', 0.2); setTimeout(chimeOnly, 200); }
    ready();
  }

  function skip(e) {
    if (finished || skipping) return;
    skipping = true;
    if (e && e.type === 'keydown') e.stopPropagation();
    sfx.quiet(400);
    tl.pause();
    overlay.hidden = false;
    G.to(overlay, { opacity: 1, duration: T.skipFade / 2, ease: 'power3.out', onComplete: () => {
      tl.progress(1, true); finish(true);
      G.to(overlay, { opacity: 0, duration: T.skipFade / 2, ease: 'power3.out', onComplete: () => { overlay.hidden = true; } });
    } });
  }
  addEventListener('keydown', skip, true); addEventListener('mousedown', skip, true);

  // ---------- gather the pieces ----------
  const bg = $('hud-bg'), frame = $('hud-frame'), hamb = $('hamburger');
  const core = bd.core();
  const R = bd.rulers;
  const cardsMap = home.cards.cards;
  const nodesAll = ORDER.map((k) => cardsMap.get(k)).filter((c) => c && !c.def.hidden);
  const isDocked = (c) => !!(home.docking && home.docking.isDocked(c.def.id));
  const visible = nodesAll.filter((c) => !isDocked(c));
  const layers = { LA: parts.LA, LB: parts.LB, L1: parts.L1, L2: parts.L2 };
  const label = $('state-label'), readout = document.querySelector('.core-readout');

  hud.setBootArc(0); hud.setBooting(true);
  label.textContent = '';
  label.classList.add('boot');
  overlay.hidden = false; G.set(overlay, { opacity: 1 });
  G.set(readout, { opacity: 0 });

  tl = G.timeline({ paused: true, defaults: { ease: 'power3.out' }, onComplete: () => finish(false) });

  // ===== PHASE 0 — power on: a CRT line flashes across the centre, then the navy background fades in =====
  const crt = document.createElement('div');
  crt.id = 'bootLine'; document.body.appendChild(crt);
  G.set(crt, { scaleX: 0, scaleY: 1, opacity: 1 });
  tl.to(crt, { scaleX: 1, duration: T.crtIn, ease: 'expo.out' }, 0)
    .to(crt, { scaleY: 0, opacity: 0, duration: T.crtOut, ease: 'power3.out' }, T.crtIn)
    .to(overlay, { opacity: 0, duration: T.veilDur, ease: 'power3.out' }, T.veilAt)
    .set(bg, { opacity: 1 }, T.bgAt);
  tl.call(() => sfx.powerOn(), [], 0);
  clearAll.push([bg, 'opacity']);

  // ===== PHASE 1 — grid (radial reveal), corner brackets, edge rulers, coordinate labels =====
  const maxR = Math.hypot(innerWidth, innerHeight);
  const grids = [$('gridCv'), $('gridLit')];
  for (const g of grids) { g.style.setProperty('--cx', `${core.x + 6}px`); g.style.setProperty('--cy', `${core.y + 6}px`); g.style.setProperty('--rv', '0px'); }
  tl.to(grids, { '--rv': `${maxR}px`, duration: T.gridDur, ease: 'power3.out' }, T.gridAt);
  finals.push(() => { for (const g of grids) g.style.removeProperty('--rv'); });
  tl.set(frame, { opacity: 1 }, T.cornersAt).set(hamb, { opacity: 0.5 }, T.cornersAt);
  [['.c-tr', 20, -20], ['.c-bl', -20, 20], ['.c-br', 20, 20]].forEach(([sel, dx, dy], i) => {
    const el = frame.querySelector(sel), t = T.cornersAt + i * 0.04;
    if (!el) return;
    G.set(el, { x: dx, y: dy });
    tl.to(el, { x: 0, y: 0, duration: 0.25, ease: 'power3.out' }, t)
      .to(el, { keyframes: [{ opacity: 1, duration: 0.05 }, { opacity: 0.3, duration: 0.05 }, { opacity: 1, duration: 0.1 }] }, t);
    clearAll.push([el, 'opacity,transform']);
  });
  G.set(hamb, { x: -20, y: -20 });
  tl.to(hamb, { x: 0, y: 0, duration: 0.25 }, T.cornersAt)
    .to(hamb, { keyframes: [{ opacity: 1, duration: 0.05 }, { opacity: 0.3, duration: 0.05 }, { opacity: 0.5, duration: 0.1 }] }, T.cornersAt);
  clearAll.push([[hamb, frame], 'opacity,transform']);
  const fm = q('.fm > :not(.corner)', frame), caps = [$('caption-tr')].filter(Boolean);
  tl.to(fm, { opacity: 1, duration: 0.4, stagger: 0.03 }, T.frameFadeAt).to(caps, { opacity: 1, duration: 0.4 }, T.frameFadeAt + 0.2);
  clearAll.push([[...fm, ...caps, ...q('.caption-bl', document)], 'opacity']);
  // edge rulers draw tick by tick; labels scramble in
  tl.to(R.base, { opacity: 1, duration: 0.3, stagger: 0.03 }, T.rulersAt);
  for (const edge of ['top', 'bottom', 'left', 'right']) tl.to(R[edge], { opacity: 1, duration: 0.05, stagger: T.rulerTick }, T.rulersAt);
  clearAll.push([[...R.base, ...R.top, ...R.bottom, ...R.left, ...R.right, ...R.labels.map((l) => l.el)], 'opacity']);
  const lp = { p: 0 };
  tl.set(R.labels.map((l) => l.el), { opacity: 1 }, T.labelsAt);
  tl.to(lp, { p: 1, duration: T.labelsDur, ease: 'power3.out', onUpdate: () => {
    const n = R.labels.length;
    R.labels.forEach((l, i) => { l.el.textContent = scramble(l.text, Math.max(0, Math.min(1, lp.p * 1.5 - (i / n) * 0.5))); });
  } }, T.labelsAt);
  finals.push(() => R.labels.forEach((l) => { l.el.textContent = l.text; }));

  // ===== PHASE 2 — reactor assembly =====
  const gs = parts.gs;
  const rotP = { r: T.rotateFrom };
  const rotTargets = [layers.LA, layers.LB, layers.L1, layers.L2];
  const gsTransform = gs.getAttribute('transform');
  const K = 1.15;
  const setRot = () => {
    gs.setAttribute('transform', `translate(${CX_REF} ${CY_REF}) scale(${K}) rotate(${rotP.r}) translate(${-CX_REF} ${-CY_REF})`);
    for (const e of rotTargets) e.style.rotate = `${rotP.r}deg`;
  };
  setRot();
  tl.to(rotP, { r: 0, duration: T.rotateDur, ease: 'power3.out', onUpdate: setRot }, T.ringsAt);
  finals.push(() => { gs.setAttribute('transform', gsTransform); for (const e of rotTargets) e.style.rotate = ''; });
  const disc = gs.firstElementChild;
  tl.to(disc, { opacity: 1, duration: 0.5 }, T.ringsAt);
  const handled = new Set([disc]);
  // rings: stroke-dashoffset, 0.1 s apart, alternating clockwise / counter-clockwise
  [['circle[r="243"]', 1], ['circle[r="231"]', -1], ['#ringIn', 1], ['circle[r="117"]', -1]].forEach(([sel, dir], i) => {
    const c = gs.querySelector(sel); if (!c) return;
    handled.add(c);
    const len = c.hasAttribute('pathLength') ? 360 : c.getTotalLength(), t = T.ringsAt + i * T.ringGap;
    G.set(c, { strokeDasharray: `${len} ${len}`, strokeDashoffset: dir * len });
    tl.set(c, { opacity: 1 }, t).to(c, { strokeDashoffset: 0, duration: T.ringDur, ease: 'power3.out' }, t);
    clearAll.push([c, 'opacity,strokeDasharray,strokeDashoffset']);
  });
  // radial ticks: a sweeping wave from the top, each tick scales from 0 to its full length
  const ticks = parts.tickLines.slice().sort((a, b) => ((a.a + 90) % 360) - ((b.a + 90) % 360));
  for (const t of ticks) G.set(t.el, { scale: 0, svgOrigin: `${t.x} ${t.y}` });
  const tickGroups = [parts.tk1, parts.tk3, parts.tk2]; tickGroups.forEach((g) => handled.add(g));
  tl.set(tickGroups, { opacity: 1 }, T.ticksAt)
    .to(ticks.map((t) => t.el), { scale: 1, duration: T.tickDur, ease: 'power3.out', stagger: T.tickStagger }, T.ticksAt);
  clearAll.push([ticks.map((t) => t.el), 'transform'], [tickGroups, 'opacity']);
  // degree labels flicker on in order around the circle
  const degs = q('.deg', gs); degs.forEach((d) => handled.add(d));
  tl.to(degs, { keyframes: [{ opacity: 1, duration: 0.04 }, { opacity: 0.3, duration: 0.04 }, { opacity: 1, duration: 0.08 }], stagger: T.degreeStagger }, T.degreesAt);
  clearAll.push([degs, 'opacity']);
  // segmented block ring: fast sweep, overshoot to full brightness, settle to the idle level
  const blocks = q('.blk', layers.L1);
  G.set(blocks, { opacity: 0 });
  tl.set(layers.L1, { opacity: 1 }, T.blocksAt)
    .to(blocks, { keyframes: [{ opacity: 1, duration: 0.1 }, { opacity: 0.12, duration: 0.4 }], stagger: { each: T.blockStagger, from: 'end' } }, T.blocksAt);
  clearAll.push([layers.L1, 'opacity']);
  // rotating arc layers + arcs that extend from 0 to full length (+ dashed orange outer arcs fade in)
  G.set([layers.LA, layers.LB], { opacity: 0 });
  tl.to(layers.LA, { opacity: 1, duration: 0.5 }, T.layersAt).to(layers.LB, { opacity: 1, duration: 0.5 }, T.layersAt + 0.1);
  clearAll.push([[layers.LA, layers.LB], 'opacity']);
  const arcP = { k: 0 };
  tl.to(arcP, { k: 1, duration: T.arcsDur, ease: 'expo.out', onUpdate: () => hud.setBootArc(arcP.k) }, T.arcsAt);
  const dashArcs = q('.dash-or', gs); dashArcs.forEach((d) => handled.add(d));
  tl.to(dashArcs, { opacity: 1, duration: 0.5, stagger: 0.1 }, T.dashArcsAt);
  clearAll.push([dashArcs, 'opacity']);
  const misc = [...gs.children].filter((c) => !handled.has(c));
  tl.to(misc, { opacity: 1, duration: 0.5, stagger: 0.012 }, T.ringsAt + 0.3);
  clearAll.push([misc, 'opacity']);
  // centre logo 0.6 > 1.08 > 1.0, white flash that grows into a soft shockwave ring
  const emb = parts.emb, flash = parts.flash, shock = parts.shock;
  const cDiamond = `${CX_REF} ${CY_REF - 25}`, cc = `${CX_REF} ${CY_REF}`;
  G.set(layers.L2, { opacity: 0 });
  G.set(emb, { scale: 0.6, opacity: 0, svgOrigin: cDiamond });
  tl.set(layers.L2, { opacity: 1 }, T.textAt)
    .to(emb, { keyframes: [{ scale: 1.08, opacity: 1, duration: 0.35 }, { scale: 1, duration: 0.25 }] }, T.logoAt);
  G.set(flash, { opacity: 0, scale: 0.3, svgOrigin: cc, fill: '#fff' });
  G.set(shock, { opacity: 0, scale: 0.2, svgOrigin: cc });
  tl.fromTo(flash, { opacity: 0.95, scale: 0.3 }, { opacity: 0, scale: 1.6, duration: 0.6, ease: 'expo.out', immediateRender: false }, T.flashAt)
    ;
  clearAll.push([[layers.L2, emb, flash, shock], 'opacity,transform,fill']);

  // ===== PHASE 3 — status text decodes under the logo; the boot log shows REAL checks =====
  tl.set(readout, { opacity: 1 }, T.textAt);
  MESSAGES.forEach((msg, i) => {
    const o = { p: 0 }, t = T.textAt + i * T.msgEvery;
    tl.to(o, { p: 1, duration: T.msgDecode, ease: 'power3.out', onUpdate: () => { label.textContent = scramble(msg, o.p); } }, t)
      .call(() => { label.textContent = msg; }, [], t + T.msgDecode + 0.001);
  });
  clearAll.push([readout, 'opacity']);
  const log = document.createElement('div');
  log.id = 'bootLog'; document.body.appendChild(log);
  const lines = realChecks(sfx).map((c) => {
    const row = document.createElement('div'), tx = document.createElement('span'), st = document.createElement('span');
    st.className = 'st'; row.append(tx, st); log.appendChild(row);
    return { c, tx, st, text: `> ${(`${c.label} `).padEnd(20, '.')} ` };
  });
  lines.forEach((ln, i) => {
    const o = { n: 0 }, t = T.logAt + i * T.logEvery;
    tl.to(o, { n: ln.text.length, duration: 0.2, ease: 'power3.out', onUpdate: () => { ln.tx.textContent = ln.text.slice(0, Math.round(o.n)); } }, t)
      .call(() => { ln.st.textContent = ln.c.ok ? 'OK' : ln.c.text; ln.st.className = 'st'; }, [], t + 0.22) // pending / failed: orange
      .call(() => { if (ln.c.ok) ln.st.classList.add('ok'); }, [], t + 0.4); // confirmed: cyan
  });
  tl.to(log, { opacity: 0, duration: T.logFadeDur, ease: 'power3.out' }, T.logFadeAt)
    .to(q('.caption-bl', document), { opacity: 1, duration: 0.4 }, T.logFadeAt + 0.1);

  // ===== PHASE 4 — nodes blink on, connector lines shoot out to the panels with a light pulse and a landing spark =====
  const nodePieces = (c) => { const n = hud.nodes.get(c.def.node); return n ? q('.noder, .node, .nodei', n.g) : []; };
  const leadsSvg = $('leaders');
  const blink = [{ opacity: 1, duration: 0.05 }, { opacity: 0.2, duration: 0.05 }, { opacity: 1, duration: 0.1 }];
  nodesAll.filter((c) => !visible.includes(c)).forEach((c, i) => { // docked cards: just the node blinks on
    const pieces = nodePieces(c);
    tl.to(pieces, { keyframes: blink }, T.nodesAt + i * T.nodeGap);
    clearAll.push([pieces, 'opacity']);
  });
  visible.forEach((c, i) => {
    const poly = c.pl, anchor = c.dot, pieces = nodePieces(c), t = T.nodesAt + i * T.nodeGap;
    const len = poly.getTotalLength(), a = poly.getPointAtLength(0);
    G.set(poly, { strokeDasharray: `${len} ${len}`, strokeDashoffset: -len, opacity: 0 });
    G.set(anchor, { opacity: 0, scale: 0, svgOrigin: `${a.x} ${a.y}` });
    G.set(pieces, { opacity: 0 });
    tl.to(pieces, { keyframes: blink }, t);
    tl.set(poly, { opacity: 1 }, t + 0.05).to(poly, { strokeDashoffset: 0, duration: T.lineDur, ease: 'power3.out' }, t + 0.05); // node -> panel
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', 'pulse'); dot.setAttribute('r', '3.8'); dot.setAttribute('opacity', '0'); leadsSvg.appendChild(dot);
    const spark = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    spark.setAttribute('class', 'hud-spark'); spark.setAttribute('r', '4'); spark.setAttribute('cx', a.x); spark.setAttribute('cy', a.y); spark.setAttribute('opacity', '0'); leadsSvg.appendChild(spark);
    G.set(spark, { svgOrigin: `${a.x} ${a.y}` });
    const pp = { p: 0 };
    tl.set(dot, { opacity: 1 }, t + 0.05)
      .to(pp, { p: 1, duration: T.lineDur, ease: 'power3.out', onUpdate: () => { const pt = poly.getPointAtLength(len * (1 - pp.p)); dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y); } }, t + 0.05)
      .to(dot, { opacity: 0, duration: 0.12 }, t + 0.05 + T.lineDur);
    tl.to(anchor, { keyframes: [{ opacity: 1, scale: 1.9, duration: 0.1 }, { scale: 1, duration: 0.15 }] }, t + 0.05 + T.lineDur)
      .fromTo(spark, { opacity: 0.9, scale: 1 }, { opacity: 0, scale: 3.2, duration: 0.35, ease: 'expo.out', immediateRender: false }, t + 0.05 + T.lineDur);
    finals.push(() => { dot.remove(); spark.remove(); });
    clearAll.push([[poly, anchor, ...pieces], 'opacity,transform,strokeDasharray,strokeDashoffset']);
  });
  const guides = parts.guides;
  G.set(guides, { opacity: 0 });
  tl.to(guides, { opacity: 1, duration: 0.6 }, T.ringsAt);
  clearAll.push([guides, 'opacity']);

  // ===== PHASE 5 — panels deploy one by one, each only after its connector line has arrived =====
  visible.forEach((c, i) => {
    const k = c.def.id, mod = c.el;
    const arrive = T.nodesAt + i * T.nodeGap + 0.05 + T.lineDur;
    const s = Math.max(T.panelsAt + i * T.panelGap, arrive);
    const fill = mod.querySelector('.fill'), base = mod.querySelector('.base'), brk = q('.accp', mod), inn = mod.querySelector('.in');
    const icon = mod.querySelector('.hico'), title = mod.querySelector('.lbl'), tag = mod.querySelector('.tg');
    const segs = q('.meter, .dots i, .seg4 i', mod), bars = q('.chart i', mod), canvas = mod.querySelector('canvas'), dial = mod.querySelector('.dial .fg');
    const titleText = title ? title.textContent : '';
    const len = base.getTotalLength();
    G.set(mod, { opacity: 0 });
    mod.style.pointerEvents = 'none';
    G.set(base, { strokeDasharray: `${len} ${len}`, strokeDashoffset: len });
    G.set(fill, { opacity: 0 });
    G.set(brk, { opacity: 0 });
    G.set([fill, inn], { scaleY: 0.02, transformOrigin: '50% 50%' });
    G.set(inn, { opacity: 0 });
    if (icon) G.set(icon, { scale: 0, transformOrigin: '50% 50%' });
    if (title) title.textContent = '';
    if (tag) G.set(tag, { opacity: 0 });
    if (segs.length) G.set(segs, { opacity: 0 });
    if (bars.length) G.set(bars, { scaleY: 0, transformOrigin: '50% 100%' });
    if (canvas) G.set(canvas, { scaleX: 0, transformOrigin: '0% 50%' });
    const scan = document.createElement('div'); scan.className = 'scan'; mod.appendChild(scan); G.set(scan, { opacity: 0, y: 0 });
    const tp = { p: 0 };

    tl.set(mod, { opacity: 1 }, s);
    tl.to(base, { strokeDashoffset: 0, duration: T.borderDur, ease: 'power3.out' }, s); // 1. the chamfered outline traces itself
    const open = s + T.borderDur;
    tl.to(brk, { opacity: 1, duration: 0.2 }, open - 0.1)
      .to(fill, { opacity: 1, scaleY: 1, duration: T.expandDur, ease: 'expo.out' }, open)
      .to(inn, { scaleY: 1, opacity: 1, duration: T.expandDur, ease: 'expo.out' }, open); // 2. expands from a thin line
    tl.to(mod, { keyframes: { opacity: [1, 0.4, 1, 0.7, 1], x: [0, -2, 2, -1, 0] }, duration: T.glitchDur, ease: 'power3.out' }, open) // 3. glitch + 2px jitter
      .call(() => sfx.panelOpen(i, sfx.panOf(mod)), [], open);
    tl.set(scan, { opacity: 1 }, open)
      .to(scan, { y: () => mod.offsetHeight, duration: T.scanDur, ease: 'none' }, open) // scan line: the one linear ease
      .set(scan, { opacity: 0 }, open + T.scanDur);
    const c0 = open + T.contentDelay - 0.2;
    if (icon) tl.to(icon, { keyframes: [{ scale: 1.15, duration: 0.15 }, { scale: 1, duration: 0.1 }] }, c0); // icon pops
    if (title) {
      tl.to(tp, { p: 1, duration: 0.3, ease: 'power3.out', onUpdate: () => { title.textContent = scramble(titleText, tp.p); } }, c0)
        .call(() => { title.textContent = titleText; }, [], c0 + 0.31);
    }
    if (segs.length) tl.to(segs, { opacity: 1, duration: 0.12, stagger: 0.02 }, c0 + 0.1); // bars fill left to right
    if (bars.length) tl.to(bars, { scaleY: 1, duration: 0.3, stagger: 0.03 }, c0 + 0.1); // latency bars grow from the bottom
    if (canvas) tl.to(canvas, { scaleX: 1, duration: 0.5 }, c0 + 0.1); // waveform draws left to right
    if (dial) {
      tl.call(() => { dial.setAttribute('stroke-dasharray', '0 100'); }, [], c0 + 0.1)
        .to(dial, { attr: { 'stroke-dasharray': '100 100' }, duration: 0.6, ease: 'power3.out' }, c0 + 0.1); // elapsed ring fills its arc
      finals.push(() => dial.removeAttribute('stroke-dasharray'));
    }
    tl.call(() => { // count up to the REAL value
      for (const v of mod.querySelectorAll('.val > span:first-child')) { const cu = countUp(v, T.countDur + 0.1); if (cu) finals.push(() => { cu.tw.kill(); cu.span.textContent = cu.final; }); }
    }, [], c0 + 0.1);
    if (tag) tl.to(tag, { opacity: 1, duration: 0.25 }, c0 + 0.45); // 5. ID tag fades in last
    tl.call(() => { mod.style.pointerEvents = ''; }, [], c0 + 0.6);
    finals.push(() => { scan.remove(); if (title) title.textContent = titleText; mod.style.pointerEvents = ''; });
    clearAll.push([[mod, fill, inn, icon, tag, ...segs, ...bars, canvas, base, ...brk].filter(Boolean), 'opacity,transform,strokeDasharray,strokeDashoffset']);
  });

  // ===== PHASE 6 — ready: one unified glow pulse, status settles, the menu dot blinks twice =====
  const glowT = [$('home'), frame, hamb];
  tl.to(glowT, { filter: 'brightness(1.4)', duration: T.pulseDur, ease: 'power3.out' }, T.readyAt)
    .to(glowT, { filter: 'brightness(1)', duration: T.pulseDur, ease: 'power3.out' }, T.readyAt + T.pulseDur);
  clearAll.push([glowT, 'filter']);
  tl.call(() => {
    hud.setBooting(false);
    label.classList.remove('boot');
    home.booting = false;
    home.applyLabel();
    sfx.ready();
    greetIn(900);
  }, [], T.readyAt);
  const dot = $('hb-dot');
  tl.to(dot, { keyframes: [{ opacity: 0.1, duration: 0.1 }, { opacity: 1, duration: 0.1 }, { opacity: 0.1, duration: 0.1 }, { opacity: 1, duration: 0.1 }] }, T.readyAt);
  clearAll.push([dot, 'opacity']);
  tl.to({}, { duration: 0.001 }, T.endAt);

  requestAnimationFrame(() => tl.play(0));
}
