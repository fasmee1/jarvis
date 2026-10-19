'use strict';
// Hands-free mode: voice-command parser and the conversation state machine
// (fake engine, fake timers). The wake models themselves are checked by
// scripts/wake-training/eval.mjs against real audio.
const test = require('node:test');
const assert = require('node:assert');
const { sanitize, defaults } = require('../lib/settings');
const { trayIconPng } = require('../lib/tray-icon');

const load = async () => ({
  cmd: await import('../renderer/handsfree/commands.js'),
  ctl: await import('../renderer/handsfree/controller.js'),
});

test('wake phrase is stripped from the front of a transcript', async () => {
  const { cmd } = await load();
  assert.strictEqual(cmd.stripWake('จาร์วิส เปิดไฟห้องนอน'), 'เปิดไฟห้องนอน');
  assert.strictEqual(cmd.stripWake('เฮ้ จาร์วิส, ช่วยสรุปให้หน่อย'), 'ช่วยสรุปให้หน่อย');
  assert.strictEqual(cmd.stripWake('Hey Jarvis what time is it'), 'what time is it');
  assert.strictEqual(cmd.stripWake('จาวิสครับ หยุด'), 'หยุด');
  assert.strictEqual(cmd.stripWake('ช่วยเรียกจาร์วิสหน่อย'), 'ช่วยเรียกจาร์วิสหน่อย'); // only at the front
  // whisper spellings of the wake word
  assert.strictEqual(cmd.stripWake('จ้าวบิส เปิดกล้อง'), 'เปิดกล้อง');
  assert.strictEqual(cmd.stripWake('ชาร์วิสครับ ช่วยหน่อย'), 'ช่วยหน่อย');
  assert.strictEqual(cmd.stripWake('จาวิดเปิดกล้อง'), 'เปิดกล้อง');
  assert.strictEqual(cmd.stripWake('ชาววิสาหกิจชุมชน'), 'ชาววิสาหกิจชุมชน'); // not a wake word
  assert.ok(cmd.isWakeOnly('จ้าวบิส'));
  assert.ok(cmd.isWakeOnly('Hey Jarvis.'));
  assert.ok(!cmd.isWakeOnly('จาร์วิส เปิดไฟ'));
});

test('built-in voice commands match whole short utterances only', async () => {
  const { cmd } = await load();
  const p = (t) => cmd.parseCommand(t);
  assert.deepStrictEqual(p('หยุด'), { action: 'stop' });
  assert.deepStrictEqual(p('หยุดครับ'), { action: 'stop' });
  assert.deepStrictEqual(p('Stop.'), { action: 'stop' });
  assert.deepStrictEqual(p('จาร์วิส หยุด'), { action: 'stop' });
  assert.deepStrictEqual(p('พอแล้ว'), { action: 'done' });
  assert.deepStrictEqual(p("That's all"), { action: 'done' });
  assert.deepStrictEqual(p('ขอบคุณครับ'), { action: 'done' });
  assert.deepStrictEqual(p('เปิดกล้อง'), { action: 'camera-on' });
  assert.deepStrictEqual(p('ปิดกล้องครับ'), { action: 'camera-off' });
  assert.deepStrictEqual(p('ปิดการ์ดไมค์'), { action: 'card-close', card: 'mic' });
  assert.deepStrictEqual(p('ปิดการ์ด Latency'), { action: 'card-close', card: 'latency' });
  assert.deepStrictEqual(p('เปิดการ์ด คำตอบล่าสุด'), { action: 'card-open', card: 'reply' });
  assert.deepStrictEqual(p('เปิดการ์ดกล้อง'), { action: 'card-open', card: 'camera' });
  assert.deepStrictEqual(p('ปิดกัดมาย'), { action: 'card-close', card: 'mic' }); // whisper: ปิดการ์ดไมค์
  assert.deepStrictEqual(p('บิดกัดมาย'), { action: 'card-close', card: 'mic' });
  assert.deepStrictEqual(p('เปิดกาดไมค์'), { action: 'card-open', card: 'mic' });
  assert.deepStrictEqual(p('ปิดการ์ดโทเค็น'), { action: 'card-close', card: 'tokens' });
  assert.deepStrictEqual(p('ปิ๊ดกล้อง'), { action: 'camera-off' });
  assert.deepStrictEqual(p('ปิดโหมดแฮนด์ฟรี'), { action: 'handsfree-off' });
  assert.deepStrictEqual(p('ปิดแฮนด์ฟรี'), { action: 'handsfree-off' });
  // longer requests go to Claude
  assert.strictEqual(p('หยุดทำงานแล้วสรุปให้หน่อย'), null);
  assert.strictEqual(p('เปิดกล้องแล้วดูว่าวงจรถูกไหม'), null);
  assert.strictEqual(p('ปิดการ์ดจอคอมยังไง'), null);
  assert.strictEqual(p('เขียนโค้ดไฟกระพริบ'), null);
});

