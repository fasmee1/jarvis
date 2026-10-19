// TTS providers + a queue that speaks segments in order.
//  - 'winrt': synthesized in main — Edge neural voices (th-TH-NiwatNeural, listed
//             first) with automatic fallback to Windows OneCore voices offline
//  - 'web'  : speechSynthesis with a th-TH voice, if Chromium exposes one
//
// WinRT playback is gapless: each segment is synthesized and decoded as soon as
// it arrives, the ~0.1 s lead / ~0.8 s tail silence Windows adds is trimmed, and
// segments are scheduled back to back on the Web Audio clock with a short
// natural pause. Speech starts once a few seconds are buffered, the reply is
// complete (flush), or PREBUFFER_MAX_MS has passed — whichever comes first.

const api = window.jarvis;

const PREBUFFER_SEC = 3; // start once this much audio is ready…
const PREBUFFER_MAX_MS = 1500; // …or after this long, so short replies don't lag
const PAUSE_SENTENCE = 0.28; // gap after . ! ? ฯ
const PAUSE_PHRASE = 0.12; // gap after a phrase cut (space / newline)
const SILENCE = 0.01; // ≈ -40 dBFS: below this counts as silence when trimming
const PAD_LEAD = 0.02;
const PAD_TAIL = 0.05;
const FADE = 0.005; // tiny fade at both ends so trimmed edges never click

function webThaiVoice() {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  return voices.find((v) => /^th(-|_|$)/i.test(v.lang)) || null;
}

function waitVoices(ms = 1500) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    if (speechSynthesis.getVoices().length) return resolve();
    const t = setTimeout(resolve, ms);
    speechSynthesis.onvoiceschanged = () => {
      clearTimeout(t);
      resolve();
    };
  });
}

/** Copy of `buf` without leading/trailing silence, with short fades. */
function trimSilence(c, buf) {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const loud = (i) => {
    for (let k = 0; k < ch; k++) if (Math.abs(buf.getChannelData(k)[i]) > SILENCE) return true;
    return false;
  };
  let a = 0;
  while (a < n && !loud(a)) a++;
  if (a >= n) return buf; // all silent: leave as is
  let z = n - 1;
  while (z > a && !loud(z)) z--;
  const sr = buf.sampleRate;
  a = Math.max(0, a - Math.round(PAD_LEAD * sr));
  z = Math.min(n - 1, z + Math.round(PAD_TAIL * sr));
  const len = z - a + 1;
  const out = c.createBuffer(ch, len, sr);
  const f = Math.min(Math.round(FADE * sr), Math.floor(len / 2));
  for (let k = 0; k < ch; k++) {
    const d = out.getChannelData(k);
    d.set(buf.getChannelData(k).subarray(a, z + 1));
    for (let i = 0; i < f; i++) {
      const g = i / f;
      d[i] *= g;
      d[len - 1 - i] *= g;
    }
  }
  return out;
}

export class Speaker {
  /**
   * getContext: returns the app's shared AudioContext (falls back to a private one)
   * voiceFx(src): optional voice color chain → { out, dispose } (used when an item has fx)
   */
  constructor({ onStart, onIdle, onLevel, onProblem, getContext, voiceFx }) {
    this.getContext = getContext || null;
    this.voiceFx = voiceFx || null;
    this.onStart = onStart || (() => {});
    this.onIdle = onIdle || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onProblem = onProblem || (() => {});
    this.engine = 'none';
    this.rate = 1;
    this.queue = [];
    this.speaking = false;
    this.gen = 0; // increments on stop() to drop in-flight work
    this.muted = false;
    // WinRT scheduler state
    this.sources = new Set(); // scheduled/playing buffer sources
    this.timers = new Set();
    this.playhead = 0; // context time where the next segment may start
    this.started = false; // prebuffer gate passed for the current run
    this.flushed = false; // reply text complete: start without waiting
    this.firstAt = 0; // when the first segment of this run was queued
    this.pumping = false;
  }

  async detect() {
    await waitVoices();
    let winrtThai = null;
    try {
      const r = await api.invoke('tts:list-system-voices');
      winrtThai = (r.voices || []).find((v) => v.lang === 'th-TH') || null;
    } catch { /* not windows */ }
    const web = webThaiVoice();
    if (winrtThai) {
      this.engine = 'winrt';
      this.voiceName = winrtThai.name;
    } else if (web) {
      this.engine = 'web';
      this.webVoice = web;
      this.voiceName = web.name;
    } else {
      this.engine = 'none';
      this.voiceName = '';
    }
    return { engine: this.engine, voice: this.voiceName };
  }

