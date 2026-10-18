// Train the custom wake head on features from extract.mjs (dev tool, not shipped).
// usage: node scripts/wake-training/train.mjs <featDir> <out.json> [hidden=32] [epochs=24]
// Model: x(1536, standardized) → dense(h, ReLU) → dense(1, sigmoid). The
// standardization is folded into the first layer, so the runtime is a plain MLP.
import fs from 'node:fs';
import path from 'node:path';

const DIM = 1536;
const [featDir, outFile, H0, E0] = process.argv.slice(2);
const H = Number(H0) || 32;
const EPOCHS = Number(E0) || 24;

// ---- load shards ----
const nShards = JSON.parse(fs.readFileSync(path.join(featDir, 'shards.json'), 'utf8'));
let N = 0;
const shards = [];
for (let i = 0; i < nShards; i++) {
  const info = JSON.parse(fs.readFileSync(path.join(featDir, `info${i}.json`), 'utf8'));
  shards.push(info);
  N += info.length;
}
const X = new Float32Array(N * DIM);
const Y = new Int8Array(N);
const BASE = new Float32Array(N);
const INFO = [];
let o = 0;
for (let i = 0; i < nShards; i++) {
  const b = fs.readFileSync(path.join(featDir, `X${i}.f32`));
  X.set(new Float32Array(b.buffer, b.byteOffset, b.length / 4), o * DIM);
  const y = fs.readFileSync(path.join(featDir, `y${i}.i8`));
  Y.set(new Int8Array(y.buffer, y.byteOffset, y.length), o);
  const ba = fs.readFileSync(path.join(featDir, `base${i}.f32`));
  BASE.set(new Float32Array(ba.buffer, ba.byteOffset, ba.length / 4), o);
  INFO.push(...shards[i]);
  o += shards[i].length;
}
const train = [];
const test = [];
for (let i = 0; i < N; i++) (INFO[i][3] ? test : train).push(i);
const trPos = train.filter((i) => Y[i] === 1);
const trNeg = train.filter((i) => Y[i] === 0);
const trHard = trNeg.filter((i) => INFO[i][4]); // confusable words (Java, ชาววิสา, ทาวิส…)
console.log(`N=${N} train pos ${trPos.length} neg ${trNeg.length} · test ${test.length}`);

// ---- standardization (train set) ----
const mean = new Float64Array(DIM);
const sq = new Float64Array(DIM);
for (const i of train) {
  const b = i * DIM;
  for (let d = 0; d < DIM; d++) { const v = X[b + d]; mean[d] += v; sq[d] += v * v; }
}
const std = new Float32Array(DIM);
for (let d = 0; d < DIM; d++) {
  mean[d] /= train.length;
  std[d] = Math.sqrt(Math.max(1e-6, sq[d] / train.length - mean[d] * mean[d]));
}
const Z = new Float32Array(N * DIM);
for (let i = 0; i < N; i++) for (let d = 0; d < DIM; d++) Z[i * DIM + d] = (X[i * DIM + d] - mean[d]) / std[d];

// ---- model ----
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const W1 = new Float32Array(H * DIM).map(() => gauss() * Math.sqrt(2 / DIM));
const B1 = new Float32Array(H);
const W2 = new Float32Array(H).map(() => gauss() * Math.sqrt(1 / H));
let B2 = 0;
const P = [W1, B1, W2];
const M = P.map((p) => new Float32Array(p.length));
const V = P.map((p) => new Float32Array(p.length));
let mB2 = 0, vB2 = 0, step = 0;

const hid = new Float32Array(H);
function forward(i, drop = 0) {
  const b = i * DIM;
  let z = B2;
  for (let j = 0; j < H; j++) {
    let a = B1[j];
    const w = j * DIM;
    for (let d = 0; d < DIM; d++) a += W1[w + d] * Z[b + d];
    a = a > 0 ? a : 0;
    if (drop && rnd() < drop) a = 0;
    else if (drop) a /= 1 - drop;
    hid[j] = a;
    z += a * W2[j];
  }
  return z;
}
const sig = (z) => 1 / (1 + Math.exp(-z));

