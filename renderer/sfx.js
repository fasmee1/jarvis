// JARVIS sound design — a minimal palette to match the calm HUD:
// soft sine blips, one gentle "ready" chime, and subtle whooshes for docking
// and camera mode. Everything is synthesized live with Web Audio
// (oscillators, noise, filters, envelopes). No audio files, no samples.
//
// Chain:  sound → StereoPanner → sfxBus → compressor (-18 dB, 4:1)
//         → masterGain (volume × 0.7) → limiter (≈ -6 dBFS ceiling) → speakers
// Send:   sound → reverb send → convolver (generated 2.5 s stereo IR) → sfxBus
//
// One AudioContext for the whole app (TTS shares it). Each sound is a short-lived
// "voice" whose nodes are stopped and disconnected after it ends.
// If Web Audio is missing or fails, every call is a silent no-op.

import { SAMPLE_MAP, SAMPLE_FILES } from './sfx-samples.js';
const KEY = {
  on: 'jarvis.hudSound',
  vol: 'jarvis.sfxVolume',
  bootMute: 'jarvis.bootSoundMuted',
  greet: 'jarvis.voiceGreeting',
  wake: 'jarvis.wakeChime',
};
const LOOKAHEAD = 0.01;
const WET = 0.2;
const MAX_VOICES = 24;
const FLOOR = 0.0001;
const LEVEL = 0.7; // overall output: 30 % below the previous palette

export const db = (d) => Math.pow(10, d / 20);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

function load(k, fallback) {
  try {
    const v = localStorage.getItem(k);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function save(k, v) {
  try { localStorage.setItem(k, String(v)); } catch { /* storage unavailable */ }
}

/** Desktop (Electron) autoplays; a plain browser needs a click/key first. */
export const requireGestureForAudio = !/Electron/i.test(navigator.userAgent);

/** Was the app booted before this launch? (read before boot marks it). */
const returning = load('jarvis.booted', '') === '1';

/**
 * ADSR envelope on an AudioParam. Linear attack, exponential decay/release.
 * sustain is a fraction of peak; 0 means "decay straight to silence".
 * @returns {number} the time the envelope reaches silence
 */
export function env(param, attack, decay, sustain, release, { at = 0, peak = 1, hold = 0 } = {}) {
  const a = Math.max(0.001, attack);
  const d = Math.max(0.001, decay);
  const s = Math.max(FLOOR, peak * sustain);
  param.cancelScheduledValues(at);
  param.setValueAtTime(0, at);
  param.linearRampToValueAtTime(peak, at + a);
  param.exponentialRampToValueAtTime(s, at + a + d);
  let end = at + a + d;
  if (sustain > 0) {
    param.setValueAtTime(s, end + hold);
    end += hold + Math.max(0.001, release);
    param.exponentialRampToValueAtTime(FLOOR, end);
  }
  param.setValueAtTime(0, end + 0.002);
  return end;
}

/** 2.5 s of exponentially decaying stereo noise: a large, quiet room. */
function roomIR(c, seconds = 2.5) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * i) / len);
  }
  return buf;
}

// Rising pentatonic scale from E5, one note per card in deploy order.
const PENT = [0, 2, 4, 7, 9, 12, 14, 16, 19];
const panelHz = (i) => hz(76 + PENT[((i % PENT.length) + PENT.length) % PENT.length]);

class Sfx {
  constructor() {
    this.ctx = null;
    this.failed = false;
    this.voices = new Set();
    this.listeners = new Set();
    this.enabled = load(KEY.on, '1') !== '0';
    const vol = parseFloat(load(KEY.vol, '0.6'));
    this.volume = Number.isFinite(vol) ? clamp(vol, 0, 1) : 0.6;
    this.bootMuted = load(KEY.bootMute, '0') === '1';
    this.greeting = load(KEY.greet, '1') !== '0';
    // hands-free wake chime: important feedback, plays even with HUD sound off
    this.wakeChimeOn = load(KEY.wake, '1') !== '0';
    this.chat = true; // send / done / approval cues (the SFX button in TALK)
    this.quietUntil = 0;
    this.lastHover = 0;
    const mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.reduced = !!(mq && mq.matches);
    if (mq && mq.addEventListener) mq.addEventListener('change', (e) => { this.reduced = e.matches; });
  }