  setRate(r) {
    this.rate = r;
  }

  /**
   * opts: { rate, pitch } override the defaults for this one segment;
   * fx: true applies the robotic voice color (WinRT voices only — speechSynthesis
   * exposes no audio signal to process).
   */
  enqueue(text, opts = {}) {
    if (!text || this.muted) return;
    if (this.engine === 'none') {
      this.onProblem('NO_THAI_VOICE');
      return;
    }
    const gen = this.gen;
    const item = { text, gen, rate: opts.rate ?? this.rate, pitch: opts.pitch ?? 1, fx: !!opts.fx };
    if (this.engine === 'winrt') {
      // Synthesize + decode right away (in parallel with whatever is playing).
      item.pause = /[.!?ฯ]$/.test(text.trim()) ? PAUSE_SENTENCE : PAUSE_PHRASE;
      item.buf = api
        .invoke('tts:synthesize', { text, voice: this.voiceName, rate: item.rate, pitch: item.pitch })
        .then((r) => this._decode(r))
        .then((b) => { item.dur = b.duration; return b; });
      item.buf.catch(() => {}); // handled in _pump
      if (!this.started && !this.queue.length && !this.sources.size) this.firstAt = performance.now();
      this.queue.push(item);
      this._pump();
      return;
    }
    this.queue.push(item);
    if (!this.speaking) this._next();
  }

  /** The reply text is complete: start speaking now instead of waiting to buffer. */
  flush() {
    if (this.queue.length || this.sources.size) this.flushed = true;
  }

