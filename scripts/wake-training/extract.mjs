// Feature extraction for the custom wake head (dev tool, not shipped).
// usage: node scripts/wake-training/extract.mjs <dataDir> <modelsDir> <outDir>
// dataDir holds <name>.pcm (16 kHz s16le mono) + meta.json from gen-data.js.
// Each clip is augmented (noise / babble / quiet / reverb), streamed through the
// real openWakeWord pipeline, and every labelled 16×96 feature window is saved.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const FRAME = 1280;
const DIM = 1536;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function readPcm(file) {
  const b = fs.readFileSync(file);
  const out = new Float32Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2) / 32768;
  return out;
}

const rms = (a) => { let s = 0; for (const x of a) s += x * x; return Math.sqrt(s / Math.max(1, a.length)); };

function noise(n, kind, r) {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    if (kind === 'white') out[i] = w;
    else if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527; out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    else { last = (last + 0.02 * w) / 1.02; out[i] = last * 3.5; }
  }
  return out;
}

/** Cheap Schroeder reverb (4 combs + 2 allpasses). */
function reverb(x, r) {
  const sr = 16000;
  const rt = 0.25 + r() * 0.5;
  const out = new Float32Array(x.length);
  for (const ms of [29.7, 37.1, 41.1, 43.7]) {
    const d = Math.round((ms * sr) / 1000);
    const g = Math.pow(10, (-3 * d) / (rt * sr));
    const buf = new Float32Array(d);
    for (let i = 0, p = 0; i < x.length; i++, p = (p + 1) % d) {
      const y = buf[p];
      buf[p] = x[i] + y * g;
      out[i] += y * 0.25;
    }
  }
  for (const ms of [5, 1.7]) {
    const d = Math.round((ms * sr) / 1000);
    const buf = new Float32Array(d);
    for (let i = 0, p = 0; i < out.length; i++, p = (p + 1) % d) {
      const y = buf[p];
      const v = out[i] + y * 0.7;
      buf[p] = v;
      out[i] = y - 0.7 * v;
    }
  }
  const wet = 0.3 + r() * 0.4;
  for (let i = 0; i < x.length; i++) out[i] = x[i] * (1 - wet) + out[i] * wet;
  return out;
}

/** Speech region of the clean clip, in 80 ms frames. */
function speechFrames(clip) {
  const fr = [];
  for (let o = 0; o + FRAME <= clip.length; o += FRAME) fr.push(rms(clip.subarray(o, o + FRAME)));
  const peak = Math.max(...fr, 1e-6);
  const thr = Math.max(0.01, peak * 0.12);
  let a = -1, z = -1;
  fr.forEach((v, i) => { if (v > thr) { if (a < 0) a = i; z = i; } });
  return { a, z };
}