  // ================= engine =================
  _init() {
    if (this.ctx || this.failed) return this.ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio unsupported');
      const c = new AC();
      const bus = c.createGain();
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      comp.knee.value = 6;
      comp.attack.value = 0.005;
      comp.release.value = 0.2;
      const master = c.createGain();
      master.gain.value = this.volume * LEVEL * (this.duckLevel ?? 1);
      const limiter = c.createDynamicsCompressor(); // peak safety: keeps peaks near -6 dBFS
      limiter.threshold.value = -6;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.1;
      bus.connect(comp).connect(master).connect(limiter).connect(c.destination);

      const revIn = c.createGain();
      const conv = c.createConvolver();
      conv.buffer = roomIR(c, 2.5);
      revIn.connect(conv).connect(bus);

      const noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const nd = noise.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

      Object.assign(this, { ctx: c, bus, master, revIn, noiseBuf: noise });
      this.samplesReady = this._loadSamples(c);
      if (this.sinkId) this._applySink();
      return c;
    } catch {
      this.failed = true;
      this.ctx = null;
      return null;
    }
  }

  /**
   * Route all app audio (sound effects + TTS, which share this context) to an
   * output device. '' = system default. Safe to call before the context exists.
   */
  async setOutputDevice(id) {
    this.sinkId = id || '';
    if (this.ctx) return this._applySink();
    return true;
  }

  async _applySink() {
    const c = this.ctx;
    if (!c || typeof c.setSinkId !== 'function') return false;
    try {
      await c.setSinkId(this.sinkId || '');
      return true;
    } catch {
      // Device gone (e.g. Bluetooth speaker turned off): fall back to default.
      try { await c.setSinkId(''); } catch { /* ignore */ }
      return false;
    }
  }

  /** The shared AudioContext (also used by TTS). Created on first use. */
  context() {
    const c = this._init();
    if (c && c.state === 'suspended' && !this.held) c.resume().catch(() => {}); // held: the voice is paused on purpose
    return c;
  }

  /** Context for a sound in `group`, or null when that sound should stay silent. */
  _ready(group = 'ui') {
    if (group === 'wake') return this.wakeChimeOn ? this.context() : null;
    if (!this.enabled) return null;
    if (group === 'boot' && this.bootMuted) return null;
    if (group === 'chat' && !this.chat) return null;
    if ((group === 'ui' || group === 'chat') && performance.now() < this.quietUntil) return null;
    return this.context();
  }

  /** Open the audio device early and wait until its clock is moving (max `maxMs`). */
  warmup(maxMs = 800) {
    const c = this.enabled ? this.context() : null;
    if (!c) return Promise.resolve(false);
    const t0 = performance.now();
    const clock = new Promise((resolve) => {
      const check = () => {
        if (c.state === 'running' && c.currentTime > 0.02) return resolve(true);
        if (performance.now() - t0 > maxMs) return resolve(false);
        setTimeout(check, 25);
      };
      check();
    });
    // the recorded sounds should be decoded before the first cue (max 1.5 s), otherwise that cue falls back to synth
    return clock.then((ok) => Promise.race([this.samplesReady || null, new Promise((r) => setTimeout(r, 1500))]).then(() => ok));
  }

  // ================= recorded samples (renderer/sfx-samples.js) =================
  async _loadSamples(c) {
    this.buffers = this.buffers || new Map();
    await Promise.all([...SAMPLE_FILES].map(async (name) => {
      try {
        const res = await fetch(new URL(`audio/sfx/${name}.ogg`, import.meta.url));
        if (!res.ok) return;
        this.buffers.set(name, await c.decodeAudioData(await res.arrayBuffer()));
      } catch { /* a missing or undecodable file just keeps the synthesized sound for its cue */ }
    }));
  }

  /** Play the recorded version of `cue`. Returns true when handled (so the synthesized one is skipped). */
  _playSample(cue, args) {
    const make = SAMPLE_MAP[cue];
    if (!make || !this.buffers || !this.buffers.size) return false;
    const spec = make(args);
    if (spec.layers.some((l) => !this.buffers.has(l.f))) return false;
    if (spec.gate === 'hover') {
      const now = performance.now();
      if (now - this.lastHover < 40) return true;
      this.lastHover = now;
    }
    const c = this._ready(spec.group);
    if (!c) return true; // muted: nothing plays, not even the synth
    if (spec.skipReduced && this.reduced) return true;
    let len = 0.2;
    for (const l of spec.layers) len = Math.max(len, (l.at || 0) + (l.dur || this.buffers.get(l.f).duration / (Array.isArray(l.rate) ? l.rate[0] : l.rate || 1)));
    const v = this._voice(c, { len: len + 0.1, pan: spec.pan || 0, wet: spec.wet ?? 0.2, group: spec.group });
    for (const l of spec.layers) {
      const at = v.t + (l.at || 0);
      const src = c.createBufferSource();
      src.buffer = this.buffers.get(l.f);
      const r0 = Array.isArray(l.rate) ? l.rate[0] : l.rate || 1;
      src.playbackRate.setValueAtTime(r0, at);
      const dur = l.dur || src.buffer.duration / r0;
      if (Array.isArray(l.rate)) src.playbackRate.linearRampToValueAtTime(l.rate[1], at + dur);
      if (l.loop) src.loop = true;
      src.start(at);
      src.stop(at + dur + 0.05);
      v.srcs.push(src);
      v.nodes.push(src);
      let tail = src;
      for (const [type, hz] of [['lowpass', l.lp], ['highpass', l.hp]]) {
        if (!hz) continue;
        const f = this._filter(v, type, Array.isArray(hz) ? hz[0] : hz, 0.7);
        if (Array.isArray(hz)) { f.frequency.setValueAtTime(hz[0], at); f.frequency.exponentialRampToValueAtTime(hz[1], at + dur); }
        tail.connect(f);
        tail = f;
      }
      const g = this._gain(v, l.fadeIn ? 0 : l.level ?? 1);
      if (l.fadeIn) { g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(l.level ?? 1, at + l.fadeIn); }
      if (l.fadeOut) {
        g.gain.setValueAtTime(l.level ?? 1, Math.max(at + (l.fadeIn || 0), at + dur - l.fadeOut));
        g.gain.linearRampToValueAtTime(0, at + dur);
      }
      tail.connect(g).connect(v.in);
    }
    return !spec.synth || 'both'; // 'both': the synthesized version also plays underneath
  }

  /** Resume the context from a click / key handler. */
  async unlock() {
    const c = this._init();
    if (!c) return false;
    try { await c.resume(); } catch { /* still locked */ }
    return c.state === 'running';
  }

  /** New voice: sources connect into v.in. */
  _voice(c, { at = 0, len = 0.3, pan = 0, wet = WET, group = 'ui', level = 1 } = {}) {
    const live = [...this.voices].filter((x) => !x.dying && !x.done);
    while (live.length >= MAX_VOICES) this._fade(live.shift(), 0.03);
    const t = c.currentTime + LOOKAHEAD + Math.max(0, at);
    const inp = c.createGain();
    const out = c.createGain();
    out.gain.value = level * (this.reduced ? 0.6 : 1);
    inp.connect(out);
    const nodes = [inp, out];
    let tail = out;
    let panner = null;
    if (c.createStereoPanner) {
      panner = c.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      out.connect(panner);
      nodes.push(panner);
      tail = panner;
    }
    tail.connect(this.bus);
    const send = c.createGain();
    send.gain.value = wet;
    tail.connect(send).connect(this.revIn);
    nodes.push(send);
    const v = { c, t, in: inp, out, pan: panner, nodes, srcs: [], group, done: false, dying: false };
    v.timer = setTimeout(() => this._free(v), (t - c.currentTime + len + 0.25) * 1000);
    this.voices.add(v);
    return v;
  }

  _free(v) {
    if (v.done) return;
    v.done = true;
    clearTimeout(v.timer);
    for (const s of v.srcs) { try { s.stop(); } catch { /* already stopped */ } }
    for (const n of v.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
    v.srcs.length = 0;
    v.nodes.length = 0;
    this.voices.delete(v);
  }

  _fade(v, fade = 0.2) {
    if (!v || v.done || v.dying) return;
    v.dying = true;
    try {
      const now = v.c.currentTime;
      v.out.gain.cancelScheduledValues(now);
      v.out.gain.setValueAtTime(v.out.gain.value, now);
      v.out.gain.linearRampToValueAtTime(0, now + fade);
    } catch { /* ignore */ }
    clearTimeout(v.timer);
    v.timer = setTimeout(() => this._free(v), (fade + 0.05) * 1000);
  }

  fadeGroup(group, fade = 0.2) {
    for (const v of this.voices) if (v.group === group) this._fade(v, fade);
  }

  fadeAll(fade = 0.2) {
    for (const v of this.voices) this._fade(v, fade);
  }

  // ---------- node helpers (all registered on the voice for cleanup) ----------
  _osc(v, type, freq, t0, t1) {
    const o = v.c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.start(t0);
    if (t1 != null) o.stop(t1);
    v.srcs.push(o);
    v.nodes.push(o);
    return o;
  }

  _noise(v, t0, t1) {
    const s = v.c.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.start(t0, Math.random() * 1.5);
    if (t1 != null) s.stop(t1);
    v.srcs.push(s);
    v.nodes.push(s);
    return s;
  }

  _gain(v, value = 0) {
    const g = v.c.createGain();
    g.gain.value = value;
    v.nodes.push(g);
    return g;
  }

  _filter(v, type, freq, q = 0.7) {
    const f = v.c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    v.nodes.push(f);
    return f;
  }

  /** One soft sine note; optional pitch glide `to` over `glide` s. */
  _tone(v, { freq, at = v.t, a = 0.004, d = 0.08, peak = 0.08, to = null, glide = null, dest = v.in }) {
    const o = this._osc(v, 'sine', freq, at, at + a + d + 0.03);
    if (to) o.frequency.exponentialRampToValueAtTime(to, at + (glide ?? a + d));
    const g = this._gain(v);
    env(g.gain, a, d, 0, 0, { at, peak });
    o.connect(g).connect(dest);
    return o;
  }

  /** A subtle filtered-noise whoosh: swells to `peak` at `top` (fraction of dur), then dies. */
  _whoosh(v, { at = v.t, dur, from, to, q = 1.2, peak = 0.08, top = 0.6 }) {
    const n = this._noise(v, at, at + dur + 0.1);
    const f = this._filter(v, 'bandpass', from, q);
    f.frequency.setValueAtTime(from, at);
    f.frequency.exponentialRampToValueAtTime(to, at + dur);
    const g = this._gain(v);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + dur * top);
    g.gain.exponentialRampToValueAtTime(FLOOR, at + dur + 0.05);
    g.gain.setValueAtTime(0, at + dur + 0.06);
    n.connect(f).connect(g).connect(v.in);
  }

  // ================= settings =================
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) { try { fn(this); } catch { /* listener error */ } }
  }

  setEnabled(on) {
    this.enabled = !!on;
    save(KEY.on, this.enabled ? '1' : '0');
    if (!this.enabled) this.fadeAll(0.15);
    this._emit();
  }

  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    save(KEY.vol, this.volume);
    if (this.master) this.master.gain.setTargetAtTime(this.volume * LEVEL * (this.duckLevel ?? 1), this.ctx.currentTime, 0.05);
    this._emit();
  }

  /** Duck every HUD sound (1 = normal), e.g. while a video plays in the Result Viewer. */
  setDuck(level) {
    this.duckLevel = level;
    if (this.master) this.master.gain.setTargetAtTime(this.volume * LEVEL * level, this.ctx.currentTime, 0.08);
  }

  setBootMuted(on) {
    this.bootMuted = !!on;
    save(KEY.bootMute, this.bootMuted ? '1' : '0');
    if (this.bootMuted) this.fadeGroup('boot', 0.2);
    this._emit();
  }

  setGreeting(on) {
    this.greeting = !!on;
    save(KEY.greet, this.greeting ? '1' : '0');
    this._emit();
  }

  setWakeChime(on) {
    this.wakeChimeOn = !!on;
    save(KEY.wake, this.wakeChimeOn ? '1' : '0');
    this._emit();
  }

  setChat(on) {
    this.chat = !!on;
  }

  /** Silence hover / click sounds for `ms` (e.g. the click that skipped the boot). */
  quiet(ms = 400) {
    this.quietUntil = performance.now() + ms;
  }

  /** Stereo position of an element on screen, -0.6 (left) … +0.6 (right). */
  panOf(el) {
    if (!el || !el.getBoundingClientRect) return 0;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return 0;
    return clamp((((r.left + r.width / 2) / innerWidth) * 2 - 1) * 1.1, -0.6, 0.6);
  }

  // ================= boot =================
  /** Power on: a soft, low sine bloom (no thump, no zap). */
  powerOn() {
    const c = this._ready('boot');
    if (!c) return;
    const v = this._voice(c, { len: 1, group: 'boot', wet: 0.3 });
    this._tone(v, { freq: 110, to: 82.41, glide: 0.8, a: 0.12, d: 0.8, peak: 0.22 });
    this._tone(v, { freq: 220, to: 164.81, glide: 0.8, a: 0.12, d: 0.6, peak: 0.05 });
  }

  /** A card appears: one soft sine blip, rising across the deploy order. */
  panelOpen(i = 0, pan = 0, { group = 'boot', blipAt = 0.05 } = {}) {
    const c = this._ready(group);
    if (!c) return;
    const v = this._voice(c, { len: blipAt + 0.2, pan, group, wet: 0.25 });
    this._blip(v, i, v.t + blipAt);
  }

  _blip(v, i, at) {
    const f = panelHz(i);
    this._tone(v, { freq: f, at, a: 0.005, d: 0.12, peak: 0.05 });
    this._tone(v, { freq: f * 2, at, a: 0.005, d: 0.05, peak: 0.01 });
  }

  /** The panelOpen blip on its own (card reopen). */
  panelBlip(i = 0, pan = 0, group = 'ui') {
    this.panelOpen(i, pan, { group, blipAt: 0 });
  }

  /** "System online": a gentle E5 → B5 → E6 sine arpeggio over a soft, slow sine pad. */
  ready(group = 'boot') {
    const c = this._ready(group);
    if (!c) return;
    const rel = this.reduced ? 0.5 : 1.4;
    const v = this._voice(c, { len: 0.2 + 0.3 + 0.4 + rel + 0.1, group, wet: 0.4 });
    const { t } = v;
    [659.26, 987.77, 1318.51].forEach((f, i) => {
      this._tone(v, { freq: f, at: t + i * 0.1, a: 0.008, d: 0.7, peak: 0.07 });
    });
    // pad: E4 + B4 sines with a slow, gentle shimmer
    const p0 = t + 0.2;
    const amp = this._gain(v);
    const end = env(amp.gain, 0.3, 0.2, 0.8, rel, { at: p0, peak: 0.05, hold: 0.3 });
    const trem = this._gain(v, 1);
    const lfo = this._osc(v, 'sine', 4, p0, end + 0.05);
    lfo.connect(this._gain(v, 0.15)).connect(trem.gain);
    for (const f of [329.63, 493.88]) {
      for (const cents of [-5, 5]) {
        const o = this._osc(v, 'sine', f, p0, end + 0.05);
        o.detune.value = cents;
        o.connect(trem);
      }
    }
    trem.connect(amp).connect(v.in);
  }

  // ================= cinematic intro (ui/hud-intro.js; group 'boot' so the boot mute applies) =================
  /** The room tone of the power-up: a low sine that climbs for `len` s with a faint filtered-air bed. */
  introHum(len = 4) {
    const c = this._ready('boot');
    if (!c) return;
    const v = this._voice(c, { len: len + 0.6, group: 'boot', wet: 0.45 });
    const { t } = v;
    this._tone(v, { freq: 49, to: 98, glide: len, a: len * 0.55, d: len * 0.45, peak: 0.16 });
    this._tone(v, { freq: 98.5, to: 196, glide: len, a: len * 0.7, d: len * 0.3, peak: 0.04 });
    if (!this.reduced) this._whoosh(v, { at: t, dur: len, from: 160, to: 1400, q: 0.8, peak: 0.035, top: 0.9 });
  }

  /** A heartbeat of the spark: one soft low thump. */
  introPulse(strength = 1) {
    const c = this._ready('boot');
    if (!c) return;
    const v = this._voice(c, { len: 0.7, group: 'boot', wet: 0.35 });
    this._tone(v, { freq: 84, to: 46, glide: 0.18, a: 0.004, d: 0.3, peak: 0.28 * strength });
    this._tone(v, { freq: 1320, a: 0.004, d: 0.12, peak: 0.012 * strength });
  }

  /** A fine mechanical tick (dials locking into place). */
  introTick(i = 0) {
    const c = this._ready('boot');
    if (!c) return;
    const v = this._voice(c, { len: 0.12, group: 'boot', wet: 0.1, pan: ((i % 5) - 2) * 0.25 });
    this._tone(v, { freq: 2400 + (i % 4) * 160, a: 0.001, d: 0.025, peak: 0.02 });
  }

  /** The ignition: a deep impact with a descending air burst and a bright shimmer on top. */
  introImpact() {
    const c = this._ready('boot');
    if (!c) return;
    const v = this._voice(c, { len: 1.9, group: 'boot', wet: 0.5 });
    this._tone(v, { freq: 62, to: 28, glide: 0.5, a: 0.004, d: 0.9, peak: 0.5 });
    this._tone(v, { freq: 124, to: 56, glide: 0.4, a: 0.004, d: 0.5, peak: 0.12 });
    if (!this.reduced) this._whoosh(v, { dur: 0.7, from: 5200, to: 240, q: 0.9, peak: 0.16, top: 0.15 });
    [1318.51, 1975.53, 2637.02].forEach((f, i) => this._tone(v, { freq: f, at: v.t + 0.06 + i * 0.07, a: 0.01, d: 1.1, peak: 0.03 }));
  }

  /** Greeting: a small rising two-note answer. */
  introGreet() {
    const c = this._ready('boot');
    if (!c) return;
    const v = this._voice(c, { len: 1.2, group: 'boot', wet: 0.45 });
    [523.25, 783.99].forEach((f, i) => this._tone(v, { freq: f, at: v.t + i * 0.14, a: 0.01, d: 0.7, peak: 0.05 }));
  }

  // ================= interaction =================
  /** Ultra-soft hover tick: 4 kHz sine, 8 ms. */
  hover(pan = 0) {
    const now = performance.now();
    if (now - this.lastHover < 40) return;
    const c = this._ready('ui');
    if (!c) return;
    this.lastHover = now;
    const v = this._voice(c, { len: 0.02, pan, wet: 0.08 });
    this._tone(v, { freq: 4000, a: 0.001, d: 0.008, peak: db(-36) });
  }

  /** Soft press blip: 1.2 kHz sine, 40 ms. */
  click(pan = 0) {
    const c = this._ready('ui');
    if (!c) return;
    const v = this._voice(c, { len: 0.06, pan, wet: 0.12 });
    this._tone(v, { freq: 1200, a: 0.002, d: 0.04, peak: 0.05 });
  }

  /** Card dock: a subtle descending whoosh gliding toward the reactor. */
  dockWhoosh(pan = 0, dur = 0.4) {
    const c = this._ready('ui');
    if (!c || this.reduced) return;
    const v = this._voice(c, { len: dur + 0.1, pan, wet: 0.25 });
    this._whoosh(v, { dur, from: 3200, to: 400, q: 1.4, peak: 0.1, top: 0.35 });
    if (v.pan) v.pan.pan.linearRampToValueAtTime(0, v.t + dur);
  }

  /** The card reaches its node: a soft low sine settle with a quiet high shimmer. */
  dockHit() {
    const c = this._ready('ui');
    if (!c) return;
    const v = this._voice(c, { len: 0.5, wet: 0.35 });
    this._tone(v, { freq: 196, to: 98, glide: 0.15, a: 0.004, d: 0.22, peak: 0.16 });
    this._tone(v, { freq: 1760, at: v.t + 0.02, a: 0.01, d: 0.4, peak: 0.015 });
  }

  /** Card reopen: the dock whoosh reversed, rising out toward the card. */
  undockWhoosh(pan = 0, dur = 0.4) {
    const c = this._ready('ui');
    if (!c || this.reduced) return;
    const v = this._voice(c, { len: dur + 0.1, wet: 0.25 });
    this._whoosh(v, { dur, from: 400, to: 3200, q: 1.4, peak: 0.09, top: 0.8 });
    if (v.pan) v.pan.pan.linearRampToValueAtTime(clamp(pan, -1, 1), v.t + dur);
  }

  micOn() {
    const c = this._ready('ui');
    if (!c) return;
    const v = this._voice(c, { len: 0.18, wet: 0.18 });
    this._tone(v, { freq: 660, a: 0.004, d: 0.07, peak: 0.06 });
    this._tone(v, { freq: 990, at: v.t + 0.08, a: 0.004, d: 0.08, peak: 0.06 });
  }

  micOff() {
    const c = this._ready('ui');
    if (!c) return;
    const v = this._voice(c, { len: 0.18, wet: 0.18 });
    this._tone(v, { freq: 990, a: 0.004, d: 0.07, peak: 0.05 });
    this._tone(v, { freq: 660, at: v.t + 0.08, a: 0.004, d: 0.08, peak: 0.05 });
  }

  // ================= hands-free =================
  /** Wake word heard: a short rising two-note chime, E5 → B5, sine, 120 ms in total. */
  wakeChime() {
    const c = this._ready('wake');
    if (!c) return;
    const v = this._voice(c, { len: 0.2, wet: 0.2, group: 'wake' });
    this._tone(v, { freq: 659.25, a: 0.004, d: 0.056, peak: 0.07 });
    this._tone(v, { freq: 987.77, at: v.t + 0.06, a: 0.004, d: 0.056, peak: 0.07 });
  }

  /** The command was captured: one soft blip. */
  captureBlip() {
    const c = this._ready('ui');
    if (!c) return;
    const v = this._voice(c, { len: 0.12, wet: 0.15 });
    this._tone(v, { freq: 1318.51, a: 0.003, d: 0.06, peak: 0.04 });
  }

  /** Timeout / cancel: a quiet falling blip. */
  cancelBlip() {
    const c = this._ready('ui');
    if (!c) return;
    const v = this._voice(c, { len: 0.2, wet: 0.15 });
    this._tone(v, { freq: 740, to: 494, glide: 0.12, a: 0.004, d: 0.13, peak: 0.03 });
  }

  /** Hands-free on: a soft rising tone. */
  hfOn() {
    const c = this._ready('ui');
    if (!c) return;
    const v = this._voice(c, { len: 0.32, wet: 0.25 });
    this._tone(v, { freq: 523.25, to: 783.99, glide: 0.2, a: 0.02, d: 0.24, peak: 0.05 });
  }

  /** Hands-free off: the same tone, falling. */
  hfOff() {
    const c = this._ready('ui');
    if (!c) return;
    const v = this._voice(c, { len: 0.32, wet: 0.25 });
    this._tone(v, { freq: 783.99, to: 523.25, glide: 0.2, a: 0.02, d: 0.24, peak: 0.045 });
  }

  /** Camera mode: a subtle whoosh over a soft low sine glide. dir 'in' rises, 'out' falls. */
  cameraTransform(dir = 'in', dur = 0.65) {
    const c = this._ready('ui');
    if (!c) return;
    const inn = dir === 'in';
    const v = this._voice(c, { len: dur + 0.2, wet: 0.25, group: 'cam' });
    if (!this.reduced) {
      this._whoosh(v, { dur, from: inn ? 300 : 2400, to: inn ? 2400 : 300, q: 1.2, peak: 0.07, top: inn ? 0.8 : 0.3 });
    }
    this._tone(v, { freq: inn ? 110 : 82.41, to: inn ? 82.41 : 110, glide: dur, a: 0.06, d: dur, peak: 0.12 });
  }

  /** "Lens focus" when the video appears: two quick soft blips. */
  lensFocus() {
    const c = this._ready('ui');
    if (!c) return;
    const v = this._voice(c, { len: 0.2, wet: 0.2, pan: 0.3, group: 'cam' });
    this._tone(v, { freq: 1760, a: 0.002, d: 0.05, peak: 0.035 });
    this._tone(v, { freq: 2349.32, at: v.t + 0.06, a: 0.002, d: 0.06, peak: 0.035 });
  }

  /** Error: a low double pulse — clear, not harsh. */
  error() {
    const c = this._ready('ui');
    if (!c) return;
    const v = this._voice(c, { len: 0.35, wet: 0.12 });
    for (const dt of [0, 0.14]) {
      const at = v.t + dt;
      const o = this._osc(v, 'sine', 196, at, at + 0.12);
      const g = this._gain(v);
      env(g.gain, 0.006, 0.02, 0.7, 0.03, { at, peak: 0.14, hold: 0.05 });
      o.connect(g).connect(v.in);
    }
  }

  // ================= chat cues (the SFX button in TALK) =================
  send() {
    const c = this._ready('chat');
    if (!c) return;
    const v = this._voice(c, { len: 0.14, wet: 0.18, group: 'chat' });
    this._tone(v, { freq: 990, a: 0.003, d: 0.05, peak: 0.045 });
    this._tone(v, { freq: 1320, at: v.t + 0.06, a: 0.003, d: 0.06, peak: 0.045 });
  }

  done() {
    const c = this._ready('chat');
    if (!c) return;
    const v = this._voice(c, { len: 0.22, wet: 0.25, group: 'chat' });
    this._tone(v, { freq: 1318.51, a: 0.004, d: 0.16, peak: 0.04 });
  }

  approval() {
    const c = this._ready('chat');
    if (!c) return;
    const v = this._voice(c, { len: 0.32, wet: 0.18, group: 'chat' });
    for (const [dt, f] of [[0, 880], [0.11, 1174.66], [0.22, 880]]) {
      this._tone(v, { freq: f, at: v.t + dt, a: 0.004, d: 0.08, peak: 0.05 });
    }
  }

  shutter() {
    const c = this._ready('chat');
    if (!c) return;
    const v = this._voice(c, { len: 0.12, wet: 0.12, group: 'chat' });
    this._tone(v, { freq: 2637, a: 0.001, d: 0.025, peak: 0.03 });
    this._tone(v, { freq: 1975.53, at: v.t + 0.04, a: 0.001, d: 0.03, peak: 0.03 });
  }

  // ================= voice greeting color =================
  /**
   * Light robotic color for a TTS voice already connected as `src` (a node in this
   * context): highpass 150 Hz, ~30 Hz ring modulation mixed in at 15 %, plus the
   * reverb send. Connect the returned `out` to the destination; call dispose() after.
   */
  voiceFx(src) {
    const c = this.ctx;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 150;
    hp.Q.value = 0.7;
    const dry = c.createGain();
    dry.gain.value = 0.85;
    const ring = c.createGain();
    ring.gain.value = 0; // driven ±1 by the 30 Hz carrier
    const carrier = c.createOscillator();
    carrier.frequency.value = 30;
    carrier.connect(ring.gain);
    const wet = c.createGain();
    wet.gain.value = 0.15;
    const out = c.createGain();
    const send = c.createGain();
    send.gain.value = 0.2;
    src.connect(hp);
    hp.connect(dry).connect(out);
    hp.connect(ring).connect(wet).connect(out);
    out.connect(send).connect(this.revIn);
    carrier.start();
    const nodes = [hp, dry, ring, carrier, wet, out, send];
    return {
      out,
      dispose() {
        try { carrier.stop(); } catch { /* already stopped */ }
        for (const n of nodes) { try { n.disconnect(); } catch { /* gone */ } }
      },
    };
  }

  // ================= global hover / click =================
  /** Hover ticks and click blips for buttons and cards across the app. */
  bindUi(root = document) {
    const HOVER = 'button, .card, .menu-item, select, input[type="checkbox"], input[type="range"]';
    const SKIP = '.card-x, #btn-mic, #btn-hud-sound, #menu-snd-toggle, [data-sfx="none"]';
    let last = null;
    root.addEventListener('pointerover', (e) => {
      if (document.body.classList.contains('booting')) return;
      const el = e.target.closest && e.target.closest(HOVER);
      if (el === last) return;
      last = el;
      if (el && !el.disabled) this.hover(this.panOf(el));
    }, true);
    root.addEventListener('click', (e) => {
      if (document.body.classList.contains('booting')) return;
      const el = e.target.closest && e.target.closest('button, .menu-item');
      if (el && !el.disabled && !el.matches(SKIP)) this.click(this.panOf(el));
    }, true);
  }
}

// Every cue with a recorded version in sfx-samples.js plays the sample first and keeps the synthesized sound as the
// fallback (and, where the map says `synth`, as a layer underneath).
for (const cue of Object.keys(SAMPLE_MAP)) {
  const synth = Sfx.prototype[cue];
  if (typeof synth !== 'function') continue;
  Sfx.prototype[cue] = function (...args) {
    const r = this._playSample(cue, args);
    if (r === true) return undefined;
    return synth.apply(this, args);
  };
}

export const sfx = new Sfx();

/** The SFX toggle in TALK (send / done / approval / shutter cues). */
export function setSfxEnabled(on) {
  sfx.setChat(on);
}

/** Optional voice greeting after the ready chime. */
export function greetingLine() {
  return returning ? 'สวัสดีครับ ยินดีต้อนรับกลับมา' : 'ระบบพร้อมใช้งานครับ';
}

// Desktop: open the audio device as soon as the app loads so its clock is
// already running when the boot timeline starts.
sfx.warmStart = !requireGestureForAudio && sfx.enabled ? sfx.warmup(1200) : null;
