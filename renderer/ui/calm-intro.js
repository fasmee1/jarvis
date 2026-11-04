// Calm style boot intro (7.5 s): one galaxy of stars turns into JARVIS (arms → energy ribbons,
// disc → orbits, bright stars → satellites, the rest → the letters of the name). It animates the REAL parts (holo core, orbits, grid, wordmark, chrome)
// from ui/calm-intro-timeline.js, so the last frame is the live home screen. Click / key /
// voice skips smoothly (≤ 250 ms). The startup check line shows only real results
// (ui/startup-checks.js, reported by app.js).

import { CORE } from './layout.js';
import { ORBITS, SATS } from './orbits.js';
import { buildStars, buildDeep, starPos } from './calm-intro-stars.js';
import { INTRO, FINAL, introFrame, galaxyAngle, decodeText, easeOut } from './calm-intro-timeline.js';
import { startupChecks } from './startup-checks.js';

const NAME = 'J.A.R.V.I.S';
const SKIP_MS = 250;
const $ = (id) => document.getElementById(id);

/** Sample the wordmark's letters (px relative to the core centre) so stars can form them. */
function sampleLetters() {
  try {
    const cv = document.createElement('canvas');
    cv.width = 560;
    cv.height = 120;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.font = "300 40px 'Rajdhani', sans-serif";
    ctx.letterSpacing = '20.8px'; // 0.52em, like .core-mark
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const w = ctx.measureText(NAME).width - 20.8; // the trailing spacing is not visible
    ctx.fillText(NAME, (cv.width - w) / 2, cv.height / 2 + 1);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const pts = [];
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3] > 140) pts.push([x - cv.width / 2, y - cv.height / 2]);
    return pts;
  } catch { return []; }
}

/** The same morph in 2D (no WebGL): fewer stars, drawn with the reference math. */
function makeStars2D(layer, data) {
  const cv = document.createElement('canvas');
  cv.className = 'ci-stars';
  cv.width = 1920;
  cv.height = 1080;
  layer.prepend(cv);
  const ctx = cv.getContext('2d');
  const n = Math.min(data.stars.n, 2600);
  const out = [];
  return {
    resize() {},
    frame(f, angle, sec, sat) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, 1920, 1080);
      ctx.globalCompositeOperation = 'lighter';
      const { deep } = data;
      ctx.fillStyle = '#A0D0FF';
      for (let i = 0; i < deep.n; i += 2) {
        const layerK = deep.pos[i * 3 + 2];
        const x = ((deep.pos[i * 3] + 1000 + sec * (3 + layerK * 6)) % 2000) - 1000;
        ctx.globalAlpha = f.deep * (0.35 + 0.2 * layerK) * 0.8;
        ctx.fillRect(CORE.x + x, CORE.y + deep.pos[i * 3 + 1], 1 + layerK * 0.8, 1 + layerK * 0.8);
      }
      for (let i = 0; i < n; i++) {
        starPos(data.stars, i, f, angle, sat, out);
        if (out[2] <= 0.002) continue;
        ctx.globalAlpha = Math.min(1, out[2]);
        ctx.fillStyle = out[4] ? '#FF9B45' : i % 3 ? '#70DFFF' : '#9CC8FF';
        const z = out[3];
        ctx.fillRect(CORE.x + out[0] - z / 2, CORE.y + out[1] - z / 2, z, z);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    },
    dispose() { cv.remove(); },
  };
}

/**
 * The star field renderer: WebGL (vendor/holo-core.min.js) with the 2D version as fallback.
 * Always resolves to something that can draw frames.
 */
async function makeStars(layer, home) {
  const low = home.quality === 'low';
  const [mod] = await Promise.all([
    import('./vendor/holo-core.min.js').catch(() => null),
    document.fonts && document.fonts.load ? document.fonts.load("300 40px 'Rajdhani'").catch(() => {}) : null,
  ]);
  const data = {
    stars: buildStars({ n: low ? 3500 : 9000, orbits: ORBITS, letters: sampleLetters() }),
    deep: buildDeep(low ? 260 : 520),
  };
  if (mod && mod.createIntroStars) {
    const cv = document.createElement('canvas');
    cv.className = 'ci-stars';
    layer.prepend(cv);
    try {
      const gl = mod.createIntroStars(cv, { ...data, quality: home.quality });
      gl.resize(home.t ? home.t.scale : 1);
      return { frame: (...a) => gl.frame(...a), dispose: () => { gl.dispose(); cv.remove(); } };
    } catch (err) {
      console.warn('[intro] WebGL unavailable, drawing the stars in 2D:', err && err.message);
      cv.remove();
    }
  }
  return makeStars2D(layer, data);
}

function h(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.append(e);
  return e;
}

