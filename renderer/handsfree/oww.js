// openWakeWord streaming pipeline ("hey jarvis") + Silero VAD, on onnxruntime-web.
// Pure module: no DOM. Runs inside the wake Web Worker, and in Node for tests.
//
//   16 kHz audio, 1280-sample frames (80 ms)
//   → melspectrogram.onnx  (raw int16-scale floats → ~8 mel frames × 32, then x/10 + 2)
//   → embedding_model.onnx (last 76 mel frames → one 96-d embedding per frame)
//   → hey_jarvis_v0.1.onnx (last 16 embeddings → score 0..1)
// Silero VAD v4 (512-sample chunks, h/c state) runs only when asked to, so
// plain wake listening stays cheap.

export const SAMPLE_RATE = 16000;
export const FRAME = 1280; // 80 ms
const MEL_CONTEXT = 160 * 3; // extra samples the mel model needs per frame
const MEL_WINDOW = 76;
const MEL_BINS = 32;
const EMB = 96;
const EMB_WINDOW = 16;
const VAD_CHUNK = 512;
const WARMUP_FRAMES = 16; // ignore scores until the feature window is real audio

export class WakeDetector {
  /** models: { mel, emb, wake, vad? } as ArrayBuffer / Uint8Array */
  static async create(ort, models) {
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const make = (b) => ort.InferenceSession.create(b instanceof Uint8Array ? b : new Uint8Array(b), opt);
    const [mel, emb, wake, vad] = await Promise.all([make(models.mel), make(models.emb), make(models.wake), models.vad ? make(models.vad) : null]);
    const d = new WakeDetector(ort, { mel, emb, wake, vad });
    await d.reset();
    return d;
  }

  constructor(ort, s) {
    this.ort = ort;
    this.s = s;
    this.raw = new Float32Array(FRAME + MEL_CONTEXT);
    this.mel = [];
    this.feat = [];
    this.frames = 0;
    this.vadBuf = new Float32Array(0);
    this.h = new Float32Array(2 * 64);
    this.c = new Float32Array(2 * 64);
  }

  get hasVad() {
    return !!this.s.vad;
  }

  async reset() {
    this.raw.fill(0);
    this.mel = [];
    for (let i = 0; i < MEL_WINDOW; i++) this.mel.push(new Float32Array(MEL_BINS).fill(1));
    const e = await this._embed();
    this.feat = [];
    for (let i = 0; i < EMB_WINDOW; i++) this.feat.push(e);
    this.frames = 0;
    this.resetVad();
  }

  resetVad() {
    this.vadBuf = new Float32Array(0);
    this.h.fill(0);
    this.c.fill(0);
  }

  /**
   * One 80 ms frame of float audio in [-1, 1].
   * @returns {Promise<{base:number, custom:number}>} scores 0..1: the stock
   *   "hey jarvis" model and the custom head (0 during warm-up / without a head)
   */
  async wake(frame) {
    const T = this.ort.Tensor;
    // slide the raw window: keep 480 samples of context + the new frame
    this.raw.copyWithin(0, FRAME);
    for (let i = 0; i < FRAME; i++) this.raw[MEL_CONTEXT + i] = Math.max(-1, Math.min(1, frame[i])) * 32767;
    const out = await this.s.mel.run({ [this.s.mel.inputNames[0]]: new T('float32', this.raw.slice(), [1, this.raw.length]) });
    const m = out[this.s.mel.outputNames[0]];
    const nf = m.dims[2];
    for (let f = 0; f < nf; f++) {
      const row = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) row[b] = m.data[f * MEL_BINS + b] / 10 + 2;
      this.mel.push(row);
    }
    if (this.mel.length > MEL_WINDOW) this.mel.splice(0, this.mel.length - MEL_WINDOW);
    this.feat.push(await this._embed());
    if (this.feat.length > EMB_WINDOW) this.feat.shift();
    this.frames++;
    const x = new Float32Array(EMB_WINDOW * EMB);
    this.feat.forEach((e, i) => x.set(e, i * EMB));
    this.x = x; // the 16×96 feature window (custom heads read it)
    const r = await this.s.wake.run({ [this.s.wake.inputNames[0]]: new T('float32', x, [1, EMB_WINDOW, EMB]) });
    const base = r[this.s.wake.outputNames[0]].data[0];
    const custom = this.head ? runHead(this.head, x) : 0;
    if (this.frames <= WARMUP_FRAMES) return { base: 0, custom: 0 };
    return { base, custom };
  }

  /** Extra keyword head (JSON MLP over the same feature window), e.g. the Thai "จาร์วิส" variant. */
  setHead(head) {
    this.head = head ? prepareHead(head) : null;
  }

  async _embed() {
    const T = this.ort.Tensor;
    const x = new Float32Array(MEL_WINDOW * MEL_BINS);
    this.mel.forEach((row, i) => x.set(row, i * MEL_BINS));
    const r = await this.s.emb.run({ [this.s.emb.inputNames[0]]: new T('float32', x, [1, MEL_WINDOW, MEL_BINS, 1]) });
    return Float32Array.from(r[this.s.emb.outputNames[0]].data);
  }

  /**
   * Speech probability (max over the 512-sample chunks completed by this frame),
   * or null when no VAD model is loaded.
   */
  async vad(frame) {
    const v = this.s.vad;
    if (!v) return null;
    const T = this.ort.Tensor;
    const buf = new Float32Array(this.vadBuf.length + frame.length);
    buf.set(this.vadBuf);
    buf.set(frame, this.vadBuf.length);
    let p = 0;
    let o = 0;
    for (; o + VAD_CHUNK <= buf.length; o += VAD_CHUNK) {
      const r = await v.run({
        input: new T('float32', buf.slice(o, o + VAD_CHUNK), [1, VAD_CHUNK]),
        sr: new T('int64', BigInt64Array.from([16000n]), []),
        h: new T('float32', this.h, [2, 1, 64]),
        c: new T('float32', this.c, [2, 1, 64]),
      });
      p = Math.max(p, r.output.data[0]);
      this.h = Float32Array.from(r.hn.data);
      this.c = Float32Array.from(r.cn.data);
    }
    this.vadBuf = buf.slice(o);
    return p;
  }
}

/** Custom head: x(1536) → dense(h, ReLU) → dense(1, sigmoid). Weights as plain arrays. */
export function prepareHead(j) {
  return { n: j.inputs, h: j.hidden, w1: Float32Array.from(j.w1), b1: Float32Array.from(j.b1), w2: Float32Array.from(j.w2), b2: j.b2, mean: j.mean ? Float32Array.from(j.mean) : null, std: j.std ? Float32Array.from(j.std) : null };
}

export function runHead(m, x) {
  const { n, h, w1, b1, w2, mean, std } = m;
  let z = m.b2;
  for (let j = 0; j < h; j++) {
    let a = b1[j];
    const o = j * n;
    if (mean) for (let i = 0; i < n; i++) a += w1[o + i] * ((x[i] - mean[i]) / std[i]);
    else for (let i = 0; i < n; i++) a += w1[o + i] * x[i];
    if (a > 0) z += a * w2[j];
  }
  return 1 / (1 + Math.exp(-z));
}

/** Score threshold per sensitivity setting. */
export const THRESHOLDS = { low: 0.7, medium: 0.5, high: 0.3 };
/** While TTS is playing, only a confident detection counts (echo / self-trigger guard). */
export const TTS_THRESHOLD = 0.85;
