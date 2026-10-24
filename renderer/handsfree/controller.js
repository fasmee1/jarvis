// Hands-free conversation state machine.
//
//   IDLE (off)
//    → WAKE_LISTENING     wake word only, on-device
//    → WAKE_DETECTED      chime + reactor reaction (~300 ms; recording already runs)
//    → COMMAND_LISTENING  record the command (VAD: 1.2 s silence · 15 s max · 4 s no-speech)
//    → PROCESSING         speech-to-text → local command or Claude
//    → SPEAKING           TTS reply (wake word / clear speech = barge-in)
//    → FOLLOW_UP          6 s: speak again without the wake word
//    → WAKE_LISTENING     when the window passes in silence
//   PAUSED                app in background / device asleep / mic unplugged
//
// No DOM here: the engine, speech-to-text, sounds and UI are injected, so the
// flow is unit-tested with fakes (test/handsfree.test.js).
import { parseCommand, stripWake, isNoise, isWakeOnly, containsWake, isCorrection } from './commands.js';

export const ST = {
  IDLE: 'IDLE',
  WAKE_LISTENING: 'WAKE_LISTENING',
  WAKE_DETECTED: 'WAKE_DETECTED',
  COMMAND_LISTENING: 'COMMAND_LISTENING',
  PROCESSING: 'PROCESSING',
  SPEAKING: 'SPEAKING',
  FOLLOW_UP: 'FOLLOW_UP',
  PAUSED: 'PAUSED',
};

export const TIMING = {
  detectedMs: 300,
  silenceMs: 1200, // 'normal'; see END_SILENCE_MS
  maxMs: 15000,
  noSpeechMs: 4000,
  followMs: 6000,
  partialEveryMs: 1500,
  fadeMs: 150,
};

// pause length that ends a command, by the handsFreeEndSilence setting
export const END_SILENCE_MS = { fast: 800, normal: 1200, patient: 1800 };

// waits between tries when the mic is busy after sleep / unlock (≈ 30 s in all)
const MIC_RETRY_MS = [1000, 2000, 4000, 8000, 15000];

const noop = () => {};

export class HandsFree {
  /**
   * deps:
   *   engine      wake engine (see engine.js)
   *   transcribe  (pcm, { partial }) → Promise<{ ok, text?, code?, error? } | null>
   *   send        (text) → Promise<boolean>   send to Claude
   *   local       (cmd) → void                run a built-in command
   *   stopSpeaking(fadeMs)  abortTurn()  — barge-in
   *   sfx         { wakeChime, captureBlip, cancelBlip, hfOn, hfOff }
   *   ui          { state(st, info), transcript(text, final), rec(on), follow(ms|null), error(code, msg), log(text) }
   *   settings    () → { sensitivity, bargeVoice, liveTranscript, deviceId }
   *   timers      { setTimeout, clearTimeout, setInterval, clearInterval, now }
   */
  constructor(deps) {
    this.d = deps;
    // bound wrappers: browser timers throw "Illegal invocation" when called as methods of another object
    this.t = deps.timers || {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
      now: () => Date.now(),
    };
    this.ui = { state: noop, transcript: noop, rec: noop, follow: noop, error: noop, log: noop, ...(deps.ui || {}) };
    this.sfx = { wakeChime: noop, captureBlip: noop, cancelBlip: noop, hfOn: noop, hfOff: noop, ...(deps.sfx || {}) };
    this.state = ST.IDLE;
    this.listeners = new Map();
    this.cmdId = 0;
    this.pauses = new Set(); // reasons the mic is paused (background, sleep, no-mic)
    this.awaitTurn = false; // sent to Claude, waiting for the turn to start
    this.sawBusy = false;
    this.assist = { speaking: false, busy: false };
    this.stats = { wakes: 0, falseTriggers: 0, suppressed: 0, noSpeech: 0, empty: 0, ...(deps.stats || {}) };
    this.loaded = false;
    this.enabling = null;
  }

