// Hands-free audio worker: wake word + VAD + command recording, off the UI thread.
// Audio arrives as 80 ms Float32 frames on a MessagePort straight from the
// AudioWorklet. Nothing here touches the network: audio is only handed back
// to the page after the wake word (or a follow-up / barge-in), as one
// recorded command.
//
// Modes (set by the page, or switched here at the exact audio frame):
//   paused   ignore audio
//   hold     keep the wake features current, emit nothing (e.g. while transcribing)
//   wake     listen for the wake word                       → 'wake' (+ auto 'command')
//   speaking TTS is playing: only a confident wake counts;  → 'wake' | 'suppressed' | 'barge-voice'
//            optional voice barge-in (sustained clear speech)
//   command  record until 1.2 s of silence / 15 s / no speech in 4 s → 'speech-start', 'end'
//   follow   follow-up window: speech starts → auto 'command'; else 'follow-timeout'
import * as ort from '../../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs';
import { WakeDetector, FRAME, THRESHOLDS, TTS_THRESHOLD } from './oww.js';

const MS = 80; // per frame
const COOLDOWN = Math.ceil(1500 / MS); // frames between two detections
const RING = 20; // frames kept: onset pre-roll + the wake word itself for the second-stage check (1.6 s)

let det = null;
let mode = 'paused';
let epoch = 0; // bumped on every switch made here; stale page commands are ignored
let opts = { silenceMs: 1200, maxMs: 15000, noSpeechMs: 4000, followMs: 6000, bargeVoice: true };
let sens = 'medium';
let headThr = { low: 0.95, medium: 0.85, high: 0.7 };
let ttsThr = { base: TTS_THRESHOLD, custom: 0.97 };
let frameNo = 0;
let lastWake = -1e9;
let lastSuppressed = -1e9;
let customRun = 0; // consecutive frames over the Thai-head threshold
let ring = [];
let rec = null;
let follow = null;
let run = 0; // consecutive speech frames (follow / barge)
let noise = 0.006; // energy-VAD fallback noise floor
let echo = 0; // running mic level while TTS plays (residual echo after echo cancellation)
const queue = [];
let pumping = false;
const stats = { frames: 0, ms: 0, dropped: 0, since: Date.now() };

const post = (m, transfer) => postMessage({ ...m, epoch }, transfer || []);

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'port') usePort(m.port);
    else if (m.type === 'mode') setMode(m);
    else if (m.type === 'config') config(m);
    else if (m.type === 'start-command') startRec(0, false, m.guard ?? 0);
    else if (m.type === 'stop-command') { if (rec) finish('manual'); }
    else if (m.type === 'snapshot') post({ type: 'snapshot', id: m.id, pcm: rec ? toPcm(rec.frames) : null });
  } catch (err) {
    post({ type: 'error', code: 'WORKER', message: String(err && err.message || err) });
  }
};

async function init(m) {
  ort.env.wasm.numThreads = 1; // one core: low, steady CPU
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = m.wasmPaths;
  try {
    det = await WakeDetector.create(ort, m.models);
    if (m.head) det.setHead(m.head);
  } catch (err) {
    post({ type: 'error', code: 'ENGINE_FAILED', message: String(err && err.message || err) });
    return;
  }
  config(m);
  post({ type: 'ready', vad: det.hasVad, head: !!m.head });
}

let port = null;
/** A new mic session: frames now come from this worklet port. */
function usePort(p) {
  if (port) { port.onmessage = null; port.close(); }
  port = p;
  port.onmessage = (ev) => onFrame(ev.data);
  ring = [];
}

function config(m) {
  if (m.sensitivity) sens = m.sensitivity;
  if (m.headThr) headThr = m.headThr;
  if (m.opts) opts = { ...opts, ...m.opts };
}

function setMode(m) {
  if (m.epoch < epoch) return; // the worker already moved on (wake / barge-in / follow speech)
  if (m.opts) opts = { ...opts, ...m.opts };
  const next = m.mode;
  if (next !== 'command' && rec) rec = null; // page cancelled the recording
  mode = next;
  run = 0;
  follow = next === 'follow' ? { until: frameNo + Math.round(opts.followMs / MS) } : null;
  if (next === 'follow' || next === 'speaking') det && det.resetVad();
  if (next === 'speaking') echo = 0;
  if (next === 'command' && !rec) startRec(0, false, 0);
}

function onFrame(f) {
  frameNo++;
  ring.push(f);
  if (ring.length > RING) ring.shift();
  if (rec) rec.frames.push(f); // recording never drops audio
  if (mode === 'paused' || !det) return;
  queue.push(f);
  while (queue.length > 6) { queue.shift(); stats.dropped++; }
  if (!pumping) pump();
}

async function pump() {
  pumping = true;
  try {
    while (queue.length) {
      const f = queue.shift();
      const t = performance.now();
      await step(f);
      stats.ms += performance.now() - t;
      stats.frames++;
      if (Date.now() - stats.since > 10000) {
        post({ type: 'stats', msPerFrame: stats.ms / Math.max(1, stats.frames), dropped: stats.dropped });
        stats.frames = 0; stats.ms = 0; stats.dropped = 0; stats.since = Date.now();
      }
    }
  } finally {
    pumping = false;
  }
}

