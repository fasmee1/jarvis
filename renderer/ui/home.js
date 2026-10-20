// Home instrument controller: scales the 1920×1080 stage to the window,
// runs the render loop and turns real app signals into visuals.

import './ease.js';
import { W, H, pickLayout } from './layout.js';
import { Grid } from './grid.js';
import { Core } from './core.js';
import { Cards } from './cards.js';
import { Ticks } from './ticks.js';
import { Docking } from './docking.js';

const $ = (id) => document.getElementById(id);

export class Home {
  constructor({ onOpen, onCoreClick }) {
    this.root = $('home');
    this.stage = $('stage');
    this.grid = new Grid($('grid-bg'), $('grid-fx'));
    this.core = new Core($('core'));
    this.ticks = new Ticks($('core-wrap'), $('core'));
    this.cards = new Cards({ container: $('cards'), leaders: $('leaders'), framing: $('framing'), core: this.core, tip: $('card-tip'), onOpen, onClose: (id) => this.docking && this.docking.close(id) });
    this.state = 'STANDBY';
    this.stateAt = performance.now();
    this.visible = true;
    this.quality = 'high';
    this.signals = { mic: null, tts: null };
    this.bandsProvider = null;
    this.speaking = false;
    this.layoutName = '';
    $('core-hit').addEventListener('click', () => onCoreClick());
    addEventListener('resize', () => this.resize());
    this._idle();
    this.resize();
    this.docking = new Docking(this);
    this._clock();
    this._last = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }

  setQuality(q) {
    this.quality = q === 'low' ? 'low' : 'high';
    this.core.quality = this.quality;
    this.grid.quality = this.quality;
  }

  setVisible(v) {
    this.visible = v;
  }

  /** Minimized / hidden: stop drawing the reactor (the Floating Orb shows the state). */
  setPaused(p) {
    this.paused = !!p;
  }

  resize() {
    const scale = Math.min(innerWidth / W, innerHeight / H);
    // snap the stage origin so the window grid and the stage grid coincide
    const ox = Math.round((innerWidth - W * scale) / 2);
    const oy = Math.round((innerHeight - H * scale) / 2);
    this.t = { scale, ox, oy };
    this.stage.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
    this.grid.resize(this.t);
    this.core.resize(scale);
    const layout = pickLayout(innerWidth, innerHeight);
    if (layout.name !== this.layoutName) {
      this.layoutName = layout.name;
      this.cards.build(layout);
      this._replay();
    }
  }

  /** Write the reactor group's transform (camera mode moves/scales it as one piece). */
  applyReactor() {
    const R = this.cards.reactor;
    const wrap = $('core-wrap');
    if (R.x === 0 && R.y === 0 && R.s === 1 && R.r === 0) wrap.style.transform = '';
    else wrap.style.transform = `translate(${R.x}px, ${R.y}px) rotate(${R.r}deg) scale(${R.s})`;
  }

  _replay() {
    // re-apply cached values after a rebuild
    const c = this.cache || {};
    if (c.reply) this.cards.setReply(c.reply.text, c.reply.prog);
    this.cards.setLatency(c.latency || []);
    this.cards.setStep(c.step || null);
    this.cards.setTokens(c.tokens ?? null);
    if (c.usage) this.cards.setUsage(c.usage);
    this.cards.setMic(null, {});
    this.cards.setTts(null, { engine: c.engine || 'none' });
  }

  // ---------- inputs from the app (real data only) ----------

  /** view: optional { label, tone: 'tert' } — hands-free shows its own status text. */
  setState(st, sub, view = null) {
    if (st !== this.state) {
      this.state = st;
      this.stateAt = performance.now();
      this.core.setState(st);
    }
    this._label = { st, sub, view };
    if (this.booting) return; // boot sequence owns the label until Ready
    this.applyLabel();
  }

  /** Write the current state into the core readout. */
  applyLabel() {
    const { st, sub, view } = this._label || { st: this.state, sub: '' };
    const lab = $('state-label');
    lab.textContent = view && view.label != null ? view.label : st.replace(/_/g, ' ');
    lab.className = `state-label${st === 'ERROR' ? ' err' : st === 'AWAITING_APPROVAL' ? ' att' : ''}${view && view.tone ? ' ' + view.tone : ''}`;
    $('state-sub').textContent = sub || '';
  }

  /** rms: real mic RMS (0..1) or null when the mic is closed */
  mic(rms, { listening }) {
    this.signals.mic = rms;
    const db = rms == null ? null : rms > 0 ? 20 * Math.log10(rms) : -90;
    this.cards.setMic(db, { listening, active: rms != null });
  }

