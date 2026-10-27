'use strict';
// The edit list → a HyperFrames project (an HTML page), as pure functions (no I/O):
//   mapCaptions: transcript lines (source time) → lines on the timeline, after cuts and speed.
//   splitLines: one long line → short subtitle lines, cut between Thai words, timed by length.
//   buildProject: clips + captions → the index.html that HyperFrames renders.
// Source files are referenced by relative path (assets/<file>); the runner puts them there.

const { FX, SFX, fxTween, fxOutTween, sfxLead } = require('./effects');
const stickers = require('./stickers');

const sfxSeconds = (id, sfxDur) => (SFX[id] && SFX[id].dur) || sfxDur[id] || 1;

const CAPTION_STYLES = Object.freeze({
  classic: { label: 'ขาวมีเงา', css: 'color:#fff;text-shadow:0 3px 12px rgba(0,0,0,.95),0 0 3px rgba(0,0,0,.9);', pop: false },
  pop: { label: 'เหลืองเด้ง', css: 'color:#ffe14d;-webkit-text-stroke:6px #000;paint-order:stroke fill;text-shadow:0 4px 10px rgba(0,0,0,.6);', pop: true },
  bar: { label: 'พื้นดำโปร่ง', css: 'color:#fff;background:rgba(0,0,0,.62);border-radius:18px;padding:14px 28px;width:fit-content;max-width:88%;margin:0 auto;', pop: false },
});

// IBM Plex Sans Thai Looped Bold (OFL), shipped in lib/video/vendor/fonts
const FONT_FACES = `      @font-face { font-family: "JV Sans"; font-weight: 700; src: url("assets/fonts/thai-700.woff2") format("woff2"); unicode-range: U+02D7,U+0303,U+0331,U+0E01-0E5B,U+200C-200D,U+25CC; }
      @font-face { font-family: "JV Sans"; font-weight: 700; src: url("assets/fonts/latin-700.woff2") format("woff2"); unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
`;
const FONT_FILES = Object.freeze(['thai-700.woff2', 'latin-700.woff2']);

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

const js = (x) => JSON.stringify(String(x));
const thousands = '.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",")';

