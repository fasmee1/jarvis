// Pure timeline math for the video editor (no DOM): where each clip sits on the
// timeline, which source moment a timeline time shows, and how source-time ranges
// (silences, speech) land on the timeline after cuts and speed changes.
// A clip plays src[in..out] at `speed`; clips play back to back.

const EPS = 1e-6;

/** [{ clip, index, start, end }] in timeline seconds. */
export function layout(clips) {
  let t = 0;
  return clips.map((clip, index) => {
    const len = (clip.out - clip.in) / clip.speed;
    const row = { clip, index, start: t, end: t + len };
    t += len;
    return row;
  });
}

export function totalLength(clips) {
  return clips.reduce((n, c) => n + (c.out - c.in) / c.speed, 0);
}

/**
 * Which clip plays at timeline time t, and at what source time.
 * At an exact boundary the later clip wins; past the end, the last frame of the last clip.
 */
export function locate(clips, t) {
  const rows = layout(clips);
  if (!rows.length) return null;
  const time = Math.max(0, t);
  for (const r of rows) {
    if (time < r.end - EPS) return { index: r.index, clip: r.clip, start: r.start, sourceTime: r.clip.in + (time - r.start) * r.clip.speed };
  }
  const last = rows[rows.length - 1];
  return { index: last.index, clip: last.clip, start: last.start, sourceTime: last.clip.out, atEnd: true };
}

/** Timeline time of a source moment inside clip `index`. */
export function timelineTime(clips, index, sourceTime) {
  const rows = layout(clips);
  const r = rows[index];
  if (!r) return 0;
  const s = Math.max(r.clip.in, Math.min(r.clip.out, sourceTime));
  return r.start + (s - r.clip.in) / r.clip.speed;
}

/**
 * Source-time ranges of one source → timeline ranges, through every clip that uses it.
 * Extra fields on each range (e.g. text) are kept. Pieces cut away disappear.
 */
export function mapRanges(clips, srcId, ranges) {
  const out = [];
  for (const r of layout(clips)) {
    if (r.clip.src !== srcId) continue;
    for (const g of ranges) {
      const a = Math.max(g.start, r.clip.in);
      const b = Math.min(g.end, r.clip.out);
      if (b - a <= EPS) continue;
      out.push({ ...g, start: r.start + (a - r.clip.in) / r.clip.speed, end: r.start + (b - r.clip.in) / r.clip.speed });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/** 83.25 → "1:23.2" · 3725 → "1:02:05.0" */
export function fmtTime(sec) {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const tenths = Math.floor(s * 10 + EPS) % 10;
  const whole = Math.floor(s + EPS);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const ss = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}.${tenths}` : `${m}:${ss}.${tenths}`;
}

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Ruler ticks: a step that keeps labels at least minGapPx apart. [{ t, major }] */
export function ticks(duration, pxPerSec, minGapPx = 70) {
  if (!(duration > 0) || !(pxPerSec > 0)) return { step: 1, list: [] };
  const step = STEPS.find((s) => s * pxPerSec >= minGapPx) || STEPS[STEPS.length - 1];
  const list = [];
  const n = Math.min(5000, Math.floor(duration / step + EPS));
  for (let i = 0; i <= n; i++) list.push({ t: Math.round(i * step * 1000) / 1000, major: true });
  return { step, list };
}

/** Zoom that fits the whole timeline in `widthPx`, clamped to a sane range. */
export function fitZoom(duration, widthPx, { min = 2, max = 400 } = {}) {
  if (!(duration > 0) || !(widthPx > 0)) return 40;
  return Math.max(min, Math.min(max, widthPx / duration));
}

/** One frame at the clip's frame rate (30 fps when unknown). */
export function frameStep(fps) {
  return 1 / (fps > 0 && fps < 1000 ? fps : 30);
}
