// TTS providers + a queue that speaks segments in order.
//  - 'winrt': Windows OneCore voices via main (only way to reach Thai voices on Windows)
//  - 'web'  : speechSynthesis with a th-TH voice, if Chromium exposes one
// Segments are short (≈ one sentence) which also avoids Chromium's bug where
// long utterances stop by themselves.

const api = window.jarvis;

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
    this.audio = null;
    this.muted = false;
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
    // Pre-synthesize WinRT audio right away so playback is gapless.
    if (this.engine === 'winrt') {
      item.wav = api.invoke('tts:synthesize', { text, voice: this.voiceName, rate: item.rate, pitch: item.pitch });
    }
    this.queue.push(item);
    if (!this.speaking) this._next();
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

  stop() {
    this.gen++;
    this.queue = [];
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
    clearInterval(this.keepAlive);
    if (this.speaking) {
      this.speaking = false;
      this.onIdle();
    }
  }

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
      if (this.engine === 'winrt') await this._playWinrt(item);
      else await this._playWeb(item);
    } catch (err) {
      this.onProblem('TTS_FAILED', err.message);
    }
    if (item.gen === this.gen) this._next();
  }

  async _playWinrt(item) {
    const r = await item.wav;
    if (item.gen !== this.gen) return;
    if (!r.ok) throw new Error(r.error);
    const url = URL.createObjectURL(new Blob([r.wav], { type: 'audio/wav' }));
    const audio = new Audio(url);
    this.audio = audio;
    await new Promise((resolve) => {
      audio.onplay = () => this.onStart(item.text);
      audio.onended = audio.onerror = () => resolve();
      audio.play().catch(resolve);
      this._meter(audio, item);
    });
    URL.revokeObjectURL(url);
    if (this.audio === audio) this.audio = null;
  }

  _ctx() {
    const shared = this.getContext ? this.getContext() : null;
    return shared || (this.actx = this.actx || new AudioContext());
  }

  _meter(audio, item = {}) {
    try {
      const c = this._ctx();
      const src = c.createMediaElementSource(audio);
      const an = c.createAnalyser();
      an.fftSize = 512;
      this.analyser = an;
      this.fft = new Uint8Array(an.frequencyBinCount);
      let fx = null;
      if (item.fx && this.voiceFx) {
        try { fx = this.voiceFx(src); } catch { fx = null; }
      }
      (fx ? fx.out : src).connect(an);
      an.connect(c.destination);
      const buf = new Float32Array(an.fftSize);
      const tick = () => {
        if (audio.paused || audio.ended) {
          this.analyser = null;
          if (fx) fx.dispose();
          try { src.disconnect(); an.disconnect(); } catch { /* already gone */ }
          return this.onLevel(0);
        }
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (const x of buf) s += x * x;
        this.onLevel(Math.min(1, Math.sqrt(s / buf.length) * 4));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch { /* metering is cosmetic */ }
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
