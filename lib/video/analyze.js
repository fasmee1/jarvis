'use strict';
// "Understands" a clip before the auto edit: what is in the file, where the
// pauses are, and what is said when. Four stages, each reported to onProgress:
//   probe → audio (16 kHz WAV in the temp folder) → silence → transcribe (local whisper)
// The temp WAV is always deleted. The source file is only read.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { checkInput } = require('./ffmpeg');
const { readWav, sliceWav } = require('../stt/wav');
const { alignWords } = require('./words');
const { buildExtractAudioArgs, buildSilenceDetectArgs, parseSilence, parseFfmpegTime } = require('./ffmpeg-args');

const STAGES = Object.freeze([
  { id: 'probe', label: 'อ่านข้อมูลคลิป', weight: 0.02 },
  { id: 'audio', label: 'ดึงเสียงจากคลิป', weight: 0.13 },
  { id: 'silence', label: 'หาช่วงเงียบ', weight: 0.1 },
  { id: 'transcribe', label: 'ถอดเสียงพูด', weight: 0.75 },
]);

const MAX_DURATION_SEC = 60 * 60;

class AnalyzeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Overall 0..1 from the current stage and how far into it we are. */
function overall(stageId, fraction, stages = STAGES) {
  let done = 0;
  let total = 0;
  for (const s of stages) total += s.weight;
  for (const s of stages) {
    if (s.id === stageId) return Math.min(1, (done + s.weight * clamp01(fraction)) / total);
    done += s.weight;
  }
  return 1;
}

