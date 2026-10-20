// Wake engine for hands-free mode — on-device openWakeWord ("hey jarvis") plus a
// custom "จาร์วิส / Jarvis" head, Silero VAD, all in a Web Worker.
//
// Swappable interface (any engine, e.g. a Picovoice Porcupine adapter, needs):
//   load()                 → Promise; throws { code: 'ENGINE_FAILED' } when it can't run
//   start(deviceId)        → Promise; opens the mic (throws { code: 'MIC_DENIED' | 'MIC_NOT_FOUND' | 'MIC_ERROR' })
//   stop()                 releases the mic (the engine stays loaded)
//   setMode(mode, opts)    'paused' | 'hold' | 'wake' | 'speaking' | 'command' | 'follow'
//   configure({ sensitivity, opts })
//   startCommand() / stopCommand()
//   snapshot()             → Promise<ArrayBuffer|null> int16 PCM recorded so far
//   bands(n)               → Float32Array | null (live mic spectrum for the reactor)
//   onEvent(evt)           'wake' 'suppressed' 'speech-start' 'end' 'follow-timeout'
//                          'barge-voice' 'stats' 'mic-lost' 'mic-back' 'mic-restart' 'error'
//   onLevel(rms)           one mic level per 80 ms frame
const api = window.jarvis;
const ORT_DIR = new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url).href;
// The worklet sends one level per 80 ms frame. No frame for this long while the
// mic is open means the stream died without an 'ended' event (device asleep,
// driver reset after a long idle): the mic is reopened.
const STALL_MS = 5000;

export class OwwEngine {
  constructor({ onEvent, onLevel }) {
    this.onEvent = onEvent || (() => {});
    this.onLevel = onLevel || (() => {});
    this.worker = null;
    this.epoch = 0;
    this.stream = null;
    this.ctx = null;
    this.wantDevice = '';
    this.lost = false;
    this.openGen = 0; // bumped by every close: an open that was overtaken drops its stream
    this.snapId = 0;
    this.snaps = new Map();
    this._devChange = () => this._onDeviceChange();
  }

  get name() {
    return 'openWakeWord';
  }

  async load() {
    if (this.worker) return this.ready;
    let models;
    let head = null;
    try {
      const st = await api.invoke('hf:status');
      if (!st.ready) {
        const r = await api.invoke('hf:install');
        if (!r.ok) throw new Error(r.error);
      }
      const names = ['mel', 'emb', 'wake', 'vad'];
      const bufs = await Promise.all(names.map((n) => api.invoke('hf:model', n).catch(() => null)));
      models = Object.fromEntries(names.map((n, i) => [n, bufs[i]]));
      if (!models.mel || !models.emb || !models.wake) throw new Error('โหลดโมเดลไม่ครบ');
      try {
        head = await (await fetch(new URL('./models/jarvis-th.json', import.meta.url))).json();
      } catch { head = null; } // the stock "hey jarvis" model still works on its own
    } catch (err) {
      throw Object.assign(new Error(err.message), { code: 'ENGINE_FAILED' });
    }
    this.worker = new Worker(new URL('./wake-worker.js', import.meta.url), { type: 'module', name: 'hands-free' });
    this.ready = new Promise((resolve, reject) => {
      this._ready = { resolve, reject };
    });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => {
      const err = Object.assign(new Error(e.message || 'worker error'), { code: 'ENGINE_FAILED' });
      if (this._ready) { this._ready.reject(err); this._ready = null; } else this.onEvent({ type: 'error', code: 'ENGINE_FAILED', message: err.message });
    };
    this.worker.postMessage({ type: 'init', models, head, wasmPaths: ORT_DIR });
    return this.ready.catch((err) => {
      // failed to start: drop the worker so the next toggle retries from scratch
      if (this.worker) this.worker.terminate();
      this.worker = null;
      throw err;
    });
  }

  _onMessage(m) {
    if (typeof m.epoch === 'number') this.epoch = m.epoch;
    if (m.type === 'ready') {
      this.info = { vad: m.vad, head: m.head };
      if (this._ready) { this._ready.resolve(this.info); this._ready = null; }
      return;
    }
    if (m.type === 'error' && this._ready) {
      this._ready.reject(Object.assign(new Error(m.message), { code: m.code || 'ENGINE_FAILED' }));
      this._ready = null;
      return;
    }
    if (m.type === 'snapshot') {
      const fn = this.snaps.get(m.id);
      this.snaps.delete(m.id);
      if (fn) fn(m.pcm);
      return;
    }
    this.onEvent(m);
  }

  async start(deviceId = '') {
    this.wantDevice = deviceId || '';
    await this._open();
    navigator.mediaDevices.addEventListener('devicechange', this._devChange);
  }