/** Blend two intro frames (skip: from where we are to FINAL). */
function mixFrame(a, b, k) {
  const out = {};
  for (const key of Object.keys(b)) {
    const x = a[key], y = b[key];
    out[key] = Array.isArray(y) ? y.map((v, i) => x[i] + (v - x[i]) * k) : x + (y - x) * k;
  }
  return out;
}

/** The real startup check line under the core. Stays until every check has settled. */
function checkLine(stage) {
  const el = h('div', 'ci-checks', stage);
  el.setAttribute('aria-live', 'polite');
  el.style.left = `${CORE.x}px`;
  el.style.top = `${CORE.y + 452}px`; // below the reactor and the background-task chip
  const rows = new Map();
  startupChecks.list().forEach((it, i) => {
    const row = h('span', 'ci-ck', el);
    row.style.animationDelay = `${0.75 + i * 0.12}s`;
    const mk = h('i', 'ci-mk', row);
    mk.setAttribute('aria-hidden', 'true');
    h('span', 'ci-lb', row).textContent = it.label;
    const why = h('em', 'ci-why', row);
    rows.set(it.id, { row, mk, why });
  });
  const paint = (it) => {
    const r = rows.get(it.id);
    if (!r) return;
    r.row.dataset.state = it.state;
    r.mk.textContent = it.state === 'ok' ? '✓' : it.state === 'fail' ? '!' : '';
    r.why.textContent = it.state === 'fail' ? it.text : '';
  };
  startupChecks.list().forEach(paint);
  const off = startupChecks.on(paint);
  let gone = false;
  const remove = () => {
    if (gone) return;
    gone = true;
    off();
    el.classList.add('out');
    setTimeout(() => el.remove(), 600);
  };
  return {
    el,
    /** After the intro: leave now if settled, else when the last check settles (+1.5 s to read it). */
    release() {
      if (startupChecks.settled) { remove(); return; } // already faded out with the intro
      el.classList.add('held');
      el.style.opacity = '1';
      const off2 = startupChecks.on(() => { if (startupChecks.settled) { off2(); setTimeout(remove, 1500); } });
    },
  };
}

/**
 * @param {object} o
 * @param {import('./home.js').Home} o.home
 * @param {object} o.sfx
 * @param {Function} o.ready      emits app:ready + resolves the caller
 * @param {Function} o.greetIn    schedules the optional voice greeting
 * @param {Function} o.chimeOnly  plain ready chime + greeting (skip path)
 */