  /** level: real output envelope 0..1, or null when not measurable */
  tts(level, { speaking, engine }) {
    this.speaking = speaking;
    this.signals.tts = level;
    (this.cache ||= {}).engine = engine;
    this.cards.setTts(level == null ? null : Math.min(100, level * 100), { speaking, engine });
    this.cards.pushWave(level);
  }

  delta() {
    this.core.pulseActivity();
  }

  reply(text, prog) {
    (this.cache ||= {}).reply = { text, prog };
    this.cards.setReply(text, prog || {});
    if (prog && prog.total) this.core.setSignals({ progress: prog.spoken / prog.total });
  }

  latency(hist) {
    (this.cache ||= {}).latency = hist;
    this.cards.setLatency(hist);
  }

  step(s) {
    (this.cache ||= {}).step = s;
    this.cards.setStep(s);
  }

  tokens(n) {
    (this.cache ||= {}).tokens = n;
    if (!this.cache.usage) this.cards.setTokens(n); // real limits, once known, take the card
  }

  /** Real Claude Code usage (lib/usage): weekly % + reset on the Tokens card. */
  usage(snap) {
    if (!snap || !snap.limits) return;
    (this.cache ||= {}).usage = snap;
    this.cards.setUsage(snap);
  }

  // ---------- hands-free ----------
  /** Wake word heard: the reactor reacts once. */
  hfWake() {
    this.core.wake();
  }

  /** Follow-up countdown arc (ms) or null to hide. */
  hfFollow(ms) {
    this.core.setFollow(ms);
  }

  /** "● REC" in amber — only while a command is being recorded. */
  hfRec(on) {
    $('hf-rec').hidden = !on;
  }

  /**
   * One-line live transcript under the status text (≤ 60 characters,
   * ellipsized from the left). Secondary while speaking, primary when final;
   * an empty text fades the line out.
   */
  hfTranscript(text, final) {
    const el = $('hf-transcript');
    clearTimeout(this._trTimer);
    if (!text) {
      el.classList.add('fade');
      this._trTimer = setTimeout(() => { el.textContent = ''; }, 400);
      return;
    }
    const t = text.replace(/\s+/g, ' ').trim();
    // never start the cut on a Thai vowel / tone mark (U+0E31, U+0E34–0E3A, U+0E47–0E4E): it would render on a dotted circle
    el.textContent = t.length > 60 ? '…' + t.slice(-59).replace(/^[ัิ-ฺ็-๎]+/, '') : t;
    el.classList.remove('fade');
    el.classList.toggle('final', !!final);
  }

  /** Small "● CAM" indicator in the core readout while the camera is live. */
  setCamera(on) {
    $('core-cam').hidden = !on;
  }

  // ---------- loop ----------

  _loop(now) {
    requestAnimationFrame((t) => this._loop(t));
    const minDt = this.quality === 'low' ? 1000 / 30 : 0;
    if (now - this._last < minDt) return;
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    if (!this.visible || this.paused) return;

    // feed real levels into the core
    const st = this.state;
    let level = 0;
    let bands = null;
    if ((st === 'LISTENING' || st === 'FOLLOW_UP') && this.signals.mic != null) {
      level = Math.min(1, this.signals.mic * 7);
      bands = this.bandsProvider && this.bandsProvider('mic');
    } else if (this.speaking && this.signals.tts != null) {
      level = this.signals.tts;
      bands = this.bandsProvider && this.bandsProvider('tts');
    }
    this.core.setSignals({ level, bands });
    this.core.frame(now, dt);
    this.cards.layoutLeaders();
    this.cards.frame(now, { speaking: this.speaking });

    const el = now - this.stateAt;
    if (!this._lastEl || now - this._lastEl > 100) {
      this._lastEl = now;
      $('core-elapsed').textContent = `${(el / 1000).toFixed(1)}s`;
      this.cards.setElapsed(el);
    }
  }

  _clock() {
    const cap = $('caption-tr');
    const tick = () => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      cap.textContent = `MEE JARVIS · SYS v1.0 · ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    tick();
    setInterval(tick, 1000);
  }

  _idle() {
    const hb = $('hamburger');
    let timer = null;
    const wake = () => {
      hb.classList.remove('idle');
      clearTimeout(timer);
      timer = setTimeout(() => hb.classList.add('idle'), 4000);
    };
    for (const ev of ['mousemove', 'keydown', 'mousedown', 'wheel', 'touchstart']) addEventListener(ev, wake, { passive: true });
    wake();
  }
}