/** The HTML and GSAP lines of one animation overlay; null when it falls outside the video. */
function overlayParts(o, i, total, shortSide, imageFiles = {}) {
  const start = Math.max(0, o.start);
  const end = Math.min(total, o.end);
  if (end - start < 0.3) return null;
  const id = `ov-${i}`;
  const d = r3(end - start);
  const attrs = `id="${id}" class="clip ov ov-${o.kind}" data-start="${r3(start)}" data-duration="${d}" data-track-index="12"`;
  const out = r3(Math.max(start, end - 0.25));
  const sel = `"#${id}"`;
  if (o.kind === 'emoji') {
    if (!imageFiles[o.image]) return null; // its picture is not in the project: show nothing
    const w = Math.round((shortSide * o.size) / 100);
    const box = `left:${o.x}%;top:${o.y}%;width:${w}px;height:${w}px;margin:${-Math.round(w / 2)}px 0 0 ${-Math.round(w / 2)}px`;
    const s0 = r3(start);
    return {
      html: `      <div id="${id}" class="clip ov-emoji" data-start="${s0}" data-duration="${d}" data-track-index="12" style="${box}"><img src="${esc(imageFiles[o.image])}" alt="" style="width:100%;height:100%;display:block"></div>`,
      lines: [
        `tl.fromTo(${sel}, { scale: 0, rotation: -12 }, { scale: 1, rotation: 0, duration: 0.45, ease: "back.out(2.6)" }, ${s0});`,
        `tl.to(${sel}, { y: -${Math.round(w * 0.08)}, duration: 0.4, ease: "sine.inOut", yoyo: true, repeat: ${Math.max(1, Math.floor((d - 0.7) / 0.4) - 1)} }, ${r3(start + 0.5)});`,
        `tl.to(${sel}, { opacity: 0, duration: 0.25, ease: "power1.in" }, ${out});`,
      ],
    };
  }
  if (stickers.isSticker(o.kind)) {
    const w = Math.round((shortSide * o.size) / 100);
    const box = `left:${o.x}%;top:${o.y}%;width:${w}px;height:${w}px;margin:${-Math.round(w / 2)}px 0 0 ${-Math.round(w / 2)}px`;
    const wrap = `<div id="${id}" class="clip ov-sticker${stickers.KINDS[o.kind].draw ? ' stk-draw' : ''}" data-start="${r3(start)}" data-duration="${d}" data-track-index="12" style="${box}">${stickers.svgFor(o.kind, o.color)}</div>`;
    const fadeOut = `tl.to(${sel}, { opacity: 0, duration: 0.25, ease: "power1.in" }, ${out});`;
    const s0 = r3(start);
    const lines = {
      arrow: [
        `tl.fromTo(${sel}, { opacity: 0, y: -${Math.round(w * 0.7)} }, { opacity: 1, y: 0, duration: 0.45, ease: "bounce.out" }, ${s0});`,
        `tl.to(${sel}, { y: ${Math.round(w * 0.24)}, duration: 0.35, ease: "sine.inOut", yoyo: true, repeat: ${Math.max(1, Math.floor((d - 0.8) / 0.35) - 1)} }, ${r3(start + 0.5)});`,
        fadeOut,
      ],
      circle: [
        `tl.fromTo("#${id} path", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.6, ease: "power2.out" }, ${s0});`,
        fadeOut,
      ],
      underline: [
        `tl.fromTo("#${id} path", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.5, ease: "power2.out" }, ${s0});`,
        fadeOut,
      ],
      heart: [
        `tl.fromTo(${sel}, { scale: 0 }, { scale: 1, duration: 0.4, ease: "back.out(2.4)" }, ${s0});`,
        `tl.to(${sel}, { y: -${Math.round(w * 1.2)}, opacity: 0, duration: ${r3(Math.max(0.4, d - 0.5))}, ease: "power1.in" }, ${r3(start + 0.5)});`,
      ],
      sparkle: [
        `tl.fromTo("#${id} .st", { scale: 0, rotation: -45 }, { scale: 1, rotation: 0, duration: 0.35, ease: "back.out(3)", stagger: 0.12 }, ${s0});`,
        `tl.to("#${id} .st", { scale: 0.6, duration: 0.3, yoyo: true, repeat: 1, stagger: 0.1, ease: "sine.inOut" }, ${r3(start + 0.6)});`,
        fadeOut,
      ],
    }[o.kind];
    return { html: `      ${wrap}`, lines };
  }
  if (o.kind === 'title') {
    return {
      html: `      <div ${attrs}><span>${esc(o.text)}</span></div>`,
      lines: [
        `tl.fromTo(${sel}, { opacity: 0, scale: 0.6, y: 30 }, { opacity: 1, scale: 1, y: 0, duration: 0.45, ease: "back.out(2)" }, ${r3(start)});`,
        `tl.to(${sel}, { opacity: 0, y: -20, duration: 0.25, ease: "power1.in" }, ${out});`,
      ],
    };
  }
  if (o.kind === 'lower') {
    return {
      html: `      <div ${attrs}><div class="ov-name">${esc(o.text)}</div>${o.text2 ? `<div class="ov-role">${esc(o.text2)}</div>` : ''}</div>`,
      lines: [
        `tl.fromTo(${sel}, { opacity: 0, x: -90 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, ${r3(start)});`,
        `tl.to(${sel}, { opacity: 0, x: -50, duration: 0.25, ease: "power1.in" }, ${out});`,
      ],
    };
  }
  if (o.kind === 'counter') {
    const count = r3(Math.min(2, Math.max(0.4, d * 0.6)));
    const fmt = (v) => `(Math.round(${v})).toString()${thousands} + ${js(o.suffix)}`;
    return {
      html: `      <div ${attrs}><div id="${id}-n">${esc(String(o.from).replace(/\B(?=(\d{3})+(?!\d))/g, ','))}${esc(o.suffix)}</div>${o.text ? `<div class="ov-label">${esc(o.text)}</div>` : ''}</div>`,
      lines: [
        `tl.fromTo(${sel}, { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.6)" }, ${r3(start)});`,
        `{ const st${i} = { v: ${o.from} }; tl.to(st${i}, { v: ${o.to}, duration: ${count}, ease: "power2.out", onUpdate: () => { document.getElementById("${id}-n").textContent = ${fmt(`st${i}.v`)}; } }, ${r3(start + 0.15)}); }`,
        `tl.to(${sel}, { opacity: 0, duration: 0.25, ease: "power1.in" }, ${out});`,
      ],
    };
  }
  return null;
}

/**
 * spec: {
 *   clips: [{ id, src, in, out, speed }],
 *   sources: { [id]: { file: 'assets/s1.mp4', kind: 'video'|'audio', audio: bool } },
 *   captions: [{ start, end, text }] already on the timeline and already split into lines,
 *   canvas: { width, height }, captionStyle: 'classic' | 'pop' | 'bar', fit: 'cover' | 'contain',
 *   fonts: true when assets/fonts/{thai,latin}-700.woff2 are in the project (then the page ships its own Thai font),
 *   imageFiles: { 'dl-1a2b3c4d': 'assets/img-dl-1a2b3c4d.png' } the pictures of emoji animations that exist,
 *   sfxDur: { 'dl-1a2b3c4d': 1.7 } the length of library sounds (built-in ones are known),
 *   sfxFiles: { whoosh: 'assets/sfx-whoosh.wav', … } the sound files that exist (a clip whose sound is missing plays none)
 * }
 * Returns { html, duration }.
 */