const gW1 = new Float32Array(H * DIM);
const gB1 = new Float32Array(H);
const gW2 = new Float32Array(H);
function trainBatch(batch, lr, l2) {
  gW1.fill(0); gB1.fill(0); gW2.fill(0);
  let gB2 = 0;
  let loss = 0;
  for (const [i, wt] of batch) {
    const y = Y[i];
    const z = forward(i, 0.1);
    const p = sig(z);
    loss += -wt * (y ? Math.log(p + 1e-7) : Math.log(1 - p + 1e-7));
    const dz = (p - y) * wt;
    gB2 += dz;
    const b = i * DIM;
    for (let j = 0; j < H; j++) {
      gW2[j] += dz * hid[j];
      if (hid[j] <= 0) continue;
      const dh = dz * W2[j];
      gB1[j] += dh;
      const w = j * DIM;
      for (let d = 0; d < DIM; d++) gW1[w + d] += dh * Z[b + d];
    }
  }
  const n = batch.length;
  step++;
  const b1c = 1 - Math.pow(0.9, step);
  const b2c = 1 - Math.pow(0.999, step);
  [gW1, gB1, gW2].forEach((g, k) => {
    const p = P[k], m = M[k], v = V[k];
    for (let q = 0; q < p.length; q++) {
      const gr = g[q] / n + (k !== 1 ? l2 * p[q] : 0);
      m[q] = 0.9 * m[q] + 0.1 * gr;
      v[q] = 0.999 * v[q] + 0.001 * gr * gr;
      p[q] -= (lr * (m[q] / b1c)) / (Math.sqrt(v[q] / b2c) + 1e-8);
    }
  });
  const gr = gB2 / n;
  mB2 = 0.9 * mB2 + 0.1 * gr;
  vB2 = 0.999 * vB2 + 0.001 * gr * gr;
  B2 -= (lr * (mB2 / b1c)) / (Math.sqrt(vB2 / b2c) + 1e-8);
  return loss / n;
}

const score = (i) => sig(forward(i));

