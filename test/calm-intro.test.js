'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/ui/calm-intro-timeline.js');
const loadStars = () => import('../renderer/ui/calm-intro-stars.js');

// every scalar of a frame, flattened, so frames can be compared value by value
function flat(f) {
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v)) v.forEach((x, i) => { out[`${k}${i}`] = x; });
    else out[k] = v;
  }
  return out;
}

test('calm intro: lasts at least 7 seconds', async () => {
  const { INTRO } = await load();
  assert.ok(INTRO.total >= 7);
});

test('calm intro: every curve is continuous (1 ms steps, no jumps)', async () => {
  const { introFrame, INTRO } = await load();
  let prev = flat(introFrame(0));
  for (let t = 0.001; t <= INTRO.total + 0.01; t += 0.001) {
    const cur = flat(introFrame(t));
    for (const k of Object.keys(cur)) {
      const lim = k === 'spin' ? 0.08 : 0.03; // spin is a speed boost up to 6×
      assert.ok(Math.abs(cur[k] - prev[k]) < lim, `${k} jumps at t=${t.toFixed(3)}: ${prev[k]} → ${cur[k]}`);
    }
    prev = cur;
  }
});

test('calm intro: ends exactly on the final state', async () => {
  const { introFrame, INTRO, FINAL } = await load();
  assert.deepEqual(flat(introFrame(INTRO.total)), flat(FINAL));
  const almost = flat(introFrame(INTRO.total - 1e-6));
  for (const [k, v] of Object.entries(flat(FINAL))) assert.ok(Math.abs(almost[k] - v) < 1e-3, `${k} is ${almost[k]} just before the end`);
});

test('calm intro: starts from deep space (nothing assembled yet)', async () => {
  const { introFrame } = await load();
  const f = introFrame(0);
  for (const k of ['haze', 'deep', 'gform', 'coreM', 'orbitM', 'letM', 'satM', 'grid', 'gather', 'draw', 'glow', 'spin', 'warm', 'flash', 'markA', 'decode', 'checks']) assert.equal(f[k], 0, k);
  assert.ok(f.orbits.every((x) => x === 0) && f.sats.every((x) => x === 0) && f.chrome.every((x) => x === 0));
});

test('calm intro: reduced motion returns the final state at once', async () => {
  const { introFrame, FINAL } = await load();
  for (const t of [0, 0.5, 2, 3.5, 5, 7]) assert.equal(introFrame(t, { reduced: true }), FINAL);
});

test('calm intro: values stay in range and the orange accent is one pulse', async () => {
  const { introFrame, INTRO } = await load();
  let peaks = 0, prev = 0, rising = false;
  for (let t = 0; t <= INTRO.total; t += 0.005) {
    const f = flat(introFrame(t));
    for (const [k, v] of Object.entries(f)) {
      const max = k === 'spin' ? 6 : k === 'glow' ? 1.35 : k === 'zoom' ? 1.4 : 1;
      assert.ok(v >= 0 && v <= max + 1e-9, `${k}=${v} at ${t}`);
    }
    if (f.warm < prev && rising) peaks++;
    rising = f.warm > prev;
    prev = f.warm;
  }
  assert.equal(peaks, 1);
});

test('calm intro: the roles hand over in order (core → orbits → satellites → letters)', async () => {
  const { introFrame } = await load();
  const at = (k, v) => { for (let t = 0; t < 7.5; t += 0.01) if (introFrame(t)[k] >= v) return t; return Infinity; };
  assert.ok(at('coreM', 1) < at('satM', 1));
  assert.ok(at('satM', 1) < at('letM', 1));
  assert.ok(at('orbitM', 0.01) < at('coreM', 0.01)); // the pull starts before the core forms
  assert.ok(at('glow', 1.2) > at('gform', 0.9)); // the galaxy exists before the core ignites
});

