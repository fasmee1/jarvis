// Calm style boot intro: the timeline math (pure, no DOM). introFrame(t) gives every
// animated part its progress at time t (seconds); ui/calm-intro.js applies it to the star
// field (ui/calm-intro-stars.js) and to the real core, orbits, wordmark and chrome.
// One galaxy of stars turns into JARVIS: arms → energy ribbons, disc → orbits, a few bright
// stars → satellites, the rest → the letters of the name. Every value is continuous in t and
// lands exactly on FINAL at INTRO.total, so the last intro frame is the live home screen.

export const INTRO = {
  total: 7.5,
  igniteAt: 4.3, // the core lights up: impact + first ripple
  rippleAt: 6.5, // the handoff ripple, voice greeting
  chrome: 3,
  orbits: 3,
  sats: 8,
};

/** The resting state: what the home screen looks like without an intro. */
export const FINAL = Object.freeze({
  haze: 0, deep: 0,
  gform: 1, gcol: 1, coreM: 1, orbitM: 1, letM: 1, satM: 1,
  fCore: 0, fOrbit: 0, fLet: 0, fSat: 0, dust: 0, zoom: 1,
  grid: 1, gather: 1, draw: 1, spin: 0, glow: 1, flash: 0,
  orbits: Object.freeze([1, 1, 1]),
  sats: Object.freeze([1, 1, 1, 1, 1, 1, 1, 1]),
  markA: 1, decode: 1, sweep: 1, warm: 0,
  chrome: Object.freeze([1, 1, 1]),
  checks: 0,
});

const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 0 → 1 between a and b. */
const span = (t, a, b) => clamp((t - a) / (b - a));
export const easeOut = (x) => 1 - Math.pow(1 - x, 3);
export const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const expoOut = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
/** Rises and falls back to 0 between a and b (sin bump). */
const bump = (t, a, b) => Math.sin(Math.PI * span(t, a, b));

/**
 * @param {number} t seconds since the intro started
 * @param {{ reduced?: boolean }} [o]
 */
export function introFrame(t, { reduced = false } = {}) {
  if (reduced || !(t < INTRO.total)) return FINAL;
  if (t < 0) t = 0;

  // 1. DEEP SPACE → 2. GALAXY BIRTH: far stars and a haze, then the galaxy grows from its core
  const deep = easeOut(span(t, 0.1, 0.9)) * (1 - span(t, 6.0, 7.2));
  const haze = easeOut(span(t, 0, 1.5)) * (1 - easeInOut(span(t, 5.2, 6.6)));
  const gform = easeOut(span(t, 0.5, 2.4));

  // 3. THE PULL: the disc tightens (what is left of it) and the camera pushes in, then eases back
  const gcol = easeInOut(span(t, 2.2, 5.6));
  const zoom = 1 + 0.35 * bump(t, 2.0, 5.0);

  // star roles (each star has its own stagger inside its role's window, see calm-intro-stars.js)
  const orbitM = span(t, 2.5, 5.2); // leave the disc along curves, settle on the three orbits
  const coreM = span(t, 3.4, 5.0); // condense into the ribbon bands
  const satM = span(t, 4.9, 5.9); // eight bright stars glide to the satellites
  const letM = span(t, 5.4, 6.5); // gather into the letters of the name
  // when a role's stars have arrived the real part takes over and the stars fade
  const fCore = 1 - span(t, 4.7, 5.6);
  const fOrbit = 1 - span(t, 5.4, 6.4);
  const fSat = 1 - span(t, 5.9, 6.4);
  const fLet = 1 - span(t, 6.7, 7.3);
  const dust = 1 - span(t, 5.0, 7.0);

  // 4. CORE FORMATION: the real holo core draws on while the stars condense; glow overshoots once
  const gather = easeOut(span(t, 3.6, 5.2));
  const draw = easeInOut(span(t, 3.7, 5.1));
  const spin = t < 4.2 ? 6 * easeInOut(span(t, 3.4, 4.2)) : 6 * (1 - expoOut(span(t, 4.2, 6.6)));
  const glow = t < 4.7 ? 1.3 * easeOut(span(t, 3.5, 4.7)) : 1 + 0.3 * (1 - easeInOut(span(t, 4.7, 5.6)));
  const flash = bump(t, 4.2, 5.0);
  const warm = bump(t, 4.5, 5.4);

  // 5. ORBITS & SATELLITES: lines draw on inner → outer, the real satellites fade in
  const orbits = [0, 1, 2].map((i) => easeInOut(span(t, 4.6 + i * 0.15, 5.5 + i * 0.15)));
  const sats = Array.from({ length: INTRO.sats }, (_, i) => easeOut(span(t, 5.7 + i * 0.05, 6.3 + i * 0.05)));

  // 6. IDENTITY: the real wordmark resolves out of the star letters, one light sweep
  const markA = easeOut(span(t, 6.5, 7.0));
  const decode = span(t, 5.9, 6.3); // done before the wordmark fades in: no gibberish over the star letters
  const sweep = easeInOut(span(t, 6.7, 7.3)); // band position: 0 / 1 are both off the text

  // 7. HANDOFF: the grid settles in, chrome fades in 60 ms apart
  const grid = easeOut(span(t, 5.4, 7.0));
  const chrome = [0, 1, 2].map((i) => easeOut(span(t, 6.8 + i * 0.06, 7.3 + i * 0.06)));

  // the real startup check line: in while the galaxy turns, out at the end
  const checks = easeOut(span(t, 0.9, 1.4)) * (1 - span(t, 6.9, INTRO.total));

  return {
    haze, deep, gform, gcol, coreM, orbitM, letM, satM, fCore, fOrbit, fLet, fSat, dust, zoom,
    grid, gather, draw, spin, glow, flash, orbits, sats, markA, decode, sweep, warm, chrome, checks,
  };
}

/**
 * Galaxy rotation angle (rad) at time t: slow at first, speeding up through the pull
 * (angular speed 0.3 → 1.5 rad/s over 2.2–4.2 s). Closed form, so it is continuous and cheap.
 */
export function galaxyAngle(t) {
  const D = 2.0;
  const x = clamp((t - 2.2) / D);
  return 0.3 * t + 1.2 * (D / 3) * x * x * x + 1.2 * Math.max(0, t - 4.2);
}

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Wordmark decode: letters left of p·len are final, the rest cycle (dots and spaces stay). */
export function decodeText(target, p, rnd = Math.random) {
  const n = Math.floor(clamp(p) * target.length);
  let out = '';
  for (let i = 0; i < target.length; i++) {
    const ch = target[i];
    out += i < n || ch === '.' || ch === ' ' ? ch : GLYPHS[Math.floor(rnd() * GLYPHS.length)];
  }
  return out;
}