  // ---------- events for other modules ----------
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.listeners.get(name).delete(fn);
  }

  emit(name, detail = {}) {
    for (const fn of this.listeners.get(name) || []) { try { fn(detail); } catch { /* listener error */ } }
  }

  get active() {
    return this.state !== ST.IDLE;
  }

  // ---------- on / off ----------
  async enable() {
    if (this.active || this.enabling) return this.enabling;
    this.enabling = (async () => {
      try {
        if (!this.loaded) {
          this.engine = this.d.engine;
          await this.engine.load();
          this.loaded = true;
        }
        this._configure();
        if (this.pauses.size) {
          this._set(ST.PAUSED, { reason: [...this.pauses][0] });
        } else {
          await this.engine.start(this.d.settings().deviceId);
          this._listen();
        }
        this.sfx.hfOn();
        this.emit('handsfree:on');
        return true;
      } catch (err) {
        this._set(ST.IDLE);
        this.ui.error(err.code || 'ENGINE_FAILED', err.message);
        return false;
      } finally {
        this.enabling = null;
      }
    })();
    return this.enabling;
  }

  disable({ sound = true } = {}) {
    if (!this.active) return;
    this._clearTimers();
    this.cmdId++;
    if (this.engine) this.engine.stop();
    this.ui.rec(false);
    this.ui.follow(null);
    this.ui.transcript('', true);
    this._set(ST.IDLE);
    if (sound) this.sfx.hfOff();
    this.emit('handsfree:off');
  }

  toggle() {
    return this.active ? (this.disable(), false) : this.enable();
  }

  _configure() {
    const s = this.d.settings();
    this.engine.configure({ sensitivity: s.sensitivity, opts: { silenceMs: END_SILENCE_MS[s.endSilence] || TIMING.silenceMs, maxMs: TIMING.maxMs, noSpeechMs: TIMING.noSpeechMs, followMs: TIMING.followMs, bargeVoice: !!s.bargeVoice, debug: !!s.debug } });
  }

  /** Settings changed (sensitivity, barge-in, device). */
  reconfigure({ deviceChanged = false } = {}) {
    if (!this.loaded) return;
    this._configure();
    if (deviceChanged && this.active && this.state !== ST.PAUSED) {
      this.engine.start(this.d.settings().deviceId).catch((err) => this._micFailed(err));
    }
  }

  // ---------- pause (background / sleep) ----------
  async pause(reason) {
    this.pauses.add(reason);
    if (!this.active || this.state === ST.PAUSED) return;
    this._clearTimers();
    this.cmdId++;
    this.engine.stop();
    this.ui.rec(false);
    this.ui.follow(null);
    this._set(ST.PAUSED, { reason });
  }

  async resume(reason) {
    this.pauses.delete(reason);
    if (this.state !== ST.PAUSED || this.pauses.size) return;
    return this._restart();
  }

  /**
   * Reopen the mic after a pause. Wake / unlock send several resumes at once
   * (power, screen, window shown): only one start runs, and a pause or switch-off
   * that lands while the mic is opening closes it again. Right after sleep
   * Windows often reports the mic busy for a few seconds, so that is retried.
   */
  _restart(attempt = 0) {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      let err = null;
      try {
        await this.engine.start(this.d.settings().deviceId);
      } catch (e) {
        err = e;
      }
      this.starting = null;
      if (this.state !== ST.PAUSED || this.pauses.size) {
        // paused again / switched off while the mic was opening
        if (!err) this.engine.stop();
        return;
      }
      if (!err) return this._listen();
      if (err.code === 'MIC_ERROR' && attempt < MIC_RETRY_MS.length) {
        this.ui.log(`เปิดไมโครโฟนไม่ได้ (${err.message}) · ลองใหม่ใน ${MIC_RETRY_MS[attempt] / 1000} วินาที`);
        this.retryTimer = this.t.setTimeout(() => {
          this.retryTimer = null;
          if (this.state === ST.PAUSED && !this.pauses.size) this._restart(attempt + 1);
        }, MIC_RETRY_MS[attempt]);
        return;
      }
      this._micFailed(err);
    })();
    return this.starting;
  }

  _micFailed(err) {
    if (err.code === 'MIC_NOT_FOUND') {
      // wait for a device to come back (engine listens to devicechange)
      this.pauses.add('no-mic');
      this._set(ST.PAUSED, { reason: 'no-mic' });
      this.ui.error('MIC_NOT_FOUND', err.message);
      this._waitForMic();
      return;
    }
    this.ui.error(err.code || 'MIC_ERROR', err.message);
    this.disable({ sound: false });
  }

  _waitForMic() {
    if (this._micPoll) return;
    const md = typeof navigator !== 'undefined' && navigator.mediaDevices;
    if (!md) return;
    this._micPoll = async () => {
      if (!this.pauses.has('no-mic')) return;
      try {
        await this.engine.start(this.d.settings().deviceId);
        md.removeEventListener('devicechange', this._micPoll);
        this._micPoll = null;
        this.pauses.delete('no-mic');
        this.ui.log('ไมโครโฟนกลับมาแล้ว');
        if (!this.pauses.size) this._listen();
      } catch { /* not yet */ }
    };
    md.addEventListener('devicechange', this._micPoll);
  }

  // ---------- engine events ----------
  onEngine(e) {
    if (!this.active) return;
    switch (e.type) {
      case 'wake': return this._onWake(e);
      case 'suppressed':
        this.stats.suppressed++;
        this.stats.falseTriggers++;
        this.ui.log(`wake ถูกกรองระหว่าง TTS (score ${e.score.toFixed(2)}) · false triggers ${this.stats.falseTriggers}`);
        return this._saveStats();
      case 'speech-start': return this._onSpeechStart(e);
      case 'barge-voice': return this._onBargeVoice();
      case 'end': return this._onEnd(e);
      case 'follow-timeout':
        if (this.state !== ST.FOLLOW_UP) return;
        this.ui.follow(null);
        this.emit('followup:timeout');
        return this._listen();
      case 'mic-lost':
        this._clearTimers();
        this.cmdId++;
        this.ui.rec(false);
        this.ui.follow(null);
        this.pauses.add('no-mic');
        this._set(ST.PAUSED, { reason: 'no-mic' });
        return this.ui.error('MIC_LOST', '');
      case 'mic-back':
        this.pauses.delete('no-mic');
        this.ui.log('ไมโครโฟนกลับมาแล้ว');
        if (!this.pauses.size) this._listen();
        return undefined;
      case 'mic-restart':
        this.ui.log('ไมโครโฟนเงียบไปนาน · เปิดใหม่แล้ว');
        return undefined;
      case 'score':
        this.ui.log(`score base ${e.base.toFixed(3)} custom ${e.custom.toFixed(3)} · ${e.mode} · t=${e.sec.toFixed(2)}s`);
        return undefined;
      case 'stats':
        this.lastCpu = e;
        return undefined;
      case 'error':
        this.ui.error(e.code || 'ENGINE_FAILED', e.message);
        if (e.code === 'ENGINE_FAILED') this.disable({ sound: false });
        return undefined;
      default:
        return undefined;
    }
  }

  _onWake(e) {
    const st = this.state;
    if (![ST.WAKE_LISTENING, ST.PROCESSING, ST.SPEAKING].includes(st)) return;
    this.stats.wakes++;
    if (st === ST.SPEAKING || st === ST.PROCESSING || this.assist.speaking) this._barge();
    this._startCommand('wake', e);
    if (e.wakePcm && this.d.settings().verifyWake) this._verify(e.wakePcm);
  }

  /**
   * Second stage for detections by the Thai head only: local whisper must hear
   * "จาร์วิส / Jarvis" in the audio around the detection. Runs while the user is
   * already speaking the command; a miss cancels quietly (a filtered false trigger).
   */
  _verify(pcm) {
    const id = this.cmdId;
    this.verifying = (async () => {
      let r;
      try { r = await this.d.transcribe(pcm, { verify: true }); } catch { return true; }
      if (!r || !r.ok) return true; // whisper unavailable: keep the detection
      const ok = containsWake(r.text);
      this.ui.log(`ตรวจคำเรียกซ้ำ: "${r.text}" → ${ok ? 'ผ่าน' : 'ไม่ใช่คำเรียก'}`);
      return ok;
    })();
    this.verifying.then((ok) => {
      if (ok || id !== this.cmdId) return;
      if (this.state !== ST.WAKE_DETECTED && this.state !== ST.COMMAND_LISTENING) return;
      this._rejectWake();
    });
  }

  _rejectWake() {
    this.cmdId++;
    this.stats.rejected = (this.stats.rejected || 0) + 1;
    this.stats.falseTriggers++;
    this._saveStats();
    this.sfx.cancelBlip();
    this.ui.transcript('', true);
    this._listen();
  }

  /** User talks over the reply: stop the voice (150 ms fade) and the current answer. */
  _barge() {
    this.d.stopSpeaking && this.d.stopSpeaking(TIMING.fadeMs);
    if (this.assist.busy || this.awaitTurn) this.d.abortTurn && this.d.abortTurn();
    this.awaitTurn = false;
  }

  _startCommand(from, e = {}) {
    this._clearTimers();
    const id = ++this.cmdId;
    this.verifying = null;
    this.speechStarted = from !== 'wake' && from !== 'manual';
    this.fromWake = from === 'wake';
    this.ui.follow(null);
    this.ui.transcript('', false);
    this.ui.rec(true);
    if (from === 'wake' || from === 'manual') {
      this.sfx.wakeChime();
      this._set(ST.WAKE_DETECTED, { score: e.score, source: e.source });
      this.emit('wake:detected', { score: e.score, source: e.source, at: this.t.now() });
      this.timer = this.t.setTimeout(() => {
        if (this.cmdId !== id || this.state !== ST.WAKE_DETECTED) return;
        this._set(ST.COMMAND_LISTENING);
        this.emit('command:start', { from });
      }, TIMING.detectedMs);
    } else {
      this._set(ST.COMMAND_LISTENING);
      this.emit('command:start', { from });
    }
    if (this.speechStarted) this._startPartials(id);
  }

  _onSpeechStart(e) {
    if (e.from === 'follow') {
      if (this.state !== ST.FOLLOW_UP) return;
      return this._startCommand('follow');
    }
    if (this.state !== ST.WAKE_DETECTED && this.state !== ST.COMMAND_LISTENING) return;
    this.speechStarted = true;
    this._startPartials(this.cmdId);
  }

  _onBargeVoice() {
    if (this.state !== ST.SPEAKING) return;
    this._barge();
    this._startCommand('barge');
  }

  _startPartials(id) {
    if (!this.d.settings().liveTranscript || this.partialTimer) return;
    this.partialTimer = this.t.setInterval(async () => {
      if (this.cmdId !== id || this.state !== ST.COMMAND_LISTENING) return;
      if (this.partialBusy) return;
      this.partialBusy = true;
      try {
        const pcm = await this.engine.snapshot();
        if (!pcm || pcm.byteLength < 16000 * 2 * 0.8 || this.cmdId !== id) return;
        const r = await this.d.transcribe(pcm, { partial: true });
        if (r && r.ok && r.text && this.cmdId === id && this.state === ST.COMMAND_LISTENING) this.ui.transcript(stripWake(r.text), false);
      } catch { /* partials are best effort */ } finally {
        this.partialBusy = false;
      }
    }, TIMING.partialEveryMs);
  }

  async _onEnd(e) {
    if (this.state !== ST.WAKE_DETECTED && this.state !== ST.COMMAND_LISTENING) return;
    this._clearTimers();
    if (this.verifying && this.fromWake) {
      // the wake check is still running: wait for it before using the command
      const before = this.cmdId;
      const ok = await this.verifying;
      if (before !== this.cmdId) return;
      if (!ok) { this.ui.rec(false); return this._rejectWake(); }
    }
    this.verifying = null;
    const id = ++this.cmdId;
    this.ui.rec(false);
    this.emit('command:end', { reason: e.reason, hadSpeech: e.hadSpeech, ms: e.ms });
    if (!e.hadSpeech) {
      this.stats.noSpeech++;
      if (this.fromWake) this.stats.falseTriggers++;
      this._saveStats();
      this.ui.log(`ไม่มีเสียงพูดหลังคำเรียก · false triggers ${this.stats.falseTriggers}`);
      this.sfx.cancelBlip();
      this.ui.transcript('', true);
      return this._listen();
    }
    this.sfx.captureBlip();
    this.stage = 'stt';
    this._set(ST.PROCESSING, { stage: 'stt' });
    this._mode('hold');
    let r;
    try {
      r = await this.d.transcribe(e.pcm, { partial: false });
    } catch (err) {
      r = { ok: false, code: 'STT_FAILED', error: err.message };
    }
    if (id !== this.cmdId || this.state !== ST.PROCESSING) return; // barge-in / off meanwhile
    if (!r || !r.ok) {
      this.ui.error(r ? r.code || 'STT_FAILED' : 'STT_FAILED', r ? r.error : '');
      this.sfx.cancelBlip();
      return this._listen();
    }
    if (isWakeOnly(r.text)) {
      // only "จาร์วิส" was said (e.g. again in the follow-up): listen for the command now
      this.engine.startCommand();
      return this._startCommand('manual', { score: 1, source: 'repeat' });
    }
    const text = stripWake(r.text || '');
    if (isNoise(text)) {
      this.stats.empty++;
      if (this.fromWake) this.stats.falseTriggers++;
      this._saveStats();
      this.ui.log(`ถอดเสียงได้ข้อความว่าง · false triggers ${this.stats.falseTriggers}`);
      this.ui.transcript('', true);
      this.sfx.cancelBlip();
      return this._listen();
    }
    this.ui.transcript(text, true);
    if (isCorrection(text)) {
      this.stats.corrections = (this.stats.corrections || 0) + 1; // the last command was probably heard wrong
      this._saveStats();
    }
    // context: viewer / video commands only make sense while the Result Viewer is open
    const cmd = parseCommand(text, this.d.context ? this.d.context() : {});
    if (cmd) return this._local(cmd);
    this.awaitTurn = true;
    this.sawBusy = false;
    this.stage = 'send';
    this._mode('wake'); // the wake word can interrupt while Claude works
    const ok = await this.d.send(text);
    if (id !== this.cmdId) return;
    if (!ok) {
      this.awaitTurn = false;
      return this._listen();
    }
    this.stage = 'ai';
    this._afterAssist();
  }

  _local(cmd) {
    this.ui.log(`คำสั่งในเครื่อง: ${cmd.action}${cmd.op ? ' ' + cmd.op : ''}${cmd.card ? ' ' + cmd.card : ''}${cmd.n != null ? ' ' + cmd.n : ''}`);
    if (cmd.action === 'viewer') {
      this.d.local(cmd);
      this.ui.transcript('', true);
      return this._follow(); // keep listening: "ถัดไป", "เปิดอันที่ 2"… chain naturally
    }
    if (cmd.action === 'handsfree-off') {
      this.d.local(cmd);
      return this.disable();
    }
    if (cmd.action === 'stop') this.d.stopSpeaking && this.d.stopSpeaking(TIMING.fadeMs);
    this.d.local(cmd);
    this.ui.transcript('', true);
    if (cmd.action === 'stop' || cmd.action === 'done') return this._listen();
    return this._follow();
  }

  // ---------- assistant progress (from the app) ----------
  /** The app reports TTS / turn activity on every change. */
  assistant({ speaking, busy }) {
    this.assist = { speaking: !!speaking, busy: !!busy };
    if (busy) this.sawBusy = true;
    this._afterAssist();
  }

  _afterAssist() {
    let st = this.state;
    const { speaking, busy } = this.assist;
    // speech that is not an answer to a voice command (typed message, greeting):
    // keep the strict "speaking" threshold so JARVIS can't wake itself
    if (st === ST.WAKE_LISTENING) {
      const want = speaking ? 'speaking' : 'wake';
      if (this.mode !== want) this._mode(want);
      return;
    }
    // JARVIS starts working / talking again during the follow-up window (queued
    // message, typed text): close the window so the follow-up VAD never hears the reply
    if (st === ST.FOLLOW_UP && (speaking || busy)) {
      this.ui.follow(null);
      this.stage = 'ai';
      this._set(ST.PROCESSING, { stage: 'ai' });
      this._mode(speaking ? 'speaking' : 'wake');
      st = ST.PROCESSING;
    }
    if (st !== ST.PROCESSING && st !== ST.SPEAKING) return;
    if (st === ST.PROCESSING && this.stage !== 'ai') return; // still transcribing
    if (speaking) {
      if (st !== ST.SPEAKING) {
        this.awaitTurn = false;
        this.ui.transcript('', true); // the answer started: the transcript fades out
        this._set(ST.SPEAKING);
        this._mode('speaking');
        this.emit('assistant:speaking');
      }
      return;
    }
    if (busy) {
      this.awaitTurn = false;
      if (st === ST.SPEAKING) {
        this.stage = 'ai';
        this._set(ST.PROCESSING, { stage: 'ai' });
        this._mode('wake');
      }
      return;
    }
    if (this.awaitTurn && !this.sawBusy) return; // the turn has not started yet
    this.awaitTurn = false;
    this._follow();
  }

  _follow() {
    this._clearTimers();
    this.cmdId++;
    this._set(ST.FOLLOW_UP);
    this._mode('follow', { followMs: TIMING.followMs });
    this.ui.follow(TIMING.followMs);
  }

  _listen() {
    this._clearTimers();
    this.ui.rec(false);
    this.ui.follow(null);
    this._set(ST.WAKE_LISTENING);
    this._mode(this.assist.speaking ? 'speaking' : 'wake');
  }

  // ---------- manual (Ctrl+Space / core click while hands-free is on) ----------
  manual() {
    const st = this.state;
    if (st === ST.COMMAND_LISTENING || st === ST.WAKE_DETECTED) {
      this.engine.stopCommand();
      return;
    }
    if (st === ST.IDLE || st === ST.PAUSED) return;
    if (st === ST.SPEAKING || st === ST.PROCESSING) this._barge();
    this.engine.startCommand();
    this._startCommand('manual', { score: 1, source: 'manual' });
  }

  // ---------- helpers ----------
  _mode(mode, opts) {
    this.mode = mode;
    this.engine.setMode(mode, opts);
  }

  _set(st, info = {}) {
    this.state = st;
    this.ui.state(st, info);
  }

  _clearTimers() {
    if (this.timer) this.t.clearTimeout(this.timer);
    if (this.partialTimer) this.t.clearInterval(this.partialTimer);
    if (this.retryTimer) this.t.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.timer = null;
    this.partialTimer = null;
    this.partialBusy = false;
  }

  _saveStats() {
    if (this.d.saveStats) this.d.saveStats({ ...this.stats });
  }
}