test('silence / whisper hallucinations count as nothing said', async () => {
  const { cmd } = await load();
  assert.ok(cmd.isNoise(''));
  assert.ok(cmd.isNoise('จาร์วิส'));
  assert.ok(cmd.isNoise('ขอบคุณที่รับชม'));
  assert.ok(cmd.isNoise('[เพลง]'.replace(/[[\]]/g, '')));
  assert.ok(!cmd.isNoise('เปิดไฟ'));
});

// ---------- state machine ----------
function fakeTimers() {
  let now = 0;
  let id = 0;
  const q = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { q.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout(i) { q.delete(i); },
    setInterval(fn, ms) { q.set(++id, { fn, at: now + ms, every: ms }); return id; },
    clearInterval(i) { q.delete(i); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [k, t] of q) if (t.at <= end && (!next || t.at < next[1].at)) next = [k, t];
        if (!next) break;
        now = next[1].at;
        if (next[1].every) next[1].at += next[1].every;
        else q.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
  };
}

function rig(over = {}) {
  const log = [];
  const engine = {
    modes: [],
    async load() { log.push('load'); },
    async start() { log.push('start'); },
    stop() { log.push('stop'); },
    setMode(m) { this.modes.push(m); },
    configure() {},
    startCommand() { log.push('startCommand'); },
    stopCommand() { log.push('stopCommand'); },
    async snapshot() { return null; },
    get mode() { return this.modes[this.modes.length - 1]; },
  };
  const timers = fakeTimers();
  const sent = [];
  const locals = [];
  const events = [];
  const sounds = [];
  const states = [];
  let transcript = { ok: true, text: 'จาร์วิส เปิดไฟห้องนอน' };
  const deps = {
    engine,
    timers,
    transcribe: async () => transcript,
    send: async (t) => { sent.push(t); return true; },
    local: (c) => locals.push(c),
    stopSpeaking: (ms) => log.push(`stopSpeaking:${ms}`),
    abortTurn: () => log.push('abortTurn'),
    sfx: Object.fromEntries(['wakeChime', 'captureBlip', 'cancelBlip', 'hfOn', 'hfOff'].map((k) => [k, () => sounds.push(k)])),
    ui: { state: (s) => states.push(s), transcript: () => {}, rec: () => {}, follow: () => {}, error: (c) => log.push(`error:${c}`), log: () => {} },
    settings: () => ({ sensitivity: 'medium', bargeVoice: true, liveTranscript: false, deviceId: '' }),
    ...over,
  };
  return { deps, engine, timers, sent, locals, events, sounds, states, log, setTranscript: (t) => { transcript = t; } };
}

const tick = () => new Promise((r) => setImmediate(r));

async function started(over) {
  const { ctl } = await load();
  const r = rig(over);
  const hf = new ctl.HandsFree(r.deps);
  for (const n of ['wake:detected', 'command:start', 'command:end', 'assistant:speaking', 'followup:timeout']) hf.on(n, () => r.events.push(n));
  await hf.enable();
  return { ...r, hf, ST: ctl.ST };
}

