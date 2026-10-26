'use strict';
// Builds ffmpeg argument arrays. Never a shell string: callers spawn with shell:false.
// Assumes every source has an audio track (the export graph maps audio for each clip).

const path = require('path');

const SIZES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] };

function num(x) {
  if (!Number.isFinite(x)) throw new Error('ค่าตัวเลขไม่ถูกต้อง');
  return x.toFixed(3);
}

function checkPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('ต้องระบุที่อยู่เต็มของไฟล์');
  return p;
}

/** atempo only accepts 0.5..2 per stage, so larger changes are chained. */
function atempoChain(speed) {
  const stages = [];
  let s = speed;
  while (s > 2) { stages.push(2); s /= 2; }
  while (s < 0.5) { stages.push(0.5); s /= 0.5; }
  stages.push(s);
  return stages.map((x) => `atempo=${num(x)}`).join(',');
}

// Stats stay on (no -nostats): their "time=" lines drive the progress bar, see parseFfmpegTime.
function buildSilenceDetectArgs(input, { noiseDb = -30, minSilenceSec = 0.25 } = {}) {
  return ['-hide_banner', '-i', checkPath(input), '-vn', '-af',
    `silencedetect=noise=${num(noiseDb)}dB:d=${num(minSilenceSec)}`, '-f', 'null', '-'];
}

/** The speech track as 16 kHz mono 16-bit WAV: what whisper reads, and quick to scan for silences. */
function buildExtractAudioArgs(input, output) {
  if (typeof output !== 'string' || !path.isAbsolute(output) || path.extname(output).toLowerCase() !== '.wav') {
    throw new Error('ไฟล์เสียงปลายทางต้องเป็น .wav และระบุที่อยู่เต็ม');
  }
  return ['-hide_banner', '-y', '-i', checkPath(input), '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output];
}

/** Seconds of media processed so far, from the last "time=HH:MM:SS.xx" in a stderr chunk; null if none. */
function parseFfmpegTime(chunk) {
  let last = null;
  for (const m of String(chunk).matchAll(/time=\s*(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)) {
    last = m[1] ? 0 : Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  }
  return last;
}

/** Reads silence_start / silence_end lines from ffmpeg stderr. A silence open at the end runs to `duration`. */
function parseSilence(stderr, duration) {
  const out = [];
  let open = null;
  for (const line of String(stderr).split(/\r\n|\r|\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { open = Math.max(0, parseFloat(s[1])); continue; }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && open !== null) { out.push({ start: open, end: parseFloat(e[1]) }); open = null; }
  }
  if (open !== null && Number.isFinite(duration)) out.push({ start: open, end: duration });
  return out;
}

/** Full export: trim each clip, change speed, fit to the aspect ratio, join them. */
function buildExportArgs({ list, output, aspect = '9:16', fps = 30 }) {
  if (!list.clips.length) throw new Error('ยังไม่มีคลิปให้ส่งออก');
  const size = SIZES[aspect];
  if (!size) throw new Error('สัดส่วนจอไม่รองรับ');
  if (typeof output !== 'string' || !path.isAbsolute(output) || path.extname(output).toLowerCase() !== '.mp4') {
    throw new Error('ไฟล์ปลายทางต้องเป็น .mp4 และระบุที่อยู่เต็ม');
  }
  const [w, h] = size;
  const args = ['-hide_banner', '-y'];
  const index = new Map();
  list.sources.forEach((s, i) => { args.push('-i', checkPath(s.path)); index.set(s.id, i); });
  const parts = [];
  list.clips.forEach((c, k) => {
    const i = index.get(c.src);
    if (i === undefined) throw new Error('คลิปอ้างไฟล์ที่ไม่มี');
    const range = `start=${num(c.in)}:end=${num(c.out)}`;
    parts.push(`[${i}:v]trim=${range},setpts=(PTS-STARTPTS)/${num(c.speed)},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${Math.round(fps)}[v${k}]`);
    parts.push(`[${i}:a]atrim=${range},asetpts=PTS-STARTPTS,${atempoChain(c.speed)},aresample=48000[a${k}]`);
  });
  const joined = list.clips.map((_, k) => `[v${k}][a${k}]`).join('');
  parts.push(`${joined}concat=n=${list.clips.length}:v=1:a=1[v][a]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output);
  return args;
}

module.exports = { SIZES, atempoChain, buildSilenceDetectArgs, buildExtractAudioArgs, parseFfmpegTime, parseSilence, buildExportArgs };