function level(f) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / f.length);
}

/** Speech probability for this frame: Silero when loaded, else an adaptive energy gate. */
async function speechProb(f) {
  const p = await det.vad(f);
  if (p != null) return p;
  const lv = level(f);
  const loud = lv > Math.max(0.015, noise * 2.5);
  if (!loud) noise = noise * 0.95 + lv * 0.05;
  return loud ? 0.9 : 0.1;
}

async function step(f) {
  const s = await det.wake(f); // always run: keeps the feature window current
  if (opts.debug && (s.base > 0.3 || s.custom > 0.3)) post({ type: 'score', base: s.base, custom: s.custom, mode, sec: frameNo * 0.08 });
  const thrB = THRESHOLDS[sens] ?? 0.5;
  const thrC = headThr[sens] ?? 0.85;
  const at = frameNo;

  if (mode === 'wake' || mode === 'speaking') {
    const tts = mode === 'speaking';
    const tb = tts ? Math.max(thrB, ttsThr.base) : thrB;
    const tc = tts ? Math.max(thrC, ttsThr.custom) : thrC;
    const hitB = s.base >= tb;
    // the custom head must hold for 2 frames (fewer one-frame blips on look-alike words)
    customRun = s.custom >= tc ? customRun + 1 : 0;
    const hitC = customRun >= 2;
    if ((hitB || hitC) && at - lastWake > COOLDOWN) {
      lastWake = at;
      epoch++;
      // Thai-head-only detections get a second check (local whisper on the wake word audio)
      const wakePcm = hitB ? null : toPcm(ring.slice(-RING));
      startRec(3, false, 3); // ~240 ms pre-roll; ignore speech in the first 240 ms (wake-word tail + chime)
      customRun = 0;
      post({ type: 'wake', score: Math.max(s.base, s.custom), base: s.base, custom: s.custom, source: hitB ? 'base' : 'custom', during: tts ? 'speaking' : 'wake', wakePcm }, wakePcm ? [wakePcm] : []);
      return;
    }
    if (tts && (s.base >= thrB || s.custom >= thrC) && at - lastSuppressed > COOLDOWN) {
      lastSuppressed = at;
      post({ type: 'suppressed', score: Math.max(s.base, s.custom) });
    }
  }

  if (mode === 'command' && rec) {
    const p = await speechProb(f);
    const ms = (at - rec.start) * MS;
    const speech = p >= 0.5 && at - rec.start >= rec.guard;
    rec.run = speech ? rec.run + 1 : p < 0.35 ? 0 : rec.run;
    if (speech) rec.last = at;
    if (!rec.hadSpeech && rec.run >= 2) {
      rec.hadSpeech = true;
      post({ type: 'speech-start', from: rec.from });
    }
    if (rec.hadSpeech && (at - rec.last) * MS >= opts.silenceMs) return finish('silence');
    if (!rec.hadSpeech && ms >= opts.noSpeechMs) return finish('no-speech');
    if (ms >= opts.maxMs) return finish('max');
    return;
  }

  if (mode === 'follow') {
    const p = await speechProb(f);
    run = p >= 0.6 ? run + 1 : p < 0.35 ? 0 : run;
    if (run >= 3) {
      epoch++;
      startRec(run + 4, true, 0, 'follow');
      post({ type: 'speech-start', from: 'follow' });
      return;
    }
    if (follow && at >= follow.until) {
      epoch++;
      mode = 'wake';
      follow = null;
      post({ type: 'follow-timeout' });
    }
    return;
  }

  if (mode === 'speaking' && opts.bargeVoice) {
    const p = await speechProb(f);
    // the user's own voice must be clearly louder than what leaks back from the speakers
    const lv = level(f);
    echo = echo ? echo * 0.97 + lv * 0.03 : lv;
    run = p >= 0.85 && lv > Math.max(0.01, echo * 2) ? run + 1 : 0;
    if (run >= 7) { // ~560 ms of clear speech over the reply
      epoch++;
      startRec(run + 2, true, 0, 'barge');
      post({ type: 'barge-voice' });
    }
  }
}

function startRec(preroll, hadSpeech, guard, from = 'wake') {
  const pre = preroll ? ring.slice(-preroll) : [];
  rec = { frames: pre.slice(), start: frameNo, last: frameNo, run: 0, hadSpeech, guard, from };
  mode = 'command';
  follow = null;
  run = 0;
  det && det.resetVad();
}

function finish(reason) {
  const r = rec;
  rec = null;
  mode = 'hold';
  epoch++;
  const pcm = toPcm(r.frames);
  post({ type: 'end', reason, hadSpeech: r.hadSpeech, from: r.from, ms: r.frames.length * MS, pcm }, [pcm]);
}

function toPcm(frames) {
  const out = new Int16Array(frames.length * FRAME);
  let o = 0;
  for (const f of frames) {
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i]));
      out[o++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }
  return out.buffer;
}