test('wake → command → Claude → speaking → follow-up → back to wake listening', async () => {
  const r = await started();
  const { hf, ST } = r;
  assert.strictEqual(hf.state, ST.WAKE_LISTENING);
  assert.strictEqual(r.engine.mode, 'wake');
  assert.deepStrictEqual(r.sounds, ['hfOn']);

  hf.onEngine({ type: 'wake', score: 0.97, source: 'custom' });
  assert.strictEqual(hf.state, ST.WAKE_DETECTED);
  assert.ok(r.sounds.includes('wakeChime'));
  r.timers.advance(300);
  assert.strictEqual(hf.state, ST.COMMAND_LISTENING);

  hf.onEngine({ type: 'speech-start', from: 'wake' });
  hf.onEngine({ type: 'end', reason: 'silence', hadSpeech: true, pcm: new ArrayBuffer(32000), ms: 2000 });
  await tick();
  assert.deepStrictEqual(r.sent, ['เปิดไฟห้องนอน'], 'wake word stripped before sending');
  assert.ok(r.sounds.includes('captureBlip'));
  assert.strictEqual(hf.state, ST.PROCESSING);

  // the turn has not started yet: no follow-up
  hf.assistant({ speaking: false, busy: false });
  assert.strictEqual(hf.state, ST.PROCESSING);
  hf.assistant({ speaking: false, busy: true });
  assert.strictEqual(hf.state, ST.PROCESSING);
  assert.strictEqual(r.engine.mode, 'wake', 'wake word can interrupt while Claude works');
  hf.assistant({ speaking: true, busy: true });
  assert.strictEqual(hf.state, ST.SPEAKING);
  assert.strictEqual(r.engine.mode, 'speaking');
  hf.assistant({ speaking: false, busy: false });
  assert.strictEqual(hf.state, ST.FOLLOW_UP);
  assert.strictEqual(r.engine.mode, 'follow');

  hf.onEngine({ type: 'follow-timeout' });
  assert.strictEqual(hf.state, ST.WAKE_LISTENING);
  assert.deepStrictEqual(r.events, ['wake:detected', 'command:start', 'command:end', 'assistant:speaking', 'followup:timeout']);
});

test('no speech after the wake word: quiet cancel + false-trigger count', async () => {
  const r = await started();
  r.hf.onEngine({ type: 'wake', score: 0.6, source: 'base' });
  r.timers.advance(300);
  r.hf.onEngine({ type: 'end', reason: 'no-speech', hadSpeech: false, pcm: new ArrayBuffer(0), ms: 4000 });
  await tick();
  assert.strictEqual(r.hf.state, r.ST.WAKE_LISTENING);
  assert.ok(r.sounds.includes('cancelBlip'));
  assert.strictEqual(r.hf.stats.falseTriggers, 1);
  assert.strictEqual(r.sent.length, 0);
});

test('follow-up speech starts a command without the wake word', async () => {
  const r = await started();
  r.hf.onEngine({ type: 'wake', score: 0.9 });
  r.hf.onEngine({ type: 'end', reason: 'silence', hadSpeech: true, pcm: new ArrayBuffer(32000) });
  await tick();
  r.hf.assistant({ speaking: true, busy: true });
  r.hf.assistant({ speaking: false, busy: false });
  assert.strictEqual(r.hf.state, r.ST.FOLLOW_UP);
  r.hf.onEngine({ type: 'speech-start', from: 'follow' });
  assert.strictEqual(r.hf.state, r.ST.COMMAND_LISTENING);
  assert.strictEqual(r.sounds.filter((s) => s === 'wakeChime').length, 1, 'no chime in follow-up');
});

