'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClipAnalyzer, STAGES, overall, summarize, withSilentTail, splitAtPauses } = require('../lib/video/analyze');
const { buildExtractAudioArgs, buildSilenceDetectArgs, parseFfmpegTime } = require('../lib/video/ffmpeg-args');
const { parseWhisperJson, parseWhisperProgress } = require('../lib/stt/whisper');
const { SttService } = require('../lib/stt');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-an-test-'));

test('whisper: timed segments from -oj output, tags and empty lines dropped', () => {
  const json = {
    transcription: [
      { offsets: { from: 0, to: 3900 }, text: ' สวัสดีครับ  วันนี้ ' },
      { offsets: { from: 3900, to: 4200 }, text: '[เพลง]' },
      { offsets: { from: 6500, to: 9740 }, text: 'อย่างแรก [หัวเราะ] เลย' },
      { offsets: { from: 9000, to: 8000 }, text: 'ย้อนเวลา' },
      { text: 'ไม่มีเวลา' },
    ],
  };
  assert.deepStrictEqual(parseWhisperJson(JSON.stringify(json)), [
    { start: 0, end: 3.9, text: 'สวัสดีครับ วันนี้', tokens: [] },
    { start: 6.5, end: 9.74, text: 'อย่างแรก เลย', tokens: [] },
  ]);
  const full = parseWhisperJson({ transcription: [{ offsets: { from: 0, to: 900 }, text: 'ab c', tokens: [
    { text: '[_BEG_]', offsets: { from: 0 } }, { text: 'a', offsets: { from: 100 } }, { text: 'b', offsets: { from: 200 } },
    { text: ' c', offsets: { from: 700 } }, { text: '[_TT_45]', offsets: { from: 900 } }, { text: 'x' } ] }] });
  assert.deepStrictEqual(full[0].tokens, [{ text: 'a', start: 0.1 }, { text: 'b', start: 0.2 }, { text: ' c', start: 0.7 }]);
  assert.deepStrictEqual(parseWhisperJson({}), []);
});

test('whisper: progress lines', () => {
  assert.strictEqual(parseWhisperProgress('whisper_print_progress_callback: progress =  10%\nx progress = 35%'), 35);
  assert.strictEqual(parseWhisperProgress('nothing here'), null);
  assert.strictEqual(parseWhisperProgress('progress = 140%'), 100);
});

test('stt.transcribeFile: always local whisper, corrections applied to each segment', async () => {
  const stt = new SttService({ dataDir: tmp(), tempDir: tmp() });
  stt.configure({ sttProvider: 'typhoon', whisperModel: 'small', sttVocabulary: [], sttCorrections: ['น้ำสุด=นมสด'] });
  let asked = null;
  stt.whisper.transcribeFile = async (wav, opts) => { asked = { wav, opts }; return { model: 'small', segments: [{ start: 1, end: 2, text: 'กับน้ำสุด 1 แก้ว' }] }; };
  stt.typhoon.transcribe = async () => assert.fail('clip audio must not go to a cloud provider');
  const r = await stt.transcribeFile('C:/a.wav', { model: 'small' });
  assert.strictEqual(asked.wav, 'C:/a.wav');
  assert.deepStrictEqual(r, { model: 'small', segments: [{ start: 1, end: 2, text: 'กับนมสด 1 แก้ว', raw: 'กับน้ำสุด 1 แก้ว' }] });
  assert.strictEqual(stt.correct('น้ำสุด'), 'นมสด');
  assert.strictEqual(asked.opts.prompt, undefined); // whisper.transcribeFile defaults to no prompt
});