test('calm intro: galaxy rotation is continuous, speeds up, never goes back', async () => {
  const { galaxyAngle } = await load();
  let prev = galaxyAngle(0), prevStep = 0;
  for (let t = 0.001; t <= 7.5; t += 0.001) {
    const a = galaxyAngle(t);
    const step = a - prev;
    assert.ok(step >= 0 && step < 0.003, `step ${step} at ${t}`);
    if (t > 2.3 && t < 4.1) assert.ok(step >= prevStep - 1e-9, 'accelerating through the pull');
    prev = a; prevStep = step;
  }
});

test('calm intro: wordmark decode keeps the dots and lands on the name', async () => {
  const { decodeText } = await load();
  const s = decodeText('J.A.R.V.I.S', 0.3, () => 0);
  assert.equal(s.length, 11);
  for (let i = 1; i < 11; i += 2) assert.equal(s[i], '.');
  assert.equal(decodeText('J.A.R.V.I.S', 1), 'J.A.R.V.I.S');
});

// ---------- star field ----------
const ORB = [{ rx: 470, ry: 190, rot: -5 }, { rx: 602, ry: 226, rot: -4 }, { rx: 735, ry: 262, rot: -3 }];
const LETTERS = Array.from({ length: 60 }, (_, i) => [-180 + i * 6, (i % 7) - 3]);

test('calm intro stars: deterministic, every role present, 8 satellites', async () => {
  const { buildStars, ROLE } = await loadStars();
  const a = buildStars({ n: 3000, orbits: ORB, letters: LETTERS });
  const b = buildStars({ n: 3000, orbits: ORB, letters: LETTERS });
  assert.deepEqual(Array.from(a.g.slice(0, 60)), Array.from(b.g.slice(0, 60)));
  const count = (r) => a.role.filter((x) => x === r).length;
  assert.equal(count(ROLE.sat), 8);
  for (const r of [ROLE.core, ROLE.orbit, ROLE.letters, ROLE.dust]) assert.ok(count(r) > 100, `role ${r}`);
});

test('calm intro stars: without letter samples no star is left waiting for a letter', async () => {
  const { buildStars, ROLE } = await loadStars();
  const s = buildStars({ n: 1000, orbits: ORB, letters: [] });
  assert.equal(s.role.filter((x) => x === ROLE.letters).length, 0);
});

test('calm intro stars: each role lands on its real target when its morph is done', async () => {
  const { buildStars, starPos, ROLE } = await loadStars();
  const { FINAL } = await load();
  const S = buildStars({ n: 800, orbits: ORB, letters: LETTERS });
  const sat = Array.from({ length: 16 }, (_, i) => 100 + i * 7);
  const out = [];
  const f = { ...FINAL, fCore: 1, fOrbit: 1, fLet: 1, fSat: 1, dust: 1 };
  for (let i = 0; i < S.n; i++) {
    if (S.role[i] === ROLE.dust) continue;
    starPos(S, i, f, 3, sat, out);
    const k = S.role[i] === ROLE.sat ? S.t[i * 3 + 2] * 2 : -1;
    const tx = k >= 0 ? sat[k] : S.t[i * 3], ty = k >= 0 ? sat[k + 1] : S.t[i * 3 + 1];
    assert.ok(Math.hypot(out[0] - tx, out[1] - ty) < 1e-3, `star ${i} (role ${S.role[i]}) misses its target`);
  }
});

test('calm intro stars: invisible before the galaxy forms and after the hand-over', async () => {
  const { buildStars, starPos } = await loadStars();
  const { introFrame, FINAL } = await load();
  const S = buildStars({ n: 400, orbits: ORB, letters: LETTERS });
  const sat = new Array(16).fill(0);
  const out = [];
  for (let i = 0; i < S.n; i++) {
    starPos(S, i, introFrame(0), 0, sat, out);
    assert.equal(out[2], 0);
    starPos(S, i, FINAL, 0, sat, out);
    assert.equal(out[2], 0);
  }
});