function buildProject(spec) {
  const { clips, sources, captions = [], overlays = [], canvas, captionStyle = 'classic', fit = 'cover', sfxFiles = {}, sfxDur = {}, imageFiles = {}, fonts = false } = spec;
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
  // how each clip comes in: the picture effect, and a sound a little before the cut
  const fxHtml = [];
  const fxLines = [];
  rows.forEach((r, i) => {
    const c = r.clip;
    const isAudio = sources[c.src].kind === 'audio';
    if (!isAudio && c.fx && c.fx !== 'none' && FX[c.fx]) {
      if (c.fx === 'flash') fxHtml.push(`      <div id="fx-${i}" class="clip fx-flash" data-start="${r3(r.start)}" data-duration="${FX.flash.dur}" data-track-index="8"></div>`);
      fxLines.push(...fxTween(c.fx, { video: `m-${esc(c.id)}`, flash: `fx-${i}`, at: r.start }).map((l) => `      ${l}`));
    }
    if (!isAudio && c.fxOut && c.fxOut !== 'none') fxLines.push(...fxOutTween(c.fxOut, { video: `m-${esc(c.id)}`, end: r.end }).map((l) => `      ${l}`));
    if (c.sfx && c.sfx !== 'none' && sfxFiles[c.sfx]) {
      const start = Math.max(0, r.start - sfxLead(c.sfx));
      fxHtml.push(`      <audio id="sfx-${i}" src="${esc(sfxFiles[c.sfx])}" data-start="${r3(start)}" data-duration="${sfxSeconds(c.sfx, sfxDur)}" data-volume="0.9" data-track-index="5"></audio>`);
    }
  });
  // animations over the picture
  const ovHtml = [];
  const ovLines = [];
  overlays.forEach((o, i) => {
    const part = overlayParts(o, i, duration, Math.min(width, height), imageFiles);
    if (!part) return;
    ovHtml.push(part.html);
    ovLines.push(...part.lines.map((l) => `      ${l}`));
    if (o.sfx && o.sfx !== 'none' && sfxFiles[o.sfx]) {
      ovHtml.push(`      <audio id="ovsfx-${i}" src="${esc(sfxFiles[o.sfx])}" data-start="${r3(Math.max(0, o.start - sfxLead(o.sfx)))}" data-duration="${sfxSeconds(o.sfx, sfxDur)}" data-volume="0.9" data-track-index="6"></audio>`);
    }
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
${fonts ? FONT_FACES : ''}      body { font-family: ${fonts ? '"JV Sans", ' : ''}"Leelawadee UI", "Tahoma", "Noto Sans Thai", sans-serif; }
      .ov { position: absolute; left: 6%; right: 6%; text-align: center; color: #fff; font-weight: ${fonts ? 700 : 800}; text-shadow: 0 3px 14px rgba(0,0,0,.7); }
      .ov-title { top: 13%; font-size: ${Math.round(Math.min(width, height) * 0.085)}px; line-height: 1.25; }
      .ov-title span { display: inline-block; padding: 0.15em 0.6em; background: #ffe14d; color: #111; border-radius: 0.3em; text-shadow: none; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
      .ov-lower { left: 5%; right: auto; max-width: 80%; bottom: 31%; text-align: left; padding: 0.35em 0.9em 0.4em 0.7em; background: rgba(0,0,0,.62); border-left: 0.16em solid #ffe14d; border-radius: 0 0.3em 0.3em 0; font-size: ${Math.round(Math.min(width, height) * 0.055)}px; line-height: 1.3; }
      .ov-lower .ov-role { font-size: 0.68em; font-weight: 400; opacity: .9; }
      .ov-counter { top: 34%; font-size: ${Math.round(Math.min(width, height) * 0.2)}px; line-height: 1.05; }
      .ov-counter .ov-label { font-size: 0.24em; font-weight: 700; letter-spacing: .02em; }
      .ov-sticker, .ov-emoji { position: absolute; }
      .stk-draw path { stroke-dasharray: 1; stroke-dashoffset: 1; }
      .ov-sticker .st { transform-box: fill-box; transform-origin: center; }
      .fx-flash { position: absolute; inset: 0; background: #fff; opacity: 0; }
      .cap { position: absolute; left: 6%; right: 6%; bottom: 17%; text-align: center; font-size: ${fontSize}px; font-weight: ${fonts ? 700 : 800}; line-height: 1.35; ${style.css} }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
${[...media, ...fxHtml, ...ovHtml, ...caps].join('\n')}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
${[...fxLines, ...ovLines, ...tweens].join('\n')}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return { html, duration };
}

module.exports = { FONT_FILES, CAPTION_STYLES, canvasFor, mapCaptions, splitLines, buildProject, layout, words };