  /** 32 real output FFT bands (WinRT playback only) or null. */
  bands(n = 32) {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this.fft);
    const out = new Float32Array(n);
    const per = Math.floor(this.fft.length / 2 / n) || 1;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = 0; j < per; j++) m = Math.max(m, this.fft[i * per + j]);
      out[i] = m / 255;
    }
    return out;
  }

  /** fadeMs > 0: fade the voice out (barge-in) instead of cutting it. */
  stop(fadeMs = 0) {
    this.gen++;
    this.queue = [];
    const out = this.out;
    if (fadeMs > 0 && out && this.sources.size) {
      // fade this run's gain to 0, then stop its sources; new speech gets a fresh gain
      const playing = [...this.sources];
      const c = out.context;
      const t = c.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(0, t + fadeMs / 1000);
      setTimeout(() => {
        for (const s of playing) { try { s.stop(); } catch { /* not started */ } }
        try { out.disconnect(); } catch { /* gone */ }
      }, fadeMs + 30);
      this.out = null;
    } else {
      for (const s of this.sources) {
        try { s.stop(); } catch { /* not started */ }
      }
    }
    this.sources.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this._resetRun();
    if (window.speechSynthesis) speechSynthesis.cancel();
    clearInterval(this.keepAlive);
    if (this.speaking) {
      this.speaking = false;
      this.analyser = null;
      this.onLevel(0);
      this.onIdle();
    }
  }

  /** Duck the voice (1 = normal, e.g. 0.6 while a video plays). */
  setDuck(level) {
    this.duckLevel = level;
    if (this.duckGain) this.duckGain.gain.setTargetAtTime(level, this.duckGain.context.currentTime, 0.08);
  }

  // ================= WinRT: gapless scheduler =================

  _ctx() {
    const shared = this.getContext ? this.getContext() : null;
    return shared || (this.actx = this.actx || new AudioContext());
  }

  async _decode(r) {
    if (!r || !r.ok) throw new Error((r && r.error) || 'TTS failed');
    const u8 = r.wav instanceof Uint8Array ? r.wav : new Uint8Array(r.wav);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const c = this._ctx();
    return trimSilence(c, await c.decodeAudioData(ab));
  }

  _resetRun() {
    this.playhead = 0;
    this.started = false;
    this.flushed = false;
  }

  /** Seconds of decoded audio waiting in the queue. */
  _ready() {
    let s = 0;
    for (const it of this.queue) if (it.dur) s += it.dur + it.pause;
    return s;
  }

  _gateOpen() {
    return this.started || this.flushed || this._ready() >= PREBUFFER_SEC
      || performance.now() - this.firstAt >= PREBUFFER_MAX_MS;
  }

  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    const gen = this.gen;
    try {
      while (this.queue.length && gen === this.gen) {
        while (!this._gateOpen() && gen === this.gen) await new Promise((r) => setTimeout(r, 40));
        if (gen !== this.gen) break;
        const item = this.queue[0];
        let buf = null;
        try {
          buf = await item.buf;
        } catch (err) {
          this.onProblem('TTS_FAILED', err.message);
        }
        if (gen !== this.gen) break;
        this.queue.shift();
        if (buf) this._schedule(item, buf);
      }
    } finally {
      this.pumping = false;
    }
    if (gen === this.gen) this._checkIdle();
  }

  _bus(c) {
    if (!this.an || this.anCtx !== c) {
      this.an = c.createAnalyser();
      this.an.fftSize = 512;
      this.duckGain = c.createGain(); // lowered while a video plays in the Result Viewer
      this.duckGain.gain.value = this.duckLevel ?? 1;
      this.an.connect(this.duckGain).connect(c.destination);
      this.anCtx = c;
      this.fft = new Uint8Array(this.an.frequencyBinCount);
    }
    return this.an;
  }

  _schedule(item, buf) {
    const c = this._ctx();
    const bus = this._bus(c);
    const now = c.currentTime;
    const at = Math.max(now + 0.05, this.playhead);
    const src = c.createBufferSource();
    src.buffer = buf;
    let fx = null;
    if (item.fx && this.voiceFx) {
      try { fx = this.voiceFx(src); } catch { fx = null; }
    }
    if (!this.out || this.out.context !== c) {
      this.out = c.createGain(); // per-run gain, so stop(fadeMs) can fade the voice
      this.out.connect(bus);
    }
    (fx ? fx.out : src).connect(this.out);
    src.start(at);
    this.playhead = at + buf.duration + item.pause;
    this.started = true;
    this.sources.add(src);

    const gen = this.gen;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (gen === this.gen) this.onStart(item.text);
    }, Math.max(0, (at - now) * 1000));
    this.timers.add(t);

    src.onended = () => {
      this.sources.delete(src);
      if (fx) fx.dispose();
      try { src.disconnect(); } catch { /* gone */ }
      if (gen === this.gen) this._checkIdle();
    };

    if (!this.speaking) {
      this.speaking = true;
      this.analyser = bus;
      this._meter();
    }
  }

  _checkIdle() {
    if (this.sources.size || this.queue.length || this.pumping) return;
    this._resetRun();
    if (this.speaking) {
      this.speaking = false;
      this.analyser = null;
      this.onLevel(0);
      this.onIdle();
    }
  }

  /** Current output level 0..1, read on demand (the Floating Orb polls it while the window is minimized). */
  level() {
    const an = this.analyser;
    if (!an || !this.speaking) return 0;
    if (!this._lvBuf || this._lvBuf.length !== an.fftSize) this._lvBuf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(this._lvBuf);
    let s = 0;
    for (const x of this._lvBuf) s += x * x;
    return Math.min(1, Math.sqrt(s / this._lvBuf.length) * 4);
  }

  _meter() {
    const an = this.analyser;
    if (!an) return;
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      if (!this.speaking || this.analyser !== an) return;
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const x of buf) s += x * x;
      this.onLevel(Math.min(1, Math.sqrt(s / buf.length) * 4));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ================= speechSynthesis fallback =================

  async _next() {
    const item = this.queue.shift();
    if (!item) {
      if (this.speaking) {
        this.speaking = false;
        this.onIdle();
      }
      return;
    }
    if (item.gen !== this.gen) return this._next();
    this.speaking = true;
    try {
      await this._playWeb(item);
    } catch (err) {
      this.onProblem('TTS_FAILED', err.message);
    }
    if (item.gen === this.gen) this._next();
  }

  _playWeb(item) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(item.text);
      u.voice = this.webVoice;
      u.lang = this.webVoice ? this.webVoice.lang : 'th-TH';
      u.rate = item.rate ?? this.rate;
      u.pitch = item.pitch ?? 1;
      u.onstart = () => this.onStart(item.text);
      u.onend = u.onerror = () => {
        clearInterval(this.keepAlive);
        resolve();
      };
      // Chromium bug workaround: long speech can stall; nudge it periodically.
      clearInterval(this.keepAlive);
      this.keepAlive = setInterval(() => {
        if (speechSynthesis.speaking) {
          speechSynthesis.pause();
          speechSynthesis.resume();
        }
      }, 10000);
      // speechSynthesis exposes no audio signal: report "unknown", never a fake level.
      this.onLevel(null);
      speechSynthesis.speak(u);
    });
  }
}