function clamp01(x) {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

/** Totals the editor and the auto edit start from. */
function summarize(duration, silences, segments) {
  const silenceSec = silences.reduce((n, s) => n + Math.max(0, Math.min(duration, s.end) - Math.max(0, s.start)), 0);
  return {
    duration,
    silenceSec: round3(silenceSec),
    speechSec: round3(Math.max(0, duration - silenceSec)),
    silences: silences.length,
    segments: segments ? segments.length : 0,
  };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

class ClipAnalyzer {
  /** ffmpeg: Ffmpeg (lib/video/ffmpeg.js). stt: SttService (transcribeFile). tempDir: for the WAV. */
  constructor({ ffmpeg, stt, tempDir, maxDurationSec = MAX_DURATION_SEC }) {
    this.ffmpeg = ffmpeg;
    this.stt = stt;
    this.tempDir = tempDir;
    this.maxDurationSec = maxDurationSec;
  }

  /**
   * opts.onProgress({ stage, label, fraction, overall }) · opts.signal cancels (code ABORTED).
   * opts.transcribe: false skips speech-to-text. opts.silence: { noiseDb, minSilenceSec }.
   * A missing whisper does not fail the job: the transcript is null and a warning says why.
   */
  async analyze(file, { signal, onProgress = () => {}, transcribe = true, silence = {} } = {}) {
    const input = checkInput(file);
    const stages = transcribe ? STAGES : STAGES.filter((s) => s.id !== 'transcribe');
    const report = (id, fraction) => {
      const s = stages.find((x) => x.id === id);
      try {
        onProgress({ stage: id, label: s.label, fraction: clamp01(fraction), overall: overall(id, fraction, stages) });
      } catch { /* the UI must not break the job */ }
    };
    const warnings = [];
    const checkAbort = () => {
      if (signal && signal.aborted) throw new AnalyzeError('ยกเลิกแล้ว', 'ABORTED');
    };

    report('probe', 0);
    const info = await this.ffmpeg.probe(input, { signal });
    if (!info.duration) throw new AnalyzeError('อ่านความยาวคลิปไม่ได้', 'NO_DURATION');
    if (info.duration > this.maxDurationSec) {
      throw new AnalyzeError(`คลิปยาวเกิน ${Math.round(this.maxDurationSec / 60)} นาที`, 'TOO_LONG');
    }
    const source = { path: input, name: path.basename(input), duration: info.duration, video: info.video, audio: info.audio, size: info.size };
    report('probe', 1);

    if (!info.audio) {
      warnings.push({ code: 'NO_AUDIO', message: 'คลิปนี้ไม่มีเสียง จึงหาช่วงเงียบและถอดเสียงพูดไม่ได้' });
      return this._result(source, [], null, warnings);
    }

    const { ffmpeg } = await this.ffmpeg.require();
    fs.mkdirSync(this.tempDir, { recursive: true });
    const wav = path.join(this.tempDir, `clip-${crypto.randomBytes(6).toString('hex')}.wav`);
    try {
      checkAbort();
      report('audio', 0);
      const timed = (id) => (d) => {
        const t = parseFfmpegTime(d);
        if (t !== null) report(id, t / info.duration);
      };
      const a = await this.ffmpeg.run(ffmpeg, buildExtractAudioArgs(input, wav), { signal, onStderr: timed('audio') });
      if (a.code !== 0 || !fs.existsSync(wav)) throw new AnalyzeError(`ดึงเสียงจากคลิปไม่สำเร็จ ${tail(a.stderr)}`.trim(), 'AUDIO');
      report('audio', 1);

      checkAbort();
      report('silence', 0);
      const s = await this.ffmpeg.run(ffmpeg, buildSilenceDetectArgs(wav, { noiseDb: -35, minSilenceSec: 0.2, ...silence }), { signal, onStderr: timed('silence') });
      if (s.code !== 0) throw new AnalyzeError(`หาช่วงเงียบไม่สำเร็จ ${tail(s.stderr)}`.trim(), 'SILENCE');
      const silences = withSilentTail(s.stderr, info.duration);
      report('silence', 1);

      let transcript = null;
      if (transcribe) {
        checkAbort();
        report('transcribe', 0);
        try {
          if (this.stt.needsChunks && this.stt.needsChunks()) {
            transcript = await this._transcribeByChunks(wav, silences, info.duration, { signal, report: (f) => report('transcribe', f) });
          } else {
            const t = await this.stt.transcribeFile(wav, { signal, onProgress: (f) => report('transcribe', f) });
            const correct = this.stt.correct ? (x) => this.stt.correct(x) : (x) => x;
            transcript = {
              model: t.model,
              segments: splitAtPauses(t.segments, silences, { correct })
                .map((x) => ({ start: round3(Math.max(0, x.start)), end: round3(Math.min(info.duration, x.end)), text: x.text }))
                .filter((x) => x.end > x.start),
            };
          }
        } catch (err) {
          if (err.code === 'ABORTED' || (signal && signal.aborted)) throw new AnalyzeError('ยกเลิกแล้ว', 'ABORTED');
          if (err.code !== 'NO_WHISPER' && err.code !== 'NO_MODEL') throw err;
          warnings.push({ code: err.code, message: `ยังถอดเสียงพูดไม่ได้: ${err.message}` });
        }
        report('transcribe', 1);
      }
      return this._result(source, silences, transcript, warnings);
    } finally {
      try { fs.rmSync(wav, { force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * One stretch of speech at a time (see speechChunks): the words come from the speech model,
   * the start and end of each line from the pauses, which are exact. Resolves { model, segments }.
   */
  async _transcribeByChunks(wav, silences, duration, { signal, report }) {
    const chunks = speechChunks(silences, duration);
    const audio = readWav(fs.readFileSync(wav));
    const segments = [];
    let model = '';
    for (let i = 0; i < chunks.length; i++) {
      if (signal && signal.aborted) throw new AnalyzeError('ยกเลิกแล้ว', 'ABORTED');
      const c = chunks[i];
      const part = wav.replace(/\.wav$/i, `-part${i}.wav`);
      fs.writeFileSync(part, sliceWav(audio, c.start, c.end));
      try {
        const t = await this.stt.transcribeFile(part, { signal, onProgress: (f) => report((i + f) / chunks.length) });
        model = t.model || model;
        const text = t.segments.map((s) => String(s.text).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
        if (text && !HALLUCINATION.test(text)) {
          // token times are relative to the part; word times use them only when they look right
          const tokens = t.segments.flatMap((s) => (s.tokens || []).map((k) => ({ text: k.text, start: c.start + k.start })));
          const { words, timing } = alignWords(text, c.start, c.end, tokens);
          segments.push({ start: round3(c.start), end: round3(c.end), text, words, wordTiming: timing });
        }
      } finally {
        try { fs.rmSync(part, { force: true }); } catch { /* best effort */ }
      }
      report((i + 1) / chunks.length);
    }
    return { model, segments };
  }

  _result(source, silences, transcript, warnings) {
    return {
      version: 1,
      analyzedAt: new Date().toISOString(),
      source,
      silences,
      transcript,
      summary: summarize(source.duration, silences, transcript && transcript.segments),
      warnings,
    };
  }
}

/**
 * Silences from a silencedetect run. When the sound track ends before the picture
 * (the last "time=" is short of the clip length), the rest counts as silence too.
 */
function withSilentTail(stderr, duration) {
  const audioEnd = Math.min(duration, parseFfmpegTime(stderr) ?? duration);
  const out = parseSilence(stderr, audioEnd)
    .map((x) => ({ start: round3(x.start), end: round3(Math.min(duration, x.end)) }))
    .filter((x) => x.end > x.start);
  if (duration - audioEnd > 0.2) {
    const last = out[out.length - 1];
    if (last && last.end >= audioEnd - 0.05) last.end = round3(duration);
    else out.push({ start: round3(audioEnd), end: round3(duration) });
  }
  return out;
}

/**
 * whisper sometimes returns one segment across a clear pause. Split it there, but only at a
 * space between phrases (Thai whisper output puts spaces at phrase breaks): token times are
 * too rough to cut by time alone. The space whose token time is nearest the pause wins, and
 * must be within `reach` seconds of it. Segments without tokens, or whose tokens do not add
 * up to whisper's own text, stay whole. Pieces get the user's corrections via correct().
 */
function splitAtPauses(segments, silences, { minPause = 0.4, edge = 0.2, reach = 1, correct = (x) => x } = {}) {
  const clean = (x) => String(x).replace(/\s+/g, ' ').trim();
  const out = [];
  for (const seg of segments) {
    const toks = seg.tokens || [];
    const raw = clean(seg.raw !== undefined ? seg.raw : seg.text);
    const pauses = silences.filter((p) => p.end - p.start >= minPause && p.start > seg.start + edge && p.end < seg.end - edge);
    if (!pauses.length || !toks.length || clean(toks.map((t) => t.text).join('')) !== raw) {
      out.push({ start: seg.start, end: seg.end, text: seg.text });
      continue;
    }
    const pieces = [];
    let from = 0;
    let pieceStart = seg.start;
    for (const p of pauses) {
      let best = -1;
      let bestGap = Infinity;
      for (let i = from + 1; i < toks.length; i++) {
        if (!/^\s/.test(toks[i].text)) continue;
        const t = toks[i].start;
        const gap = t < p.start ? p.start - t : t > p.end ? t - p.end : 0;
        if (gap < bestGap) { bestGap = gap; best = i; }
      }
      if (best < 0 || bestGap > reach) continue;
      pieces.push({ start: pieceStart, end: p.start, toks: toks.slice(from, best) });
      from = best;
      pieceStart = p.end;
    }
    pieces.push({ start: pieceStart, end: seg.end, toks: toks.slice(from) });
    if (pieces.length === 1) {
      out.push({ start: seg.start, end: seg.end, text: seg.text });
      continue;
    }
    for (const pc of pieces) {
      const text = clean(pc.toks.map((t) => t.text).join(''));
      if (text && pc.end > pc.start) out.push({ start: pc.start, end: pc.end, text: correct(text) });
    }
  }
  return out;
}

// whisper writes these on near-silence
const HALLUCINATION = /^(?:ขอบคุณที่รับชม|ฝากกดติดตาม|ติดตามช่อง|ซับไตเติ้ลโดย|thanks for watching)/i;

/**
 * Stretches of speech between the pauses: [{ start, end }] in seconds.
 * A pause of at least `minPause` ends a stretch; each stretch takes up to `pad` seconds of the
 * pauses around it (never more than half of one); stretches shorter than `minLen` are noise.
 * A stretch longer than `maxLen` (whisper's window is 30 s) is cut at its longest inner pause,
 * or hard at maxLen when it has none.
 */
function speechChunks(silences, duration, { minPause = 0.35, pad = 0.12, minLen = 0.4, maxLen = 25, innerPause = 0.15 } = {}) {
  const seps = silences
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration, s.end) }))
    .filter((s) => s.end - s.start >= minPause)
    .sort((a, b) => a.start - b.start);
  const runs = [];
  let from = 0;
  let before = 0; // length of the pause before this stretch
  for (const s of seps) {
    if (s.start - from >= minLen) runs.push({ start: from, end: s.start, before, after: s.end - s.start });
    from = s.end;
    before = s.end - s.start;
  }
  if (duration - from >= minLen) runs.push({ start: from, end: duration, before, after: 0 });
  const out = [];
  for (const r of runs) {
    const start = Math.max(0, r.start - Math.min(pad, r.before / 2));
    const end = Math.min(duration, r.end + Math.min(pad, r.after / 2));
    for (const piece of cutLong(start, end, silences, maxLen, innerPause)) out.push(piece);
  }
  return out.map((c) => ({ start: round3(c.start), end: round3(c.end) }));
}

function cutLong(start, end, silences, maxLen, innerPause) {
  const out = [];
  let a = start;
  while (end - a > maxLen) {
    let cut = a + maxLen;
    let best = 0;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      const len = s.end - s.start;
      if (len >= innerPause && mid > a + maxLen * 0.4 && mid < a + maxLen && len > best) { best = len; cut = mid; }
    }
    out.push({ start: a, end: cut });
    a = cut;
  }
  out.push({ start: a, end });
  return out;
}

function tail(s) {
  return String(s || '').trim().split(/\r\n|\r|\n/).pop().slice(0, 200);
}

module.exports = { ClipAnalyzer, AnalyzeError, STAGES, overall, summarize, withSilentTail, splitAtPauses, speechChunks };
