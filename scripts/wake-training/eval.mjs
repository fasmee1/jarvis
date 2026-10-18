// Check the wake models on real recordings (dev tool).
// usage: node scripts/wake-training/eval.mjs <modelsDir> <file.wav|file.pcm> [...more] [--head renderer/handsfree/models/jarvis-th.json] [--sens medium]
//   modelsDir: folder with melspectrogram.onnx, embedding_model.onnx, hey_jarvis_v0.1.onnx
//              (the app keeps them in %APPDATA%/mee-jarvis/handsfree)
//   .wav: 16-bit PCM (any rate, mono or first channel) · .pcm: raw 16 kHz s16le mono
// Prints every detection (with the app's 1.5 s cooldown) and the cost per 80 ms frame.
import * as ort from 'onnxruntime-web';
import fs from 'node:fs';
import path from 'node:path';
import { WakeDetector, FRAME, THRESHOLDS } from '../../renderer/handsfree/oww.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const headFile = opt('--head', 'renderer/handsfree/models/jarvis-th.json');
const sens = opt('--sens', 'medium');
const [modelsDir, ...files] = args;
const HEAD_THR = { low: 0.95, medium: 0.85, high: 0.7 }; // keep in sync with wake-worker.js

function readAudio(f) {
  const b = fs.readFileSync(f);
  if (f.toLowerCase().endsWith('.pcm')) return Float32Array.from(new Int16Array(b.buffer, b.byteOffset, b.length >> 1), (v) => v / 32768);
  let o = 12, rate = 16000, ch = 1, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4);
    const len = b.readUInt32LE(o + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(o + 10); rate = b.readUInt32LE(o + 12); }
    if (id === 'data') { data = b.subarray(o + 8, o + 8 + len); break; }
    o += 8 + len + (len & 1);
  }
  const n = Math.floor(data.length / 2 / ch);
  const step = rate / 16000;
  const out = new Float32Array(Math.floor(n / step));
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(Math.floor(i * step) * ch * 2) / 32768;
  return out;
}

ort.env.wasm.numThreads = 1;
const rd = (f) => fs.readFileSync(path.join(modelsDir, f));
const det = await WakeDetector.create(ort, { mel: rd('melspectrogram.onnx'), emb: rd('embedding_model.onnx'), wake: rd('hey_jarvis_v0.1.onnx') });
if (headFile && fs.existsSync(headFile)) det.setHead(JSON.parse(fs.readFileSync(headFile, 'utf8')));
let ms = 0, frames = 0;
for (const f of files) {
  await det.reset();
  const a = readAudio(f);
  let last = -1e9;
  const hits = [];
  for (let o = 0; o + FRAME <= a.length; o += FRAME) {
    const t = performance.now();
    const s = await det.wake(a.subarray(o, o + FRAME));
    ms += performance.now() - t;
    frames++;
    const sec = o / 16000;
    if ((s.base >= THRESHOLDS[sens] || s.custom >= HEAD_THR[sens]) && sec - last > 1.5) {
      last = sec;
      hits.push(`${sec.toFixed(2)}s (${s.base >= THRESHOLDS[sens] ? 'hey_jarvis' : 'จาร์วิส'} ${Math.max(s.base, s.custom).toFixed(3)})`);
    }
  }
  console.log(`${path.basename(f)} · ${(a.length / 16000).toFixed(1)} s · ${hits.length} detection(s)${hits.length ? ': ' + hits.join(', ') : ''}`);
}
console.log(`cost: ${(ms / frames).toFixed(2)} ms per 80 ms frame ≈ ${((ms / frames / 80) * 100).toFixed(1)}% of one core`);
