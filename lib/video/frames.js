'use strict';
// Still pictures from a video, so Claude can SEE the clip it edits (pure helpers + one runner):
//   frameArgs(input, at, out, width)      ffmpeg arguments for one small JPEG
//   spreadTimes(total, n)                 n times spread over 0..total, away from the very edges
//   timelineToSource(list, sources, t)    a time on the timeline → { src, at } in a source file
//   extractFrames(ffmpeg, jobs, opts)     runs ffmpeg for each job → [{ label, mediaType, data }]
//   imageContent(frames, intro, outro)    the message content Claude takes: text, then each picture with its label
// Pictures are small (width 360) and few (≤ 16), they go to the user's own Claude run and are deleted after.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_FRAMES = 16;
const WIDTH = 360;
const r2 = (x) => Math.round(x * 100) / 100;

function frameArgs(input, at, out, width = WIDTH) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('ที่อยู่ไฟล์ไม่ถูกต้อง');
  if (!Number.isFinite(at) || at < 0) throw new Error('เวลาของภาพไม่ถูกต้อง');
  return ['-hide_banner', '-y', '-ss', String(r2(at)), '-i', input, '-frames:v', '1', '-an', '-vf', `scale=${Math.round(width)}:-2`, '-q:v', '5', out];
}

/** n times in the middle of equal slices of 0..total (so none sits on a cut or the very first frame). */
function spreadTimes(total, n) {
  const k = Math.max(1, Math.min(MAX_FRAMES, Math.floor(n)));
  if (!(total > 0)) return [];
  return Array.from({ length: k }, (_, i) => r2(total * (i + 0.5) / k));
}

/** The clip that plays at timeline second t, as { src, at } (seconds in the source file); null when none. */
function timelineToSource(clips, t) {
  let start = 0;
  for (const c of clips) {
    const len = (c.out - c.in) / c.speed;
    if (t >= start && t < start + len + 1e-9) return { src: c.src, at: Math.min(c.out - 0.05, c.in + (t - start) * c.speed) };
    start += len;
  }
  return null;
}

/**
 * jobs: [{ label, path, at }] · ffmpeg: Ffmpeg (require/run) · opts.signal
 * A picture that cannot be made is skipped (Claude just sees fewer).
 */
async function extractFrames(ffmpeg, jobs, { signal, width = WIDTH } = {}) {
  const todo = jobs.slice(0, MAX_FRAMES);
  if (!todo.length) return [];
  const { ffmpeg: exe } = await ffmpeg.require();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-frames-'));
  const out = [];
  try {
    for (const j of todo) {
      if (signal && signal.aborted) break;
      const file = path.join(dir, `${crypto.randomBytes(4).toString('hex')}.jpg`);
      try {
        const r = await ffmpeg.run(exe, frameArgs(j.path, j.at, file, width), { signal });
        if (r.code === 0 && fs.existsSync(file)) out.push({ label: j.label, mediaType: 'image/jpeg', data: fs.readFileSync(file).toString('base64') });
      } catch (err) {
        if (signal && signal.aborted) break;
      }
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return out;
}

/** Message content for Claude: the intro, each picture after its label, then the rest of the request. */
function imageContent(frames, intro, outro) {
  const content = [{ type: 'text', text: intro }];
  for (const f of frames) {
    content.push({ type: 'text', text: f.label });
    content.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.data } });
  }
  content.push({ type: 'text', text: outro });
  return content;
}

module.exports = { frameArgs, spreadTimes, timelineToSource, extractFrames, imageContent, MAX_FRAMES, WIDTH };