export function playCalmIntro({ home, sfx, overlay, ready, greetIn, chimeOnly }) {
  const body = document.body;
  const stage = $('stage');
  body.classList.add('calm-intro');
  overlay.hidden = true;

  // ---------- intro-only layer: haze, ignition flash and the star field ----------
  const layer = h('div', 'ci-layer', stage);
  layer.setAttribute('aria-hidden', 'true');
  const haze = h('div', 'ci-haze', layer);
  const flash = h('div', 'ci-flash', layer);
  for (const e of [haze, flash]) { e.style.left = `${CORE.x}px`; e.style.top = `${CORE.y}px`; }
  let stars = null;
  let starsGone = false;
  makeStars(layer, home).then((s2) => {
    if (starsGone) { s2.dispose(); return; } // the intro ended before the stars were ready
    stars = s2;
  });
  const satPos = new Array(16).fill(0);
  const checks = checkLine(stage);

  // ---------- the real parts ----------
  const grids = [$('grid-bg'), $('grid-fx')];
  const mark = $('core-mark');
  mark.dataset.sweep = NAME;
  const B = home.core.beginBoot([]); // the 2D reactor follows too (it is what shows without WebGL)
  const ticks = home.ticks && home.ticks.over; // the fine degree ring
  const readout = document.querySelector('#core-wrap .core-readout');
  const allBtn = document.querySelector('.dock-all-btn');
  const chrome = [
    ['#hamburger', '#btn-hud-sound', '#btn-handsfree', '.model-pick', '.caption', '.corner-brk', '#proj-home', '#proj-chip'].flatMap((s) => [...document.querySelectorAll(s)]),
    [readout],
    [allBtn],
  ].map((g) => g.filter(Boolean));
  const LIFT = [-6, 8, 8]; // px the group travels while it fades in
  home.booting = true;
  $('state-label').textContent = '';

  let t0 = performance.now();
  let raf = 0, done = false, skipping = null, last = null, rippled = false, lastDecode = 0, angle = 0;
  const cues = [
    [0.15, () => sfx.introHum(5)], // the room tone climbs under the galaxy
    [2.4, () => sfx.introPulse(0.7)], // the pull begins
    [INTRO.igniteAt, () => { sfx.introImpact(); home.core.wake(); }], // the core lights up: impact + first ripple
    [4.7, () => sfx.introTick(0)], [4.85, () => sfx.introTick(1)], [5.0, () => sfx.introTick(2)], // the orbits lock in
    [5.6, () => sfx.introTick(3)], [5.7, () => sfx.introTick(4)], [5.8, () => sfx.introTick(5)], // the satellites arrive
    [INTRO.rippleAt, () => {
      rippled = true;
      home.core.wake(); // the handoff ripple
      sfx.ready();
      greetIn(450); // the greeting (if on and a Thai voice exists) lands in the handoff
      home.booting = false;
      home.applyLabel();
    }],
  ];

  function apply(f, now) {
    const sec = (now - t0) / 1000;
    if (stars) {
      SATS.forEach((sat, i) => {
        const p = home.orbit.pointOf(sat.id);
        satPos[i * 2] = p ? p.x - CORE.x : 0;
        satPos[i * 2 + 1] = p ? p.y - CORE.y : 0;
      });
      stars.frame(f, angle, sec, satPos);
    }
    haze.style.opacity = (f.haze * (0.85 + 0.15 * Math.sin(sec * 1.3))).toFixed(3);
    haze.style.transform = `translate(-50%, -50%) scale(${((0.55 + 0.6 * f.gform) * f.zoom).toFixed(3)})`;
    flash.style.opacity = Math.min(1, f.flash).toFixed(3);
    flash.style.transform = `translate(-50%, -50%) scale(${(0.4 + f.flash * 1.1).toFixed(3)})`;
    for (const g of grids) g.style.opacity = f.grid.toFixed(3);

    // core (WebGL) + 2D fallback reactor
    home.core.intro = f;
    B.rings = Math.min(1, f.glow);
    B.arc = f.draw;
    B.lines = Math.round(72 * f.draw);
    B.logo = f.markA; // CoreSwitch writes this to the wordmark's opacity
    if (ticks) ticks.style.opacity = Math.min(1, f.glow).toFixed(3);

    // wordmark: decode, then one light sweep
    if (f.decode < 1) {
      if (now - lastDecode > 45) { lastDecode = now; mark.textContent = decodeText(NAME, f.decode); }
    } else if (mark.textContent !== NAME) mark.textContent = NAME;
    mark.style.setProperty('--sw', f.sweep.toFixed(4));

    home.orbit.setIntro(f);

    chrome.forEach((els, i) => {
      const c = f.chrome[i];
      for (const e of els) {
        e.style.opacity = c.toFixed(3);
        e.style.translate = c < 1 ? `0 ${(LIFT[i] * (1 - c)).toFixed(2)}px` : '';
      }
    });
    // a check still pending at the end stays on screen (release() takes it from there)
    const ck = !startupChecks.settled && f.checks < 1 && f.markA > 0 ? 1 : f.checks;
    checks.el.style.opacity = ck.toFixed(3);
  }

  function tick(now) {
    if (done) return;
    raf = requestAnimationFrame(tick);
    const t = (now - t0) / 1000;
    let f;
    if (skipping) {
      const k = Math.min(1, (now - skipping.at) / SKIP_MS);
      f = mixFrame(skipping.from, FINAL, easeOut(k));
      if (k >= 1) { finish(true); return; }
    } else {
      for (const c of cues) if (!c.fired && t >= c[0]) { c.fired = true; c[1](); }
      f = introFrame(t);
      angle = galaxyAngle(t);
      // voice activity (the user is talking) takes over at once
      if (home.state === 'LISTENING' || home.state === 'FOLLOW_UP') { skip(); return; }
      if (t >= INTRO.total) { apply(FINAL, now); finish(false); return; }
    }
    last = f;
    apply(f, now);
  }

  function skip(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (done || skipping) return;
    sfx.quiet(400); // no click blip for the skip itself
    skipping = { at: performance.now(), from: last || introFrame(0) };
  }

  function finish(skipped) {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    removeEventListener('keydown', skip, true);
    removeEventListener('mousedown', skip, true);
    home.core.intro = null;
    home.core.endBoot();
    home.orbit.setIntro(null);
    for (const g of grids) g.style.opacity = '';
    starsGone = true;
    if (stars) stars.dispose();
    mark.textContent = NAME;
    delete mark.dataset.sweep;
    mark.style.removeProperty('--sw');
    mark.style.opacity = '';
    if (ticks) ticks.style.opacity = '';
    for (const els of chrome) for (const e of els) { e.style.opacity = ''; e.style.translate = ''; }
    layer.remove();
    checks.release();
    body.classList.remove('booting', 'calm-intro');
    home.booting = false;
    home.applyLabel();
    if (skipped && !rippled) {
      sfx.fadeGroup('boot', 0.2);
      setTimeout(chimeOnly, 200);
    }
    ready();
  }

  addEventListener('keydown', skip, true);
  addEventListener('mousedown', skip, true);
  apply(introFrame(0), t0);
  t0 = performance.now();
  raf = requestAnimationFrame(tick);
}