test('barge-in: the wake word over the reply fades the voice out and listens', async () => {
  const r = await started();
  r.hf.onEngine({ type: 'wake', score: 0.9 });
  r.hf.onEngine({ type: 'end', reason: 'silence', hadSpeech: true, pcm: new ArrayBuffer(32000) });
  await tick();
  r.hf.assistant({ speaking: true, busy: true });
  assert.strictEqual(r.hf.state, r.ST.SPEAKING);
  r.hf.onEngine({ type: 'wake', score: 0.99 });
  assert.ok(r.log.includes('stopSpeaking:150'));
  assert.ok(r.log.includes('abortTurn'));
  assert.strictEqual(r.hf.state, r.ST.WAKE_DETECTED);
  // clear speech over the reply also interrupts
  r.hf.onEngine({ type: 'end', reason: 'silence', hadSpeech: true, pcm: new ArrayBuffer(32000) });
  await tick();
  r.hf.assistant({ speaking: true, busy: true });
  r.hf.onEngine({ type: 'barge-voice' });
  assert.strictEqual(r.hf.state, r.ST.COMMAND_LISTENING);
});

test('local commands run without Claude', async () => {
  const r = await started();
  const say = async (text) => {
    r.setTranscript({ ok: true, text });
    r.hf.onEngine({ type: 'wake', score: 0.9 });
    r.hf.onEngine({ type: 'end', reason: 'silence', hadSpeech: true, pcm: new ArrayBuffer(32000) });
    await tick();
  };
  await say('ปิดกล้อง');
  assert.deepStrictEqual(r.locals.pop(), { action: 'camera-off' });
  assert.strictEqual(r.hf.state, r.ST.FOLLOW_UP);
  r.hf.onEngine({ type: 'follow-timeout' });
  await say('พอแล้ว');
  assert.strictEqual(r.hf.state, r.ST.WAKE_LISTENING);
  await say('ปิดการ์ด ไมค์');
  assert.deepStrictEqual(r.locals.pop(), { action: 'card-close', card: 'mic' });
  r.hf.onEngine({ type: 'follow-timeout' });
  await say('ปิดโหมดแฮนด์ฟรี');
  assert.strictEqual(r.hf.state, r.ST.IDLE);
  assert.ok(r.sounds.includes('hfOff'));
  assert.strictEqual(r.sent.length, 0);
});

test('JARVIS talking again during the follow-up window closes the window', async () => {
  const r = await started();
  r.hf.onEngine({ type: 'wake', score: 0.9 });
  r.hf.onEngine({ type: 'end', reason: 'silence', hadSpeech: true, pcm: new ArrayBuffer(32000) });
  await tick();
  r.hf.assistant({ speaking: true, busy: true });
  r.hf.assistant({ speaking: false, busy: false });
  assert.strictEqual(r.hf.state, r.ST.FOLLOW_UP);
  r.hf.assistant({ speaking: false, busy: true }); // queued message started
  assert.strictEqual(r.hf.state, r.ST.PROCESSING);
  assert.strictEqual(r.engine.mode, 'wake');
});

test('TTS while waiting for the wake word uses the strict speaking threshold', async () => {
  const r = await started();
  r.hf.assistant({ speaking: true, busy: false }); // e.g. a typed message being read out
  assert.strictEqual(r.hf.state, r.ST.WAKE_LISTENING);
  assert.strictEqual(r.engine.mode, 'speaking');
  r.hf.assistant({ speaking: false, busy: false });
  assert.strictEqual(r.engine.mode, 'wake');
});

test('mic unplugged pauses, and listening resumes when it returns; background pause', async () => {
  const r = await started();
  r.hf.onEngine({ type: 'mic-lost' });
  assert.strictEqual(r.hf.state, r.ST.PAUSED);
  assert.ok(r.log.includes('error:MIC_LOST'));
  r.hf.onEngine({ type: 'mic-back' });
  assert.strictEqual(r.hf.state, r.ST.WAKE_LISTENING);
  await r.hf.pause('background');
  assert.strictEqual(r.hf.state, r.ST.PAUSED);
  assert.ok(r.log.includes('stop'));
  await r.hf.resume('background');
  assert.strictEqual(r.hf.state, r.ST.WAKE_LISTENING);
});