// ---- evaluation: clip-level recall and false fires per hour (1.5 s cooldown) ----
function evaluate(idx, thr, getScore) {
  const groups = new Map();
  for (const i of idx) {
    const k = `${INFO[i][0]}|${INFO[i][1]}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  let posClips = 0, hit = 0, early = 0, negFires = 0, negFrames = 0;
  const missed = [];
  for (const [k, list] of groups) {
    list.sort((a, b) => INFO[a][2] - INFO[b][2]);
    const isPos = list.some((i) => Y[i] === 1);
    if (isPos) {
      posClips++;
      if (list.some((i) => Y[i] === 1 && getScore(i) >= thr)) hit++;
      else missed.push(k);
      if (list.some((i) => Y[i] === 0 && getScore(i) >= thr)) early++;
    } else {
      let last = -1e9;
      for (const i of list) {
        negFrames++;
        if (getScore(i) >= thr && INFO[i][2] - last > 19) { negFires++; last = INFO[i][2]; }
      }
    }
  }
  const hours = (negFrames * 0.08) / 3600;
  return { recall: hit / Math.max(1, posClips), posClips, early, fph: negFires / Math.max(1e-9, hours), negFires, hours, missed };
}

// ---- train ----
let hard = [];
const BATCH = 128;
for (let ep = 1; ep <= EPOCHS; ep++) {
  const lr = 1e-3 * (ep > EPOCHS * 0.7 ? 0.3 : 1);
  const negPick = [];
  const nNeg = trPos.length * 2;
  for (let k = 0; k < nNeg; k++) {
    const r3 = k % 3;
    if (r3 === 1 && hard.length) negPick.push(hard[Math.floor(rnd() * hard.length)]);
    else if (r3 === 2 && trHard.length) negPick.push(trHard[Math.floor(rnd() * trHard.length)]);
    else negPick.push(trNeg[Math.floor(rnd() * trNeg.length)]);
  }
  const all = [...trPos.map((i) => [i, 1]), ...negPick.map((i) => [i, 1.5])];
  for (let k = all.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [all[k], all[j]] = [all[j], all[k]]; }
  let loss = 0, nb = 0;
  for (let s = 0; s < all.length; s += BATCH) { loss += trainBatch(all.slice(s, s + BATCH), lr, 1e-4); nb++; }
  if (ep % 3 === 0 || ep === EPOCHS) {
    const sc = trNeg.map((i) => [i, score(i)]).sort((a, b) => b[1] - a[1]);
    hard = sc.slice(0, Math.max(500, Math.floor(trNeg.length * 0.05))).map((x) => x[0]);
    const e = evaluate(test, 0.5, score);
    console.log(`ep ${ep} loss ${(loss / nb).toFixed(4)} · test recall ${(e.recall * 100).toFixed(1)}% fph ${e.fph.toFixed(1)} early ${e.early}`);
  } else console.log(`ep ${ep} loss ${(loss / nb).toFixed(4)}`);
}

// ---- report ----
const cache = new Float32Array(N).fill(-1);
const sc = (i) => (cache[i] >= 0 ? cache[i] : (cache[i] = score(i)));
const testPlain = test.filter((i) => !INFO[i][4]);
for (const thr of [0.5, 0.7, 0.85, 0.9, 0.95, 0.98]) {
  const eh = evaluate(test.filter((i) => INFO[i][4]), thr, sc);
  const ep = evaluate(testPlain.filter((i) => Y[i] === 0), thr, sc);
  console.log(`thr ${thr}: fph confusable words ${eh.fph.toFixed(1)} (${eh.negFires} fires / ${eh.hours.toFixed(2)} h) · fph normal speech ${ep.fph.toFixed(1)} (${ep.negFires} / ${ep.hours.toFixed(2)} h)`);
}
for (const thr of [0.5, 0.7, 0.85, 0.9, 0.95, 0.98]) {
  const e = evaluate(test, thr, sc);
  const b = evaluate(test, thr, (i) => BASE[i]);
  const c = evaluate(test, thr, (i) => Math.max(BASE[i], sc(i)));
  console.log(`thr ${thr}: custom recall ${(e.recall * 100).toFixed(1)}% fph ${e.fph.toFixed(1)} | stock ${(b.recall * 100).toFixed(1)}% fph ${b.fph.toFixed(1)} | max ${(c.recall * 100).toFixed(1)}% fph ${c.fph.toFixed(1)}  (test ${e.posClips} pos clips, ${e.hours.toFixed(2)} h neg)`);
}
const e5 = evaluate(test, 0.5, sc);
const byPhrase = {};
for (const k of e5.missed) { const n = k.split('|')[0]; byPhrase[n] = (byPhrase[n] || 0) + 1; }
console.log('missed at 0.5:', e5.missed.length, JSON.stringify(e5.missed.slice(0, 30)));

// ---- export: fold standardization into layer 1 ----
const w1 = new Array(H * DIM);
const b1 = new Array(H);
for (let j = 0; j < H; j++) {
  let b = B1[j];
  for (let d = 0; d < DIM; d++) {
    const w = W1[j * DIM + d] / std[d];
    w1[j * DIM + d] = +w.toPrecision(5);
    b -= w * mean[d];
  }
  b1[j] = +b.toPrecision(7);
}
fs.writeFileSync(outFile, JSON.stringify({ name: 'jarvis-th', version: 1, inputs: DIM, hidden: H, w1, b1, w2: [...W2].map((v) => +v.toPrecision(6)), b2: +B2.toPrecision(7) }));
console.log('wrote', outFile, (fs.statSync(outFile).size / 1024).toFixed(0), 'KB');
