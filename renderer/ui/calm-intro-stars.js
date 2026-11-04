// Calm boot intro: the star field data and the per-star morph (pure, no DOM).
// Every star has a galaxy position and a role target; starPos() is the reference math the
// WebGL shader (scripts/holo-core/entry.js, IntroStars) repeats, and the 2D fallback uses it
// directly. Roles: 0 core ribbons · 1 orbits · 2 letters · 3 dust · 4 satellites.

export const ROLE = { core: 0, orbit: 1, letters: 2, dust: 3, sat: 4 };
const TAU = Math.PI * 2;
const R_GALAXY = 840; // galaxy radius, stage px
const PX_PER_UNIT = 280; // same scale as the holo core
const TILT = 1.0; // galaxy plane tilt (rad)
const ROLL = -0.22; // screen roll (rad)
const FOCAL = 2600;

// the real holo core's ribbons (scripts/holo-core/entry.js RIBBONS): radius and Euler tilt
const RIBBONS = [
  { R: 1.0, tilt: [0.62, 0.38, 0.3] },
  { R: 0.96, tilt: [-0.74, 0.5, -0.25] },
  { R: 1.05, tilt: [0.28, -0.86, 0.9] },
  { R: 0.92, tilt: [0.98, -0.32, 1.6] },
  { R: 1.12, tilt: [0.16, 0.2, 0.0] },
];

/** Deterministic PRNG: the galaxy is identical on every launch. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-star stagger inside a role's window: m (0..1) → eased progress. */
export function morph(m, seed) {
  const x = Math.min(1, Math.max(0, m * 1.5 - seed * 0.5));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function ribbonPoint(r) {
  const def = RIBBONS[Math.floor(r() * RIBBONS.length)];
  const th = r() * TAU;
  const rad = def.R * (0.94 + r() * 0.1) * PX_PER_UNIT;
  let x = Math.cos(th) * rad, y = Math.sin(th) * rad, z = (r() - 0.5) * 30;
  // three.js Euler XYZ: v' = Rx · Ry · Rz · v
  const [ax, ay, az] = def.tilt;
  let c = Math.cos(az), s = Math.sin(az);
  [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(ay); s = Math.sin(ay);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(ax); s = Math.sin(ax);
  [y, z] = [y * c - z * s, y * s + z * c];
  return [x, y];
}

function orbitPoint(r, orbits) {
  const q = r();
  const i = q < 0.25 ? 0 : q < 0.6 ? 1 : 2;
  const o = orbits[i];
  const t = r() * TAU;
  const ex = Math.cos(t) * o.rx, ey = Math.sin(t) * o.ry;
  const a = (o.rot * Math.PI) / 180;
  const j = 1.5;
  return [ex * Math.cos(a) - ey * Math.sin(a) + (r() - 0.5) * j, ex * Math.sin(a) + ey * Math.cos(a) + (r() - 0.5) * j];
}

/**
 * @param {{ n: number, orbits: {rx:number,ry:number,rot:number}[], letters: number[][], seed?: number }} o
 *   letters: sample points (px, relative to the core centre) that make up the wordmark
 */
export function buildStars({ n, orbits, letters, seed = 2024 }) {
  const r = rng(seed);
  const role = new Uint8Array(n);
  const sd = new Float32Array(n);
  const size = new Float32Array(n);
  const rn = new Float32Array(n);
  const g = new Float32Array(n * 3);
  const t = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // galaxy: a bulge plus four spiral arms
    let rr, th;
    if (r() < 0.14) {
      rr = Math.abs((r() + r() + r() - 1.5) / 1.5) * 120;
      th = r() * TAU;
    } else {
      const u = Math.pow(r(), 0.62);
      rr = u * R_GALAXY;
      th = Math.floor(r() * 4) * (TAU / 4) + u * 5.2 + (r() - 0.5) * (0.5 - u * 0.25);
    }
    const norm = Math.min(1, rr / R_GALAXY);
    rn[i] = norm;
    g[i * 3] = Math.cos(th) * rr;
    g[i * 3 + 1] = Math.sin(th) * rr;
    g[i * 3 + 2] = (r() - 0.5) * 70 * (1 - norm * 0.6);
    sd[i] = r();
    size[i] = 0.9 + r() * (norm < 0.2 ? 2.4 : 1.7);
    const q = r();
    let ro = q < 0.34 ? ROLE.core : q < 0.74 ? ROLE.orbit : q < 0.9 ? ROLE.letters : ROLE.dust;
    if (ro === ROLE.letters && !letters.length) ro = ROLE.dust;
    role[i] = ro;
    let tx, ty;
    if (ro === ROLE.core) [tx, ty] = ribbonPoint(r);
    else if (ro === ROLE.orbit) [tx, ty] = orbitPoint(r, orbits);
    else if (ro === ROLE.letters) {
      const p = letters[Math.floor(r() * letters.length)];
      tx = p[0] + (r() - 0.5) * 0.8; ty = p[1] + (r() - 0.5) * 0.8;
    } else { tx = g[i * 3] * 1.5; ty = g[i * 3 + 1] * 0.8; }
    t[i * 3] = tx; t[i * 3 + 1] = ty;
  }
  // the first eight stars become the satellites: big, bright, target = a live satellite slot
  for (let k = 0; k < 8 && k < n; k++) {
    role[k] = ROLE.sat;
    size[k] = 6.5;
    t[k * 3 + 2] = k;
  }
  return { n, role, seed: sd, size, rn, g, t };
}

/** Far background stars in three depth layers (x, y in px from the centre; layer 0..2). */
export function buildDeep(n, seed = 77) {
  const r = rng(seed);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (r() - 0.5) * 2000;
    pos[i * 3 + 1] = (r() - 0.5) * 1200;
    pos[i * 3 + 2] = Math.floor(r() * 3);
  }
  return { n, pos };
}