test('wake engine failure leaves hands-free off with an error (push-to-talk still works)', async () => {
  const { ctl } = await load();
  const r = rig();
  r.deps.engine.load = async () => { throw Object.assign(new Error('wasm'), { code: 'ENGINE_FAILED' }); };
  const hf = new ctl.HandsFree(r.deps);
  assert.strictEqual(await hf.enable(), false);
  assert.strictEqual(hf.state, ctl.ST.IDLE);
  assert.ok(r.log.includes('error:ENGINE_FAILED'));
});

test('hands-free settings: off by default, validated', () => {
  const d = defaults();
  assert.strictEqual(d.handsFreeConsent, false);
  assert.strictEqual(d.handsFreeAutoStart, false);
  assert.strictEqual(d.saveVoiceHistory, false);
  assert.strictEqual(d.handsFreeSensitivity, 'medium');
  assert.ok(sanitize({ handsFreeSensitivity: 'high', handsFreeBackground: 'tray' }).ok);
  assert.ok(!sanitize({ handsFreeSensitivity: 'max' }).ok);
  assert.ok(!sanitize({ handsFreeBackground: 'always' }).ok);
});

test('tray icon is a valid PNG', () => {
  const png = trayIconPng(32, { live: true });
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.strictEqual(png.readUInt32BE(16), 32);
});

test('Thai-head detection is double-checked by local whisper; a look-alike word is rejected quietly', async () => {
  const transcribe = async (pcm, o) => (o.verify ? { ok: true, text: 'ด้าวิส' } : { ok: true, text: 'เปิดไฟ' });
  const r = await started({ transcribe, settings: () => ({ sensitivity: 'medium', verifyWake: true }) });
  r.hf.onEngine({ type: 'wake', score: 0.9, source: 'custom', wakePcm: new ArrayBuffer(100) });
  r.hf.onEngine({ type: 'end', reason: 'silence', hadSpeech: true, pcm: new ArrayBuffer(32000) });
  await tick(); await tick();
  assert.strictEqual(r.hf.state, r.ST.WAKE_LISTENING);
  assert.strictEqual(r.sent.length, 0);
  assert.strictEqual(r.hf.stats.rejected, 1);
  assert.ok(r.sounds.includes('cancelBlip'));
});

test('a confirmed Thai-head detection goes ahead', async () => {
  const transcribe = async (pcm, o) => (o.verify ? { ok: true, text: 'เจ้าบิส' } : { ok: true, text: 'เปิดไฟ' });
  const r = await started({ transcribe, send: async (t) => { r2.push(t); return true; }, settings: () => ({ sensitivity: 'medium', verifyWake: true }) });
  r.hf.onEngine({ type: 'wake', score: 0.9, source: 'custom', wakePcm: new ArrayBuffer(100) });
  r.hf.onEngine({ type: 'end', reason: 'silence', hadSpeech: true, pcm: new ArrayBuffer(32000) });
  await tick(); await tick(); await tick();
  assert.deepStrictEqual(r2, ['เปิดไฟ']);
});
const r2 = [];

test('"ดูนี่" (and how STT writes it) asks JARVIS to look at the screen', async () => {
  const { cmd } = await load();
  for (const t of ['ดูนี่', 'โดนี่', 'ดูนี้หน่อย', 'จาร์วิส ดูนี่สิ ผิดตรงไหน', 'ช่วยดูอันนี้ให้หน่อย', 'ดูหน้าจอให้หน่อย', 'ดู จอ', 'look at this']) {
    assert.ok(cmd.wantsScreenLook(t), t);
  }
  for (const t of ['เปิดเพลง', 'ดูหนังเรื่องอะไรดี', 'อันนี้ราคาเท่าไหร่', 'โดนัท', 'ตรงนี้']) {
    assert.ok(!cmd.wantsScreenLook(t), t);
  }
});
