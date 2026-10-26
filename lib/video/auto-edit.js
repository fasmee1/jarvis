'use strict';
// First-pass edit: keep the speech, cut the pauses, shape the result with a style preset.
// Input is plain data (source duration + silences), so it runs and tests without ffmpeg.

const { emptyList, addClip, clipLength } = require('./edit-list');

/** Turns silences into the stretches to keep (speech plus padding), merged and cleaned. */
function keepRanges(duration, silences, preset) {
  const minSil = preset.silenceMs / 1000;
  const pad = preset.padMs / 1000;
  const cuts = silences
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration, Number.isFinite(s.end) ? s.end : duration) }))
    .filter((s) => s.end - s.start >= minSil)
    .sort((a, b) => a.start - b.start);
  const speech = [];
  let at = 0;
  for (const s of cuts) {
    if (s.start > at) speech.push({ start: at, end: s.start });
    at = Math.max(at, s.end);
  }
  if (at < duration) speech.push({ start: at, end: duration });
  const out = [];
  for (const r of speech) {
    const a = Math.max(0, r.start - pad);
    const b = Math.min(duration, r.end + pad);
    const last = out[out.length - 1];
    if (last && a <= last.end) last.end = Math.max(last.end, b);
    else out.push({ start: a, end: b });
  }
  return out.filter((r) => r.end - r.start >= preset.minKeepMs / 1000);
}

/**
 * source: { id, path?, duration }. silences: [{ start, end }] in source seconds.
 * Returns { list, report } where list is a normal edit list the user can change further.
 */
function autoEdit({ source, silences = [], preset }) {
  if (!source || !Number.isFinite(source.duration) || source.duration <= 0) throw new Error('ไม่ทราบความยาวคลิป');
  const ranges = keepRanges(source.duration, silences, preset);
  let list = emptyList([source]);
  let used = 0;
  let truncated = false;
  for (const r of ranges) {
    let out = r.end;
    const room = preset.targetSec - used;
    if (room <= 0) { truncated = true; break; }
    if ((out - r.start) / preset.speed > room) {
      out = r.start + room * preset.speed; // last piece is shortened to fit the target
      truncated = true;
      if ((out - r.start) < preset.minKeepMs / 1000) break;
    }
    list = addClip(list, { src: source.id, in: r.start, out, speed: preset.speed });
    used += clipLength(list.clips[list.clips.length - 1]);
    if (truncated) break;
  }
  const kept = list.clips.reduce((n, c) => n + (c.out - c.in), 0);
  return { list, report: { presetId: preset.id, resultSec: used, keptSourceSec: kept, cutSourceSec: source.duration - kept, truncated } };
}

module.exports = { autoEdit, keepRanges };
