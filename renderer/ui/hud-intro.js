// Cinematic intro — "J.A.R.V.I.S powers up" as a short film in five acts (≈6.6 s), played on top of the HUD boot
// (ui/hud-boot.js), which assembles the real reactor underneath and takes over as this overlay dissolves.
//
//  1  SILENCE   black · one spark, breathing twice                                  — held breath
//  2  AWAKENING the spark bursts into one shockwave · rings draw themselves, inner fast and sharp, outer slow and
//               heavy · a single beam of light cuts across the screen              — power gathering
//  3  ASSEMBLY  the reactor draws the same rings underneath · reticle closes in and locks · data decodes ·
//               a scan line sweeps · the dials tick                                 — technology comes alive
//  4  CLIMAX    everything stops for 0.2 s … then the emblem ignites: white flash, an impact, a ripple,
//               a chromatic split, and "J.A.R.V.I.S" decodes letter by letter      — goosebumps
//  5  GREETING  "ONLINE" + a greeting for the time of day · the camera pulls back as the cards deploy — warmth
//
// Every time lives in INTRO below. The circle you see is the REAL reactor (ui/hud-reactor.js): this overlay only
// adds the spark, the shockwave, the beam, the reticle, the data and the title around it — one object start to finish. Pure decoration over a black veil; skippable; honours reduced motion
// (the caller never starts it then) and the intro-length setting (full / quick / off).

import { scramble } from './hud-boot.js';

const NS = 'http://www.w3.org/2000/svg';
const KEY = 'jarvis.intro';

export const INTRO = {
  mainAt: 0.75, // when the boot timeline starts: the REAL reactor then draws its own rings (the intro has none of its own)
  dotAt: 0.25, pulse1: 0.32, pulse2: 0.8,
  shockAt: 1.0,
  beamAt: 1.2,
  reticleAt: 1.95, lockAt: 2.6,
  dataAt: 2.1, scanAt: 2.35,
  stillAt: 3.8, stillLen: 0.2,
  igniteAt: 4.0,
  titleAt: 4.08,
  greetAt: 4.85,
  outAt: 6.0, outLen: 0.6,
  pullBackAt: 4.7, pullBackLen: 1.8, pullBackFrom: 1.07,
  length: 6.6,
};
const TITLE = 'J.A.R.V.I.S';

