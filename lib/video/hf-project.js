'use strict';
// The edit list → a HyperFrames project (an HTML page), as pure functions (no I/O):
//   mapCaptions: transcript lines (source time) → lines on the timeline, after cuts and speed.
//   splitLines: one long line → short subtitle lines, cut between Thai words, timed by length.
//   buildProject: clips + captions → the index.html that HyperFrames renders.
// Source files are referenced by relative path (assets/<file>); the runner puts them there.

const CAPTION_STYLES = Object.freeze({
  classic: { label: 'ขาวมีเงา', css: 'color:#fff;text-shadow:0 3px 12px rgba(0,0,0,.95),0 0 3px rgba(0,0,0,.9);', pop: false },
  pop: { label: 'เหลืองเด้ง', css: 'color:#ffe14d;-webkit-text-stroke:6px #000;paint-order:stroke fill;text-shadow:0 4px 10px rgba(0,0,0,.6);', pop: true },
  bar: { label: 'พื้นดำโปร่ง', css: 'color:#fff;background:rgba(0,0,0,.62);border-radius:18px;padding:14px 28px;width:fit-content;max-width:88%;margin:0 auto;', pop: false },
});

const MIN_COVER = 0.5; // a cut line stays only when at least this share of it is still on the timeline
const r3 = (x) => Math.round(x * 1000) / 1000;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(clips) {
  let t = 0;
  return clips.map((clip) => {
    const len = (clip.out - clip.in) / clip.speed;
    const row = { clip, start: t, end: t + len };
    t += len;
    return row;
  });
}

/** Canvas that fits the first picture: tall → 1080×1920, wide → 1920×1080, square → 1080×1080. */
function canvasFor(sources) {
  const v = sources.find((s) => s.video && s.video.width && s.video.height);
  if (!v) return { width: 1080, height: 1920 };
  const { width: w, height: h } = v.video;
  if (h > w * 1.05) return { width: 1080, height: 1920 };
  if (w > h * 1.05) return { width: 1920, height: 1080 };
  return { width: 1080, height: 1080 };
}

/**
 * segmentsBySource: { sourceId: [{ start, end, text }] } in source seconds.
 * Returns [{ start, end, text }] on the timeline, sorted. A line cut by an edit is clamped to
 * the clip; one with less than half of it left is dropped (its words would be half missing).
 */
function mapCaptions(clips, segmentsBySource) {
  const out = [];
  for (const r of layout(clips)) {
    for (const g of segmentsBySource[r.clip.src] || []) {
      const a = Math.max(g.start, r.clip.in);
      const b = Math.min(g.end, r.clip.out);
      if (b - a <= 1e-6 || (b - a) / Math.max(1e-6, g.end - g.start) < MIN_COVER) continue;
      out.push({ start: r.start + (a - r.clip.in) / r.clip.speed, end: r.start + (b - r.clip.in) / r.clip.speed, text: g.text });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

const visible = (s) => s.replace(/\s+/g, '').length;

/** Words of a line, Thai-aware ("สวัสดีครับ" → สวัสดี | ครับ); spaces stay attached to the word before. */
function words(text) {
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
  const parts = seg ? [...seg.segment(text)].map((s) => s.segment) : text.split(/(\s+)/);
  const out = [];
  for (const p of parts) {
    if (/^\s+$/.test(p) && out.length) out[out.length - 1] += p;
    else if (p) out.push(p);
  }
  return out;
}

/**
 * One caption → lines of at most `maxChars` letters, cut between words; each line gets
 * time in proportion to its letters. Short lines come back unchanged.
 */
function splitLines(cap, maxChars = 22) {
  const text = String(cap.text).replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (visible(text) <= maxChars) return [{ start: r3(cap.start), end: r3(cap.end), text }];
  const lines = [];
  let cur = '';
  for (const w of words(text)) {
    if (cur && visible(cur + w) > maxChars) {
      lines.push(cur.trim());
      cur = '';
    }
    cur += w;
  }
  if (cur.trim()) lines.push(cur.trim());
  // never leave a stray one-word tail: fold a very short last line into the one before it
  if (lines.length > 1 && visible(lines[lines.length - 1]) < 4) lines.splice(lines.length - 2, 2, `${lines[lines.length - 2]} ${lines[lines.length - 1]}`);
  const total = lines.reduce((n, l) => n + visible(l), 0) || 1;
  let t = cap.start;
  return lines.map((l) => {
    const len = (cap.end - cap.start) * (visible(l) / total);
    const line = { start: r3(t), end: r3(t + len), text: l };
    t += len;
    return line;
  });
}

/**
 * spec: {
 *   clips: [{ id, src, in, out, speed }],
 *   sources: { [id]: { file: 'assets/s1.mp4', kind: 'video'|'audio', audio: bool } },
 *   captions: [{ start, end, text }] already on the timeline and already split into lines,
 *   canvas: { width, height }, captionStyle: 'classic' | 'pop' | 'bar', fit: 'cover' | 'contain'
 * }
 * Returns { html, duration }.
 */
function buildProject(spec) {
  const { clips, sources, captions = [], canvas, captionStyle = 'classic', fit = 'cover' } = spec;
  const style = CAPTION_STYLES[captionStyle] || CAPTION_STYLES.classic;
  const rows = layout(clips);
  const duration = r3(rows.length ? rows[rows.length - 1].end : 0);
  const { width, height } = canvas;
  const media = rows.map((r) => {
    const src = sources[r.clip.src];
    const common = `id="m-${esc(r.clip.id)}" class="clip" src="${esc(src.file)}" data-start="${r3(r.start)}" data-duration="${r3(r.end - r.start)}" data-media-start="${r3(r.clip.in)}" data-track-index="0"`;
    const rate = r.clip.speed !== 1 ? ` data-playback-rate="${r3(r.clip.speed)}"` : '';
    if (src.kind === 'audio') return `      <audio ${common}${rate} data-volume="1"></audio>`;
    const sound = src.audio ? ' data-has-audio="true"' : ' muted';
    return `      <video ${common}${rate}${sound} playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:${fit === 'contain' ? 'contain' : 'cover'}"></video>`;
  });
  const fontSize = Math.round(Math.min(width, height) * 0.066);
  const caps = captions.map((c, i) => `      <div id="cap-${i}" class="clip cap" data-start="${r3(c.start)}" data-duration="${r3(Math.max(0.05, c.end - c.start))}" data-track-index="10">${esc(c.text)}</div>`);
  const tweens = captions.map((c, i) => {
    const out = r3(Math.max(0, c.end - c.start - 0.12));
    const into = style.pop
      ? `tl.fromTo("#cap-${i}", { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.22, ease: "back.out(2.2)" }, ${r3(c.start)});`
      : `tl.fromTo("#cap-${i}", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" }, ${r3(c.start)});`;
    return `      ${into}\n      tl.to("#cap-${i}", { opacity: 0, duration: 0.1 }, ${r3(c.start + out)});`;
  });
  const html = `<!doctype html>
<html lang="th">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="assets/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
      body { font-family: "Leelawadee UI", "Tahoma", "Noto Sans Thai", sans-serif; }
      .cap { position: absolute; left: 6%; right: 6%; bottom: 17%; text-align: center; font-size: ${fontSize}px; font-weight: 800; line-height: 1.35; ${style.css} }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
${[...media, ...caps].join('\n')}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
${tweens.join('\n')}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return { html, duration };
}

module.exports = { CAPTION_STYLES, canvasFor, mapCaptions, splitLines, buildProject, layout, words };