  async _open() {
    this._close();
    const gen = this.openGen;
    const audio = {
      channelCount: 1,
      // keeps the assistant's own voice (and room noise) out of the wake word detector
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (this.wantDevice) audio.deviceId = { exact: this.wantDevice };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      if (this.wantDevice && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        // chosen device is gone: use the system default instead
        delete audio.deviceId;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio });
        } catch (err2) {
          throw micError(err2);
        }
      } else throw micError(err);
    }
    // stop() or another open ran while the mic was opening: drop this one
    // (a second live stream would leak, and its 'ended' would close the good one)
    const stale = () => gen !== this.openGen;
    if (stale()) { stream.getTracks().forEach((t) => t.stop()); return; }
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'playback' });
    } catch {
      ctx = new AudioContext({ latencyHint: 'playback' });
    }
    try {
      await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      throw Object.assign(new Error(err.message || 'audio worklet failed'), { code: 'MIC_ERROR' });
    }
    if (stale()) { stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {}); return; }
    this.stream = stream;
    this.ctx = ctx;
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'hf-capture', { numberOfOutputs: 1, outputChannelCount: [1] });
    // Direct line worklet → worker: the page never sees the audio frames.
    const line = new MessageChannel();
    this.node.port.postMessage({ port: line.port1 }, [line.port1]);
    this.worker.postMessage({ type: 'port', port: line.port2 }, [line.port2]);
    this.lastFrame = performance.now();
    this.node.port.onmessage = (e) => {
      this.lastFrame = performance.now();
      this.onLevel(e.data);
    };
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.6;
    this.fft = new Uint8Array(this.analyser.frequencyBinCount);
    this.src.connect(this.analyser);
    this.src.connect(this.node);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
    const track = this.stream.getAudioTracks()[0];
    this.deviceLabel = track ? track.label : '';
    if (track) {
      track.onended = () => {
        if (!this.stream) return;
        this.lost = true;
        this._close();
        this.onEvent({ type: 'mic-lost' });
        this._recover();
      };
    }
    this.lost = false;
    this._watch();
  }

  /** Reopen the mic when frames stop arriving (see STALL_MS). */
  _watch() {
    clearInterval(this._stallTimer);
    this._stallTimer = setInterval(async () => {
      if (!this.stream || this.lost || this._reopening) return;
      if (performance.now() - this.lastFrame < STALL_MS) return;
      this._reopening = true;
      try {
        await this._open();
        if (this.stream) this.onEvent({ type: 'mic-restart' });
      } catch {
        // no mic right now: same path as an unplugged mic
        this.lost = true;
        this._close();
        this.onEvent({ type: 'mic-lost' });
        this._recover();
      } finally {
        this._reopening = false;
      }
    }, 1000);
  }

  /**
   * A lost mic is also retried on a timer (every 3 s for about a minute), not
   * only on 'devicechange': a device that wakes up again doesn't always send one.
   */
  _recover(tries = 20) {
    clearTimeout(this._recoverTimer);
    this._recoverTimer = setTimeout(async () => {
      if (!this.lost) return;
      try {
        await this._open();
        if (this.stream) this.onEvent({ type: 'mic-back' });
      } catch {
        if (tries > 1) this._recover(tries - 1);
      }
    }, 3000);
  }

  async _onDeviceChange() {
    if (!this.lost) return;
    clearTimeout(this._retry);
    this._retry = setTimeout(async () => {
      try {
        await this._open();
        this.onEvent({ type: 'mic-back' });
      } catch { /* still no mic: wait for the next devicechange */ }
    }, 700);
  }

  _close() {
    this.openGen++;
    clearInterval(this._stallTimer);
    try { this.src && this.src.disconnect(); } catch { /* gone */ }
    try { this.node && this.node.disconnect(); } catch { /* gone */ }
    if (this.stream) this.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = this.ctx = this.src = this.node = this.analyser = null;
  }

  stop() {
    navigator.mediaDevices.removeEventListener('devicechange', this._devChange);
    clearTimeout(this._retry);
    clearTimeout(this._recoverTimer);
    this.lost = false;
    this.setMode('paused');
    this._close();
    this.onLevel(null);
  }

  get open() {
    return !!this.stream;
  }

  setMode(mode, opts) {
    if (this.worker) this.worker.postMessage({ type: 'mode', mode, opts, epoch: this.epoch });
  }

  configure({ sensitivity, opts, headThr } = {}) {
    if (this.worker) this.worker.postMessage({ type: 'config', sensitivity, opts, headThr });
  }

  startCommand() {
    if (this.worker) this.worker.postMessage({ type: 'start-command' });
  }

  stopCommand() {
    if (this.worker) this.worker.postMessage({ type: 'stop-command' });
  }

  snapshot() {
    if (!this.worker) return Promise.resolve(null);
    const id = ++this.snapId;
    return new Promise((resolve) => {
      this.snaps.set(id, resolve);
      this.worker.postMessage({ type: 'snapshot', id });
      setTimeout(() => { if (this.snaps.delete(id)) resolve(null); }, 1000);
    });
  }

  bands(n = 32) {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this.fft);
    const out = new Float32Array(n);
    const per = Math.max(1, Math.floor(this.fft.length / n));
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = 0; j < per; j++) m = Math.max(m, this.fft[i * per + j] || 0);
      out[i] = m / 255;
    }
    return out;
  }

  dispose() {
    this.stop();
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

function micError(err) {
  const code = err.name === 'NotAllowedError' || err.name === 'SecurityError' ? 'MIC_DENIED'
    : err.name === 'NotFoundError' || err.name === 'OverconstrainedError' ? 'MIC_NOT_FOUND' : 'MIC_ERROR';
  return Object.assign(new Error(err.message || err.name), { code });
}