if (isMainThread) {
  const [dataDir, modelsDir, outDir] = process.argv.slice(2);
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  const n = Math.max(2, Math.min(12, os.cpus().length - 2));
  const babble = meta.filter((m) => m.cls === 'neg' && m.split === 'train').map((m) => m.name);
  const parts = Array.from({ length: n }, () => []);
  meta.forEach((m, i) => parts[i % n].push(m));
  const t0 = Date.now();
  const results = await Promise.all(parts.map((list, w) => new Promise((res, rej) => {
    const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { list, dataDir, modelsDir, babble, seed: 1000 + w } });
    wk.on('message', res);
    wk.on('error', rej);
  })));
  let total = 0;
  let pos = 0;
  results.forEach((r, i) => {
    fs.writeFileSync(path.join(outDir, `X${i}.f32`), Buffer.from(r.X));
    fs.writeFileSync(path.join(outDir, `y${i}.i8`), Buffer.from(r.y));
    fs.writeFileSync(path.join(outDir, `base${i}.f32`), Buffer.from(r.base));
    fs.writeFileSync(path.join(outDir, `info${i}.json`), JSON.stringify(r.info));
    total += r.info.length;
    pos += new Int8Array(r.y).filter((v) => v === 1).length;
  });
  fs.writeFileSync(path.join(outDir, 'shards.json'), JSON.stringify(results.length));
  console.log(`windows ${total} (pos ${pos}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else {
  const ort = await import('onnxruntime-web');
  const { WakeDetector } = await import('../../renderer/handsfree/oww.js');
  ort.env.wasm.numThreads = 1;
  const { list, dataDir, modelsDir, babble, seed } = workerData;
  const rd = (f) => fs.readFileSync(path.join(modelsDir, f));
  const det = await WakeDetector.create(ort, { mel: rd('melspectrogram.onnx'), emb: rd('embedding_model.onnx'), wake: rd('hey_jarvis_v0.1.onnx') });
  const r = rng(seed);
  const X = [];
  const y = [];
  const base = [];
  const info = [];
  for (const m of list) {
    const clip = readPcm(path.join(dataDir, m.name + '.pcm'));
    const sp = speechFrames(clip);
    if (sp.a < 0) continue;
    const S = rms(clip.subarray(sp.a * FRAME, (sp.z + 1) * FRAME)) || 0.05;
    const kinds = m.cls === 'pos' ? ['clean', 'noise', 'babble', 'quiet', 'reverb'] : (m.split === 'test' ? ['clean', 'noise'] : ['clean', ['noise', 'babble', 'quiet', 'reverb'][Math.floor(r() * 4)]]);
    for (const kind of kinds) {
      const shift = Math.floor(r() * FRAME);
      const pre = 20 * FRAME + shift; // 1.6 s + jitter: warm-up and alignment variety
      const len = pre + clip.length + 14 * FRAME;
      let a = new Float32Array(len);
      const g = kind === 'quiet' ? 0.12 + r() * 0.35 : 0.6 + r() * 0.5;
      for (let i = 0; i < clip.length; i++) a[pre + i] = clip[i] * g;
      if (kind === 'reverb') a = reverb(a, r);
      const snr = kind === 'noise' ? 5 + r() * 20 : kind === 'babble' ? 25 : 45 + r() * 15;
      const nz = noise(len, ['white', 'pink', 'brown'][Math.floor(r() * 3)], r);
      const nr = rms(nz) || 1;
      const k = (S * g) / Math.pow(10, snr / 20) / nr;
      for (let i = 0; i < len; i++) a[i] += nz[i] * k;
      if (kind === 'babble') {
        const b = readPcm(path.join(dataDir, babble[Math.floor(r() * babble.length)] + '.pcm'));
        const bk = Math.pow(10, -(10 + r() * 10) / 20) * g;
        for (let i = 0; i < len; i++) a[i] += b[i % b.length] * bk;
      }
      await det.reset();
      const startF = Math.floor(pre / FRAME) + sp.a;
      const endF = Math.floor(pre / FRAME) + sp.z;
      const frames = Math.floor(len / FRAME);
      for (let f = 0; f < frames; f++) {
        const s = await det.wake(a.subarray(f * FRAME, (f + 1) * FRAME));
        if (f < 17) continue; // warm-up
        let lab;
        if (m.cls === 'pos') {
          if (f >= endF + 1 && f <= endF + 5) lab = 1;
          else if (f < startF || f > endF + 13) { if (f % 5) continue; lab = 0; }
          else if (f < endF - 2) lab = 0; // partial word (e.g. "จา", "เฮ้") → negative
          else continue;
        } else {
          lab = 0;
          if (m.split === 'train' && f % 2) continue;
        }
        X.push(Float32Array.from(det.x));
        y.push(lab);
        base.push(s.base);
        info.push([m.name, kind, f, m.split === 'test' ? 1 : 0, m.hard ? 1 : 0]);
      }
    }
  }
  const flat = new Float32Array(X.length * DIM);
  X.forEach((x, i) => flat.set(x, i * DIM));
  parentPort.postMessage({ X: flat.buffer, y: Int8Array.from(y).buffer, base: Float32Array.from(base).buffer, info }, [flat.buffer]);
}