/**
 * Where star i is, and how it looks, at frame f (reference for the shader).
 * @param {number[]} sat live satellite positions relative to the core, [x0, y0, x1, y1, …]
 * @param {number[]} out receives [x, y, alpha, sizePx, orange(0/1), k]
 */
export function starPos(S, i, f, angle, sat, out) {
  const ro = S.role[i], sd = S.seed[i], rn = S.rn[i];
  const m = ro === 0 ? f.coreM : ro === 1 ? f.orbitM : ro === 2 ? f.letM : ro === 3 ? 0 : f.satM;
  const fade = ro === 0 ? f.fCore : ro === 1 ? f.fOrbit : ro === 2 ? f.fLet : ro === 3 ? f.dust : f.fSat;
  const sc = ro === 2 || ro === 3 ? 1 - 0.88 * f.gcol : 1;
  const a = angle * (1.5 - 1.1 * rn);
  const ca = Math.cos(a), sa = Math.sin(a);
  const gx = (S.g[i * 3] * ca - S.g[i * 3 + 1] * sa) * sc;
  const gy = (S.g[i * 3] * sa + S.g[i * 3 + 1] * ca) * sc;
  const gz = S.g[i * 3 + 2] * sc;
  const y2 = gy * Math.cos(TILT) - gz * Math.sin(TILT);
  const z2 = gy * Math.sin(TILT) + gz * Math.cos(TILT);
  const rx = gx * Math.cos(ROLL) - y2 * Math.sin(ROLL);
  const ry = gx * Math.sin(ROLL) + y2 * Math.cos(ROLL);
  const k = FOCAL / (FOCAL - z2);
  const sx = rx * k * f.zoom, sy = ry * k * f.zoom;
  let tx = S.t[i * 3], ty = S.t[i * 3 + 1];
  if (ro === 4) { const s = S.t[i * 3 + 2] * 2; tx = sat[s]; ty = sat[s + 1]; }
  const e = morph(m, sd);
  const dx = tx - sx, dy = ty - sy;
  const bow = (0.12 + 0.2 * sd) * Math.sin(Math.PI * e); // curved path, not a straight line
  const cp = (sd * 7.31) % 1;
  const tw = 0.7 + 0.3 * Math.sin(sd * 60);
  out[0] = sx + dx * e - dy * bow;
  out[1] = sy + dy * e + dx * bow;
  out[2] = fade * Math.min(1, f.gform * 2) * tw * (ro === 4 ? 1 : 1.25) * (1 + 0.9 * (1 - rn));
  out[3] = S.size[i] * (0.7 + 0.3 * k);
  out[4] = cp < 0.05 || (rn < 0.1 && cp < 0.2) ? 1 : 0;
  out[5] = k;
  return out;
}