test('ffmpeg time and audio extraction args', () => {
  assert.strictEqual(parseFfmpegTime('frame=1 time=00:01:02.50 bitrate=\rsize= time=00:01:05.25 x'), 65.25);
  assert.strictEqual(parseFfmpegTime('time=N/A'), null);
  assert.strictEqual(parseFfmpegTime('time=-00:00:00.02'), 0);
  const args = buildExtractAudioArgs('C:/in clip.mp4', 'C:/t/a.wav');
  assert.ok(Array.isArray(args));
  assert.deepStrictEqual(args.slice(-7), ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', 'C:/t/a.wav']);
  assert.ok(args.includes('C:/in clip.mp4'));
  assert.throws(() => buildExtractAudioArgs('C:/a.mp4', 'C:/a.mp3'));
  assert.throws(() => buildExtractAudioArgs('a.mp4', 'C:/a.wav'));
  assert.ok(!buildSilenceDetectArgs('C:/a.wav').includes('-nostats')); // stats feed the progress bar
});

test('silences: a sound track shorter than the picture leaves a silent tail', () => {
  const log = 'silence_start: 3.5\r\nsilence_end: 6.7 | d\nsize=N/A time=00:00:11.90 bitrate=N/A';
  assert.deepStrictEqual(withSilentTail(log, 13.7), [{ start: 3.5, end: 6.7 }, { start: 11.9, end: 13.7 }]);
  const open = 'silence_start: 3.5\nsilence_end: 6.7\nsilence_start: 10\ntime=00:00:11.90';
  assert.deepStrictEqual(withSilentTail(open, 13.7), [{ start: 3.5, end: 6.7 }, { start: 10, end: 13.7 }]);
  assert.deepStrictEqual(withSilentTail('silence_start: 1\nsilence_end: 2\ntime=00:00:10.00', 10), [{ start: 1, end: 2 }]);
});

test('progress: overall moves forward through the stages and ends at 1', () => {
  assert.strictEqual(overall('probe', 0), 0);
  assert.ok(overall('audio', 0.5) < overall('silence', 0));
  assert.strictEqual(overall('transcribe', 1), 1);
  const noStt = STAGES.filter((s) => s.id !== 'transcribe');
  assert.strictEqual(overall('silence', 1, noStt), 1);
  assert.strictEqual(overall('audio', NaN), overall('audio', 0));
});

test('summary totals', () => {
  assert.deepStrictEqual(summarize(10, [{ start: 0, end: 1 }, { start: 8, end: 12 }], [{}, {}]), { duration: 10, silenceSec: 3, speechSec: 7, silences: 2, segments: 2 });
});

/** Fake ffmpeg: writes the WAV on extraction, prints silences on the scan, records what ran. */
function fakeFfmpeg({ info = { duration: 20, video: { width: 1080, height: 1920 }, audio: { codec: 'aac' }, size: 1 }, silenceLog, failAudio = false } = {}) {
  const ran = [];
  return {
    ran,
    async probe() { return info; },
    async require() { return { ffmpeg: 'C:/ff/ffmpeg.exe', ffprobe: 'C:/ff/ffprobe.exe' }; },
    async run(exe, args, { onStderr, signal } = {}) {
      if (signal && signal.aborted) throw Object.assign(new Error('ยกเลิกแล้ว'), { code: 'ABORTED' });
      ran.push(args);
      if (args.includes('pcm_s16le')) {
        if (failAudio) return { code: 1, stdout: '', stderr: 'Stream map 0:a:0 matches no streams' };
        fs.writeFileSync(args[args.length - 1], 'RIFF');
        onStderr && onStderr('size= time=00:00:10.00 bitrate=');
        return { code: 0, stdout: '', stderr: '' };
      }
      const log = silenceLog || 'silence_start: 4\nsilence_end: 6\nsize= time=00:00:20.00';
      onStderr && onStderr(log);
      return { code: 0, stdout: '', stderr: log };
    },
  };
}

function clipFile() {
  const f = path.join(tmp(), 'clip.mp4');
  fs.writeFileSync(f, '');
  return f;
}

test('analyze: probe → audio → silence → transcribe, temp WAV removed', async () => {
  const tempDir = tmp();
  const ff = fakeFfmpeg();
  let wavSeen = null;
  const stt = {
    async transcribeFile(wav, { onProgress }) {
      wavSeen = wav;
      assert.ok(fs.existsSync(wav), 'whisper reads the extracted WAV');
      onProgress(0.5);
      return { model: 'small', segments: [{ start: 0.5, end: 4, text: 'สวัสดี' }, { start: 6, end: 25, text: 'เกินความยาว' }] };
    },
  };
  const steps = [];
  const r = await new ClipAnalyzer({ ffmpeg: ff, stt, tempDir }).analyze(clipFile(), { onProgress: (p) => steps.push(p) });
  assert.deepStrictEqual([...new Set(steps.map((p) => p.stage))], ['probe', 'audio', 'silence', 'transcribe']);
  assert.ok(steps.every((p, i) => i === 0 || p.overall >= steps[i - 1].overall), 'progress never goes back');
  assert.strictEqual(steps[steps.length - 1].overall, 1);
  assert.deepStrictEqual(r.silences, [{ start: 4, end: 6 }]);
  assert.deepStrictEqual(r.transcript.segments, [{ start: 0.5, end: 4, text: 'สวัสดี' }, { start: 6, end: 20, text: 'เกินความยาว' }]);
  assert.deepStrictEqual(r.summary, { duration: 20, silenceSec: 2, speechSec: 18, silences: 1, segments: 2 });
  assert.strictEqual(r.source.name, 'clip.mp4');
  assert.deepStrictEqual(r.warnings, []);
  assert.ok(!fs.existsSync(wavSeen));
  assert.deepStrictEqual(fs.readdirSync(tempDir), []);
  assert.ok(ff.ran.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string')));
});

test('analyze: no whisper yet → silences still found, transcript null with a warning', async () => {
  const stt = { async transcribeFile() { throw Object.assign(new Error('ยังไม่ได้ติดตั้ง whisper.cpp'), { code: 'NO_WHISPER' }); } };
  const r = await new ClipAnalyzer({ ffmpeg: fakeFfmpeg(), stt, tempDir: tmp() }).analyze(clipFile());
  assert.strictEqual(r.transcript, null);
  assert.strictEqual(r.silences.length, 1);
  assert.strictEqual(r.warnings[0].code, 'NO_WHISPER');
});

test('analyze: other whisper errors fail the job', async () => {
  const stt = { async transcribeFile() { throw new Error('whisper ล้มเหลว (exit 3)'); } };
  await assert.rejects(new ClipAnalyzer({ ffmpeg: fakeFfmpeg(), stt, tempDir: tmp() }).analyze(clipFile()), /exit 3/);
});

test('analyze: silent movie, too long, no duration, bad audio', async () => {
  const stt = { async transcribeFile() { assert.fail('nothing to transcribe'); } };
  const silent = await new ClipAnalyzer({ ffmpeg: fakeFfmpeg({ info: { duration: 5, video: {}, audio: null } }), stt, tempDir: tmp() }).analyze(clipFile());
  assert.deepStrictEqual([silent.silences, silent.transcript, silent.warnings[0].code], [[], null, 'NO_AUDIO']);
  await assert.rejects(new ClipAnalyzer({ ffmpeg: fakeFfmpeg({ info: { duration: 4000, audio: {} } }), stt, tempDir: tmp() }).analyze(clipFile()), (e) => e.code === 'TOO_LONG');
  await assert.rejects(new ClipAnalyzer({ ffmpeg: fakeFfmpeg({ info: { duration: null, audio: {} } }), stt, tempDir: tmp() }).analyze(clipFile()), (e) => e.code === 'NO_DURATION');
  const tempDir = tmp();
  await assert.rejects(new ClipAnalyzer({ ffmpeg: fakeFfmpeg({ failAudio: true }), stt, tempDir }).analyze(clipFile()), (e) => e.code === 'AUDIO');
  assert.deepStrictEqual(fs.readdirSync(tempDir), []);
  await assert.rejects(new ClipAnalyzer({ ffmpeg: fakeFfmpeg(), stt, tempDir }).analyze('relative.mp4'), /ที่อยู่เต็ม/);
});

test('analyze: transcribe can be skipped', async () => {
  const stt = { async transcribeFile() { assert.fail('skipped'); } };
  const steps = [];
  const r = await new ClipAnalyzer({ ffmpeg: fakeFfmpeg(), stt, tempDir: tmp() }).analyze(clipFile(), { transcribe: false, onProgress: (p) => steps.push(p) });
  assert.strictEqual(r.transcript, null);
  assert.ok(!steps.some((p) => p.stage === 'transcribe'));
  assert.strictEqual(steps[steps.length - 1].overall, 1);
});

test('analyze: cancel during speech-to-text stops the job and cleans up', async () => {
  const tempDir = tmp();
  const ac = new AbortController();
  const stt = {
    async transcribeFile(wav, { signal }) {
      ac.abort();
      assert.ok(signal.aborted);
      throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    },
  };
  await assert.rejects(new ClipAnalyzer({ ffmpeg: fakeFfmpeg(), stt, tempDir }).analyze(clipFile(), { signal: ac.signal }), (e) => e.code === 'ABORTED');
  assert.deepStrictEqual(fs.readdirSync(tempDir), []);
  const early = new AbortController();
  early.abort();
  await assert.rejects(new ClipAnalyzer({ ffmpeg: fakeFfmpeg(), stt, tempDir }).analyze(clipFile(), { signal: early.signal }), (e) => e.code === 'ABORTED');
});

test('analyze: a broken progress handler does not break the job', async () => {
  const stt = { async transcribeFile() { return { model: 'small', segments: [] }; } };
  const r = await new ClipAnalyzer({ ffmpeg: fakeFfmpeg(), stt, tempDir: tmp() }).analyze(clipFile(), { onProgress: () => { throw new Error('ui'); } });
  assert.deepStrictEqual(r.transcript.segments, []);
});

// Real whisper tokens (small model) for one segment that ran across a 3 s pause:
// the second sentence's token times drift early, so the split must use the phrase space.
const merged = {
  start: 0,
  end: 9.76,
  raw: 'สวัสดีครับ วันนี้ผม ยังแรกเลย 2 ช้อนกับน้ำสุด',
  text: 'สวัสดีครับ วันนี้ผม ยังแรกเลย 2 ช้อนกับนมสด',
  tokens: [
    { text: 'สวัสดี', start: 0.07 }, { text: 'ครับ', start: 0.42 }, { text: ' วันนี้', start: 0.71 }, { text: 'ผม', start: 1.15 },
    { text: ' ยัง', start: 4 }, { text: 'แรก', start: 4.44 }, { text: 'เลย', start: 4.66 },
    { text: ' 2', start: 6.92 }, { text: ' ช้อน', start: 7.27 }, { text: 'กับน้ำสุด', start: 7.72 },
  ],
};
const fix = (x) => x.replace('น้ำสุด', 'นมสด');

test('splitAtPauses: a segment across a pause is split at the nearest phrase space', () => {
  const r = splitAtPauses([merged], [{ start: 3.673, end: 6.736 }], { correct: fix });
  assert.deepStrictEqual(r, [
    { start: 0, end: 3.673, text: 'สวัสดีครับ วันนี้ผม' },
    { start: 6.736, end: 9.76, text: 'ยังแรกเลย 2 ช้อนกับนมสด' },
  ]);
});

test('splitAtPauses: stays whole when it cannot split safely', () => {
  const whole = { start: 0, end: 9.76, text: merged.text };
  // short pause, pause at the very edge, no pause
  assert.deepStrictEqual(splitAtPauses([merged], [{ start: 5, end: 5.2 }]), [whole]);
  assert.deepStrictEqual(splitAtPauses([merged], [{ start: 9.7, end: 12 }]), [whole]);
  assert.deepStrictEqual(splitAtPauses([merged], []), [whole]);
  // tokens that do not add up to whisper's text
  assert.deepStrictEqual(splitAtPauses([{ ...merged, raw: 'อื่น' }], [{ start: 3.6, end: 6.7 }]), [whole]);
  // no space anywhere near the pause
  const noSpace = { ...merged, raw: 'กขค', text: 'กขค', tokens: [{ text: 'ก', start: 0 }, { text: 'ข', start: 1 }, { text: 'ค', start: 9 }] };
  assert.deepStrictEqual(splitAtPauses([noSpace], [{ start: 3.6, end: 6.7 }]), [{ start: 0, end: 9.76, text: 'กขค' }]);
  // no tokens (plain -oj output)
  assert.deepStrictEqual(splitAtPauses([{ start: 0, end: 9, text: 'ก ข' }], [{ start: 3, end: 6 }]), [{ start: 0, end: 9, text: 'ก ข' }]);
});

test('analyze: whisper segments are split at pauses and corrected', async () => {
  const stt = {
    async transcribeFile() { return { model: 'small', segments: [merged] }; },
    correct: fix,
  };
  const ff = fakeFfmpeg({ info: { duration: 12, video: {}, audio: {} }, silenceLog: 'silence_start: 3.673\nsilence_end: 6.736\ntime=00:00:12.00' });
  const r = await new ClipAnalyzer({ ffmpeg: ff, stt, tempDir: tmp() }).analyze(clipFile());
  assert.deepStrictEqual(r.transcript.segments.map((s) => s.text), ['สวัสดีครับ วันนี้ผม', 'ยังแรกเลย 2 ช้อนกับนมสด']);
  assert.ok(r.transcript.segments.every((s) => !('tokens' in s) && !('raw' in s)), 'tokens stay in the main process');
});

// ---- one stretch of speech at a time (the Thai medium model has no usable word times) ----
const { speechChunks } = require('../lib/video/analyze');
const { pcm16ToWav, readWav, sliceWav } = require('../lib/stt/wav');

test('speechChunks: stretches between pauses, padded by at most half a pause', () => {
  const c = speechChunks([{ start: 4, end: 6 }, { start: 12, end: 12.2 }, { start: 15, end: 20 }], 20);
  // the 0.2 s pause is too short to split; the last pause runs to the end
  assert.deepStrictEqual(c, [{ start: 0, end: 4.12 }, { start: 5.88, end: 15.12 }]);
  assert.deepStrictEqual(speechChunks([], 8), [{ start: 0, end: 8 }]);
  assert.deepStrictEqual(speechChunks([{ start: 0, end: 8 }], 8), [], 'all silence → nothing to transcribe');
  assert.deepStrictEqual(speechChunks([{ start: 1, end: 1.4 }], 3).length, 2);
  const noise = speechChunks([{ start: 0.3, end: 5 }], 10);
  assert.deepStrictEqual(noise, [{ start: 4.88, end: 10 }], 'a 0.3 s blip is dropped');
});

test('speechChunks: a long stretch is cut at its longest inner pause, else at the limit', () => {
  const withPause = speechChunks([{ start: 14, end: 14.3 }, { start: 20, end: 20.2 }], 30, { minPause: 0.5, maxLen: 25 });
  assert.strictEqual(withPause.length, 2);
  assert.strictEqual(withPause[0].end, 14.15, 'cut in the middle of the longest pause that fits');
  assert.ok(withPause.every((c) => c.end - c.start <= 25.001));
  const hard = speechChunks([], 60, { maxLen: 25 });
  assert.deepStrictEqual(hard, [{ start: 0, end: 25 }, { start: 25, end: 50 }, { start: 50, end: 60 }]);
});

test('wav: read back and slice by seconds', () => {
  const pcm = Buffer.alloc(16000 * 2 * 3); // 3 s
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i % 1000, i * 2);
  const w = readWav(pcm16ToWav(pcm));
  assert.strictEqual(w.rate, 16000);
  assert.strictEqual(w.pcm.length, pcm.length);
  const part = readWav(sliceWav(w, 1, 2.5));
  assert.strictEqual(part.pcm.length, Math.round(1.5 * 16000) * 2);
  assert.strictEqual(part.pcm.readInt16LE(0), 16000 % 1000);
  assert.strictEqual(readWav(sliceWav(w, 2.9, 99)).pcm.length, Math.round(0.1 * 16000) * 2, 'past the end is clamped');
  assert.throws(() => readWav(Buffer.from('nope')), /WAV/);
});

test('analyze: with the Thai medium model each stretch is transcribed alone and timed by its pauses', async () => {
  const tempDir = tmp();
  const ff = fakeFfmpeg({ silenceLog: 'silence_start: 4\nsilence_end: 6\nsize= time=00:00:20.00' });
  const run = ff.run;
  ff.run = async (exe, args, o) => { // a real (silent) WAV so it can be sliced
    const r = await run(exe, args, o);
    if (args.includes('pcm_s16le') && r.code === 0) fs.writeFileSync(args[args.length - 1], pcm16ToWav(Buffer.alloc(16000 * 2 * 20)));
    return r;
  };
  const heard = [];
  const stt = {
    needsChunks: () => true,
    async transcribeFile(wav, { onProgress }) {
      assert.ok(/-part\d+\.wav$/.test(wav), 'a slice, not the whole clip');
      heard.push(readWav(fs.readFileSync(wav)).pcm.length / 32000);
      onProgress(1);
      return { model: 'thonburian-medium', segments: [{ start: 0, end: 30, text: heard.length === 1 ? 'ประโยคแรก' : ' ประโยค  สอง ' }] };
    },
  };
  const steps = [];
  const r = await new ClipAnalyzer({ ffmpeg: ff, stt, tempDir }).analyze(clipFile(), { onProgress: (p) => steps.push(p) });
  assert.deepStrictEqual(r.transcript.segments, [{ start: 0, end: 4.12, text: 'ประโยคแรก' }, { start: 5.88, end: 20, text: 'ประโยค สอง' }]);
  assert.strictEqual(r.transcript.model, 'thonburian-medium');
  assert.deepStrictEqual(heard.map((x) => Math.round(x * 100) / 100), [4.12, 14.12]);
  assert.ok(steps.every((p, i) => i === 0 || p.overall >= steps[i - 1].overall), 'progress never goes back');
  assert.deepStrictEqual(fs.readdirSync(tempDir), [], 'slices and the WAV are removed');
});

test('analyze: chunked mode drops empty and hallucinated lines, and cancel stops between stretches', async () => {
  const mk = (texts) => {
    const ff = fakeFfmpeg({ silenceLog: 'silence_start: 4\nsilence_end: 6\nsize= time=00:00:20.00' });
    const run = ff.run;
    ff.run = async (exe, args, o) => {
      const r = await run(exe, args, o);
      if (args.includes('pcm_s16le') && r.code === 0) fs.writeFileSync(args[args.length - 1], pcm16ToWav(Buffer.alloc(16000 * 2 * 20)));
      return r;
    };
    let n = 0;
    return { ff, stt: { needsChunks: () => true, async transcribeFile() { return { model: 'm', segments: [{ start: 0, end: 1, text: texts[n++] }] }; } } };
  };
  const a = mk(['', 'ขอบคุณที่รับชม']);
  assert.deepStrictEqual((await new ClipAnalyzer({ ffmpeg: a.ff, stt: a.stt, tempDir: tmp() }).analyze(clipFile())).transcript.segments, []);
  const ac = new AbortController();
  const b = mk(['หนึ่ง', 'สอง']);
  const first = b.stt.transcribeFile;
  b.stt.transcribeFile = async (...args) => { const x = await first(...args); ac.abort(); return x; };
  await assert.rejects(new ClipAnalyzer({ ffmpeg: b.ff, stt: b.stt, tempDir: tmp() }).analyze(clipFile(), { signal: ac.signal }), (e) => e.code === 'ABORTED');
});
