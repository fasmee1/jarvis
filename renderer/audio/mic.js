// Microphone capture → 16 kHz mono Int16 PCM with energy-based VAD.
// Nothing is stored: the buffer is handed to main for transcription and dropped.

const TARGET_RATE = 16000;

function resample(input, fromRate) {
  if (fromRate === TARGET_RATE) return input;
  const ratio = fromRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(input.length - 1, i0 + 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (x - i0);
  }
  return out;
}

export class Mic {
  constructor({ onLevel, onSpeechStart, onEnd, onError }) {
    this.onLevel = onLevel || (() => {});
    this.onSpeechStart = onSpeechStart || (() => {});
    this.onEnd = onEnd || (() => {});
    this.onError = onError || (() => {});
    this.active = false;
  }

  async start({ deviceId = '', silenceMs = 800, maxMs = 60000, noSpeechMs = 8000 } = {}) {
    if (this.active) return;
    this.opts = { silenceMs, maxMs, noSpeechMs };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const code = err.name === 'NotAllowedError' || err.name === 'SecurityError' ? 'MIC_DENIED' : err.name === 'NotFoundError' || err.name === 'OverconstrainedError' ? 'MIC_NOT_FOUND' : 'MIC_ERROR';
      this.onError(code, err.message);
      return;
    }
    try {
      this.ctx = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      this.ctx = new AudioContext();
    }
    await this.ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    // Real spectrum for the HUD data band.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.6;
    this.src.connect(this.analyser);
    this.fft = new Uint8Array(this.analyser.frequencyBinCount);
    this.chunks = [];
    this.samples = 0;
    this.startedAt = performance.now();
    this.speechAt = 0;
    this.lastVoiceAt = 0;
    this.noise = 0.006;
    this.calib = 0;
    this.active = true;
    this.node.port.onmessage = (e) => this._onChunk(e.data);
    this.src.connect(this.node);
    // Keep the graph pulling audio without playing it back.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
  }

  _onChunk(f32) {
    if (!this.active) return;
    const data = resample(f32, this.ctx.sampleRate);
    this.chunks.push(data);
    this.samples += data.length;
    let s = 0;
    for (const x of data) s += x * x;
    const level = Math.sqrt(s / data.length);
    this.onLevel(Math.min(1, level * 8), level);

    const now = performance.now();
    const elapsed = now - this.startedAt;
    // First 250 ms: estimate background noise.
    if (elapsed < 250) {
      this.noise = Math.max(this.noise, level);
      return;
    }
    const threshold = Math.max(0.015, this.noise * 2.5);
    if (level > threshold) {
      if (!this.speechAt) {
        this.speechAt = now;
        this.onSpeechStart();
      }
      this.lastVoiceAt = now;
    }
    if (this.speechAt && now - this.lastVoiceAt > this.opts.silenceMs) return this.stop('silence');
    if (!this.speechAt && elapsed > this.opts.noSpeechMs) return this.stop('no-speech');
    if (elapsed > this.opts.maxMs) return this.stop('max');
  }

  /** Finish recording and deliver the PCM. */
  stop(reason = 'manual') {
    if (!this.active) return;
    this.active = false;
    const tEnd = Date.now();
    const pcm = new Int16Array(this.samples);
    let o = 0;
    for (const c of this.chunks) {
      for (let i = 0; i < c.length; i++) {
        const v = Math.max(-1, Math.min(1, c[i]));
        pcm[o++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    }
    this._teardown();
    this.onEnd({ pcm: pcm.buffer, reason, hadSpeech: !!this.speechAt, tListenEnd: tEnd });
  }

  /** 32 real FFT bands (0..1) or null when the mic is closed. */
  bands(n = 32) {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this.fft);
    const out = new Float32Array(n);
    const per = Math.floor(this.fft.length / n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = 0; j < per; j++) m = Math.max(m, this.fft[i * per + j]);
      out[i] = m / 255;
    }
    return out;
  }

  cancel() {
    if (!this.active) return;
    this.active = false;
    this._teardown();
  }

  _teardown() {
    this.chunks = [];
    try { this.src && this.src.disconnect(); } catch { /* ignore */ }
    try { this.node && this.node.disconnect(); } catch { /* ignore */ }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.onLevel(0, null);
    this.stream = this.ctx = this.src = this.node = this.analyser = null;
  }
}

/** Experimental Web Speech API recognizer (often fails in Electron with "network"). */
export function webSpeechOnce({ onResult, onError, onEnd }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    onError('UNSUPPORTED', 'เครื่องนี้ไม่มี Web Speech API');
    return null;
  }
  const r = new SR();
  r.lang = 'th-TH';
  r.interimResults = false;
  r.maxAlternatives = 1;
  r.onresult = (e) => onResult(e.results[0][0].transcript);
  r.onerror = (e) => onError(e.error, e.error === 'network' ? 'Web Speech ใช้ไม่ได้ใน Electron (error "network") — แนะนำสลับไปใช้ whisper หรือ Azure ใน Settings' : e.error);
  r.onend = onEnd;
  r.start();
  return r;
}