/** 'full' | 'quick' | 'off' — stored in localStorage (Settings → Display). */
export function getIntroMode() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'quick' || v === 'off' ? v : 'full';
  } catch { return 'full'; }
}
export function setIntroMode(v) {
  try { localStorage.setItem(KEY, v === 'quick' || v === 'off' ? v : 'full'); } catch { /* storage unavailable */ }
}

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
const hex = () => `0x${Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'สวัสดีตอนเช้าครับ';
  if (h >= 12 && h < 17) return 'สวัสดีตอนบ่ายครับ';
  if (h >= 17 && h < 20) return 'สวัสดีตอนเย็นครับ';
  return 'สวัสดีครับ';
}

/** Lines of real values (left column) and stylised system lines (right column). */
function dataLines() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const md = typeof navigator !== 'undefined' && navigator.mediaDevices;
  const left = [
    `LOCAL TIME  ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    `DATE        ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    `DISPLAY     ${innerWidth}x${innerHeight}`,
    `MICROPHONE  ${md && md.getUserMedia ? 'AVAILABLE' : 'N/A'}`,
    `VOICE       ${typeof speechSynthesis !== 'undefined' ? 'AVAILABLE' : 'N/A'}`,
    `LANGUAGE    ${(navigator.language || 'th-TH').toUpperCase()}`,
  ];
  const right = ['CORE.LINK', 'ARC.REACTOR', 'NEURAL.NET', 'SENSOR.ARRAY', 'AUDIO.BUS', 'SHIELD.GRID'].map((n) => `${n}  ${hex()}`);
  return { left, right };
}

/**
 * @param {object} G    gsap
 * @param {object} sfx
 * @param {{ setFrozen: (b: boolean) => void }} hud  the HUD reactor (it holds still for the beat before ignition)
 * @returns {{ tl: gsap.core.Timeline, root: HTMLElement, kill: () => void }}
 */
export function buildIntro(G, sfx, hud) {
  const T = INTRO;
  const root = document.createElement('div');
  root.id = 'bootIntro';
  root.setAttribute('aria-hidden', 'true');
  const svg = el('svg', { viewBox: '-960 -540 1920 1080', preserveAspectRatio: 'xMidYMid slice' });
  root.appendChild(svg);

  const dot = el('circle', { class: 'bi-dot', r: 4 }, svg);
  const halo = el('circle', { class: 'bi-halo', r: 26 }, svg);
  const shock = el('circle', { class: 'bi-shock', r: 8 }, svg);
  const echo = [0, 1].map(() => el('circle', { class: 'bi-echo', r: 40 }, svg)); // climax ripples

  // ---- reticle, data, scan, beam ----
  const ret = el('g', { class: 'bi-ret' }, svg);
  const arm = 46, w = 470, h = 262;
  [[-w, -h, 1, 1], [w, -h, -1, 1], [w, h, -1, -1], [-w, h, 1, -1]].forEach(([x, y, sx, sy]) =>
    el('path', { d: `M${x} ${y + sy * arm}V${y}H${x + sx * arm}` }, ret));
  const { left, right } = dataLines();
  const dataEls = [];
  for (const [x, anchor, list] of [[-840, 'start', left], [840, 'end', right]]) {
    const col = el('g', { class: 'bi-data' }, svg);
    list.forEach((text, i) => {
      const t = el('text', { x, y: -130 + i * 26, 'text-anchor': anchor }, col);
      dataEls.push({ t, text });
    });
  }
  const title = el('text', { class: 'bi-title', x: 0, y: 408, 'text-anchor': 'middle' }, svg);
  const online = el('text', { class: 'bi-online', x: 0, y: 446, 'text-anchor': 'middle' }, svg);
  online.textContent = 'ONLINE';
  const greet = el('text', { class: 'bi-greet', x: 0, y: 486, 'text-anchor': 'middle' }, svg);
  greet.textContent = greeting();
  const mk = (cls) => { const d = document.createElement('div'); d.className = cls; root.appendChild(d); return d; };
  const lines = mk('bi-lines'), beam = mk('bi-beam'), scan = mk('bi-scan'), flash = mk('bi-flash');
  document.body.appendChild(root);

  // ---------- initial (off) state ----------
  G.set(dot, { scale: 0, svgOrigin: '0 0' });
  G.set(halo, { opacity: 0, scale: 0.4, svgOrigin: '0 0' });
  G.set([shock, ...echo], { opacity: 0 });
  G.set(ret, { opacity: 0, scale: 2.3, svgOrigin: '0 0' });
  G.set([title, online, greet], { opacity: 0 });
  G.set(title, { attr: { 'letter-spacing': '0.9em' } });
  G.set(beam, { opacity: 0, scaleX: 0 });
  G.set([scan, flash], { opacity: 0 });
  G.set(lines, { opacity: 0 });
  for (const d of dataEls) { G.set(d.t, { opacity: 0 }); d.t.textContent = scramble(d.text, 0); }

  const tl = G.timeline({ paused: true, defaults: { ease: 'power3.out' } });

  // ===== ACT 1 — silence: the room tone starts; one spark, breathing twice =====
  tl.call(() => sfx.introHum(T.length - 1.2), [], 0)
    .set(lines, { opacity: 1 }, 0)
    .to(dot, { scale: 1, duration: 0.5, ease: 'power2.out' }, T.dotAt)
    .to(halo, { opacity: 0.55, scale: 1, duration: 0.6 }, T.dotAt);
  for (const [at, k] of [[T.pulse1, 1], [T.pulse2, 1.5]]) {
    tl.call(() => sfx.introPulse(k), [], at)
      .to(dot, { scale: 1.9 * k, duration: 0.09, ease: 'power2.out' }, at)
      .to(dot, { scale: 1, duration: 0.34, ease: 'power2.inOut' }, at + 0.09)
      .to(halo, { scale: 1.8 * k, opacity: 0.9, duration: 0.09 }, at)
      .to(halo, { scale: 1, opacity: 0.5, duration: 0.4, ease: 'power2.inOut' }, at + 0.09);
  }

  // ===== ACT 2 — awakening: shockwave, rings draw (inner fast, outer slow), one beam of light =====
  tl.call(() => sfx.introPulse(2), [], T.shockAt)
    .fromTo(shock, { opacity: 0.95, attr: { r: 8, 'stroke-width': 3 } }, { opacity: 0, attr: { r: 430, 'stroke-width': 0.4 }, duration: 1.0, ease: 'expo.out', immediateRender: false }, T.shockAt)
    .to(halo, { opacity: 0.25, scale: 2.6, duration: 0.8, ease: 'expo.out' }, T.shockAt);
  // the real reactor now draws its rings (hud-boot.js, same instant): the spark gives way to them
  for (let i = 0; i < 6; i++) tl.call(() => sfx.introTick(i), [], T.mainAt + 0.6 + i * 0.1);
  tl.to(dot, { scale: 0.8, duration: 0.3 }, T.mainAt + 0.6)
    .set(beam, { opacity: 1 }, T.beamAt)
    .to(beam, { scaleX: 1, duration: 0.32, ease: 'expo.out' }, T.beamAt)
    .to(beam, { opacity: 0, duration: 0.45, ease: 'power1.in' }, T.beamAt + 0.3);

  // ===== ACT 3 — assembly: orange arcs, reticle closes in and locks, data decodes, scan line, ticks =====
  tl.to(ret, { opacity: 1, scale: 1, duration: 0.7, ease: 'expo.out' }, T.reticleAt)
    .to(ret, { keyframes: [{ opacity: 0.3, duration: 0.05 }, { opacity: 1, duration: 0.06 }, { opacity: 0.55, duration: 0.04 }, { opacity: 1, duration: 0.08 }] }, T.lockAt)
    .to(ret, { x: -5, duration: 0.04 }, T.lockAt)
    .to(ret, { x: 0, duration: 0.3, ease: 'elastic.out(1, 0.4)' }, T.lockAt + 0.04)
    .call(() => sfx.panelOpen(2, 0), [], T.lockAt)
    .set(scan, { opacity: 1, y: -6 }, T.scanAt)
    .to(scan, { y: () => innerHeight, duration: 0.95, ease: 'power2.inOut' }, T.scanAt)
    .set(scan, { opacity: 0 }, T.scanAt + 0.95);
  dataEls.forEach((d, i) => {
    const o = { p: 0 }, t = T.dataAt + 0.04 * i;
    tl.set(d.t, { opacity: 0.85 }, t)
      .to(o, { p: 1, duration: 0.55, ease: 'power3.out', onUpdate: () => { d.t.textContent = scramble(d.text, o.p); } }, t)
      .call(() => { d.t.textContent = d.text; }, [], t + 0.56);
  });
  // the spark rests inside the reactor until the ignition
  tl.to([dot, halo], { opacity: 0, duration: 0.4, ease: 'power1.in' }, T.stillAt - 0.2);
  for (let i = 0; i < 9; i++) tl.call(() => sfx.introTick(i + 3), [], T.mainAt + 1.2 + 0.12 * i);

  // ===== ACT 4 — climax: stillness, then ignition =====
  tl.to([ret, ...dataEls.map((d) => d.t)], { opacity: 0.28, duration: 0.18, ease: 'power2.out' }, T.stillAt)
    .call(() => hud.setFrozen(true), [], T.stillAt)
    .call(() => hud.setFrozen(false), [], T.stillAt + T.stillLen)
    // the white flash, an impact that shakes the frame, one ripple + its echo, a chromatic split on the title
    .call(() => sfx.introImpact(), [], T.igniteAt)
    .set(flash, { opacity: 0.7 }, T.igniteAt)
    .to(flash, { opacity: 0, duration: 0.55, ease: 'expo.out' }, T.igniteAt + 0.02)
    .to(root, { keyframes: [{ x: -7, y: 3, duration: 0.03 }, { x: 6, y: -4, duration: 0.04 }, { x: -3, y: 2, duration: 0.05 }, { x: 0, y: 0, duration: 0.14, ease: 'power2.out' }] }, T.igniteAt)
    .to(ret, { opacity: 1, duration: 0.1 }, T.igniteAt);
  echo.forEach((c, i) => {
    tl.fromTo(c, { opacity: 0.8, attr: { r: 60, 'stroke-width': 3 } }, { opacity: 0, attr: { r: 470 + i * 60, 'stroke-width': 0.4 }, duration: 1.1 + i * 0.2, ease: 'expo.out', immediateRender: false }, T.igniteAt + 0.05 + i * 0.16);
  });
  const tp = { p: 0 };
  tl.set(title, { opacity: 1 }, T.titleAt)
    .to(tp, { p: 1, duration: 0.8, ease: 'power3.out', onUpdate: () => { title.textContent = scramble(TITLE, tp.p); } }, T.titleAt)
    .to(title, { attr: { 'letter-spacing': '0.42em' }, duration: 1.0, ease: 'expo.out' }, T.titleAt)
    .fromTo(title, { filter: 'drop-shadow(-9px 0 0 rgba(255,60,90,.65)) drop-shadow(9px 0 0 rgba(0,229,255,.9)) drop-shadow(0 0 22px rgba(0,229,255,.7))' },
      { filter: 'drop-shadow(0 0 0 rgba(255,60,90,0)) drop-shadow(0 0 0 rgba(0,229,255,0)) drop-shadow(0 0 22px rgba(0,229,255,.7))', duration: 0.6, ease: 'expo.out', immediateRender: false }, T.titleAt);

  // ===== ACT 5 — greeting: ONLINE, a hello for the time of day =====
  tl.call(() => sfx.introGreet(), [], T.greetAt)
    .to(online, { opacity: 1, duration: 0.35 }, T.greetAt)
    .fromTo(online, { attr: { 'letter-spacing': '0.9em' } }, { attr: { 'letter-spacing': '0.5em' }, duration: 0.9, ease: 'expo.out', immediateRender: false }, T.greetAt)
    .fromTo(greet, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5, immediateRender: false }, T.greetAt + 0.25)
    .to([title, online, greet, ret, ...dataEls.map((d) => d.t)], { opacity: 0, duration: T.outLen, ease: 'power2.in' }, T.outAt)
    .to(lines, { opacity: 0, duration: T.outLen }, T.outAt);
  tl.to({}, { duration: 0.001 }, T.length);

  return { tl, root, kill: () => { tl.kill(); root.remove(); hud.setFrozen(false); } };
}
