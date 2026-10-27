// Live look of the effects, animations and subtitles in the editor's preview, so the user
// does not have to render to see them. The pure functions (no DOM) work out, for a timeline
// time t, how each piece looks; FxLayer paints that onto a layer over the <video>.
// The numbers follow lib/video/effects.js and lib/video/hf-project.js (what the real render
// plays); easing is a close copy of GSAP's, so the preview is near, not frame-exact.

export const IN_DUR = { fade: 0.4, flash: 0.3, zoom: 0.5, slide: 0.4, blur: 0.45 };
export const OUT_DUR = { fade: 0.4, zoom: 0.5, slide: 0.4, blur: 0.45 };

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const pow = (n) => (p) => 1 - (1 - p) ** n; // "power(n).out"
export const out1 = (p) => p;
export const out2 = pow(2);
export const out3 = pow(3);
export const in2 = (p) => p * p;
/** GSAP back.out(c) */
export const backOut = (c) => (p) => (p - 1) * (p - 1) * ((c + 1) * (p - 1) + c) + 1;

/**
 * How the picture of a clip looks `localT` seconds into it (clip is `len` seconds long on the timeline).
 * { opacity, scale, x (% of width), blur (design px at 1080 wide), flash (0..1 white layer) }
 */
export function clipFxState(clip, localT, len) {
  const s = { opacity: 1, scale: 1, x: 0, blur: 0, flash: 0 };
  const fx = clip.fx;
  if (fx && fx !== 'none' && IN_DUR[fx]) {
    const p = clamp01(localT / IN_DUR[fx]);
    if (fx === 'fade') s.opacity *= out1(p);
    else if (fx === 'zoom') s.scale *= 1.2 - 0.2 * out3(p);
    else if (fx === 'slide') { s.x += 14 * (1 - out2(p)); s.opacity *= out2(p); }
    else if (fx === 'blur') s.blur = Math.max(s.blur, 26 * (1 - out2(p)));
    else if (fx === 'flash') s.flash = localT < IN_DUR.flash ? 0.95 * (1 - out2(p)) : 0;
  }
  const fo = clip.fxOut;
  if (fo && fo !== 'none' && OUT_DUR[fo]) {
    const p = clamp01(1 - (len - localT) / OUT_DUR[fo]);
    if (fo === 'fade') s.opacity *= 1 - p;
    else if (fo === 'zoom') s.scale *= 1 + 0.15 * in2(p);
    else if (fo === 'slide') { s.x -= 14 * in2(p); s.opacity *= 1 - in2(p); }
    else if (fo === 'blur') s.blur = Math.max(s.blur, 26 * in2(p));
  }
  return s;
}

/** GSAP bounce.out */
export function bounceOut(p) {
  const n = 7.5625;
  const d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
}
const sineInOut = (p) => -(Math.cos(Math.PI * p) - 1) / 2;

/** Sticker kinds drawn by the app (see lib/video/stickers.js): which of them draw a line. */
export const STICKER_DRAW = { circle: 0.6, underline: 0.5 };
export const STICKER_KINDS = ['arrow', 'circle', 'underline', 'heart', 'sparkle'];

/**
 * How a moving sticker looks at timeline time t; null when it is not on screen.
 * { opacity, scale, y (design px), draw (0..1 for line stickers), stars: [{ scale, rot }] }
 */
export function stickerState(o, t) {
  if (t < o.start || t > o.end) return null;
  const d = o.end - o.start;
  const w = (1080 * o.size) / 100; // the sticker's box in design px
  const local = t - o.start;
  const fade = 1 - clamp01((t - (o.end - 0.25)) / 0.25);
  const st = { opacity: fade, scale: 1, y: 0, draw: null, stars: null };
  if (o.kind === 'arrow') {
    st.y = -0.7 * w * (1 - bounceOut(clamp01(local / 0.45)));
    if (local > 0.5) {
      const reps = Math.max(1, Math.floor((d - 0.8) / 0.35) - 1);
      const k = (local - 0.5) / 0.35;
      const total = reps + 1;
      const u = k >= total ? (total % 2 === 1 ? 1 : 0) : (k % 2 <= 1 ? k % 2 : 2 - (k % 2));
      st.y = 0.24 * w * sineInOut(u);
    }
  } else if (STICKER_DRAW[o.kind]) {
    st.draw = out2(clamp01(local / STICKER_DRAW[o.kind]));
  } else if (o.kind === 'heart') {
    st.scale = backOut(2.4)(clamp01(local / 0.4));
    const q = clamp01((local - 0.5) / Math.max(0.4, d - 0.5));
    st.y = -1.2 * w * in2(q);
    st.opacity = 1 - in2(q);
  } else if (o.kind === 'sparkle') {
    st.stars = [0, 1, 2].map((i) => {
      const p = clamp01((local - 0.12 * i) / 0.35);
      let scale = backOut(3)(p);
      const z = (local - (0.6 + 0.1 * i)) / 0.3;
      if (z > 0) scale *= 1 - 0.4 * (z <= 1 ? z : z <= 2 ? 2 - z : 0);
      return { scale, rot: -45 * (1 - p) };
    });
  }
  return st;
}

/**
 * How an emoji picture looks at timeline time t; null when it is not on screen.
 * { opacity, scale, rot (deg), y (design px) } — pops in, bobs, fades out, like the render.
 */
export function emojiState(o, t) {
  if (t < o.start || t > o.end) return null;
  const d = o.end - o.start;
  const w = (1080 * o.size) / 100;
  const local = t - o.start;
  const p = clamp01(local / 0.45);
  const st = { opacity: 1 - clamp01((t - (o.end - 0.25)) / 0.25), scale: backOut(2.6)(p), rot: -12 * (1 - p), y: 0 };
  if (local > 0.5) {
    const reps = Math.max(1, Math.floor((d - 0.7) / 0.4) - 1);
    const k = (local - 0.5) / 0.4;
    const total = reps + 1;
    const u = k >= total ? (total % 2 === 1 ? 1 : 0) : (k % 2 <= 1 ? k % 2 : 2 - (k % 2));
    st.y = -0.08 * w * sineInOut(u);
  }
  return st;
}

const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * How an animation overlay looks at timeline time t; null when it is not on screen.
 * { opacity, scale, x, y (design px at 1080 wide), text (counter number) }
 */
export function overlayState(o, t) {
  if (t < o.start || t > o.end) return null;
  const d = o.end - o.start;
  const local = t - o.start;
  const outP = clamp01((t - (o.end - 0.25)) / 0.25);
  const st = { opacity: 1, scale: 1, x: 0, y: 0, text: '' };
  if (o.kind === 'title') {
    const p = clamp01(local / 0.45);
    const b = backOut(2)(p);
    st.opacity = clamp01(b) * (1 - out1(outP));
    st.scale = 0.6 + 0.4 * b;
    st.y = 30 * (1 - b) - 20 * in2(outP);
  } else if (o.kind === 'lower') {
    const p = out3(clamp01(local / 0.5));
    st.opacity = p * (1 - out1(outP));
    st.x = -90 * (1 - p) - 50 * in2(outP);
  } else if (o.kind === 'counter') {
    const b = backOut(1.6)(clamp01(local / 0.35));
    st.opacity = clamp01(b) * (1 - out1(outP));
    st.scale = 0.8 + 0.2 * b;
    const count = Math.min(2, Math.max(0.4, d * 0.6));
    const q = out2(clamp01((local - 0.15) / count));
    st.text = thousands(o.from + (o.to - o.from) * q) + (o.suffix || '');
  }
  return st;
}

/** The subtitle line to show at time t (or null). */
export function captionAt(captions, t) {
  return (captions || []).find((c) => t >= c.start && t < c.end) || null;
}

/** Caption pop-in: 0..1 over the first 0.2 s. */
export function captionPop(c, t) {
  return clamp01((t - c.start) / 0.2);
}

/** A length in design pixels (the page is laid out for 1080 on the short side) scaled to the preview. */
const u = (n) => `calc(var(--u) * ${n.toFixed(1)}px)`;

/**
 * When each sound starts on the timeline: [{ at, id, url }] sorted by time.
 * rows: layout(clips) · overlays · sounds: { id → { url, lead } } (lead = seconds the sound
 * starts before its cut, so its hit lands on the cut).
 */
export function buildCues(rows, overlays, sounds) {
  const out = [];
  const add = (id, start) => {
    const s = id && id !== 'none' ? sounds[id] : null;
    if (s && s.url) out.push({ at: Math.max(0, start - (s.lead || 0)), id, url: s.url });
  };
  for (const r of rows) add(r.clip.sfx, r.start);
  for (const o of overlays || []) add(o.sfx, o.start);
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The cues the playhead passed going from `from` to `to` (seconds). A jump of more than half a
 * second is a seek, not playing, and plays nothing.
 */
export function cuesBetween(cues, from, to) {
  if (!(to > from) || to - from > 0.5) return [];
  return cues.filter((c) => c.at > from && c.at <= to);
}

const OV_CLASS = { title: 'ov-title', lower: 'ov-lower', counter: 'ov-counter' };

/** A layer over the preview <video> that shows subtitles, overlays and the white flash. */
export class FxLayer {
  constructor(layer, video) {
    this.layer = layer;
    this.video = video;
    this.key = '';
    this.items = [];
    this.flash = null;
    this.cap = null;
  }

  /** Rebuilds the elements when the overlays or the caption style change. */
  build(overlays, captionStyle, stickers = {}, images = {}) {
    const key = JSON.stringify([overlays, captionStyle, Object.keys(stickers), Object.keys(images)]);
    if (key === this.key) return;
    this.key = key;
    this.layer.replaceChildren();
    this.flash = document.createElement('div');
    this.flash.className = 've-fx-flash';
    this.layer.append(this.flash);
    this.items = overlays.map((o) => {
      const node = document.createElement('div');
      node.className = `ve-ov-item ${OV_CLASS[o.kind] || ''}`;
      let num = null;
      let svg = null;
      let pic = null;
      if (o.kind === 'emoji') {
        if (images[o.image]) {
          pic = document.createElement('img');
          pic.src = images[o.image];
          pic.alt = '';
          node.append(pic);
          node.className = 've-ov-item ov-sticker';
          const w = (1080 * o.size) / 100;
          node.style.left = `${o.x}%`;
          node.style.top = `${o.y}%`;
          node.style.width = u(w);
          node.style.height = u(w);
          node.style.margin = `${u(-w / 2)} 0 0 ${u(-w / 2)}`;
        }
      } else if (STICKER_KINDS.includes(o.kind)) {
        const spec = stickers[o.kind];
        if (spec) {
          // the stored markup uses the sticker's own colour; swap in the chosen one
          const text = o.color && o.color !== spec.color ? spec.svg.split(spec.color).join(o.color) : spec.svg;
          const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
          svg = document.importNode(doc.documentElement, true);
          node.append(svg);
          node.className = 've-ov-item ov-sticker';
          const w = (1080 * o.size) / 100;
          node.style.left = `${o.x}%`;
          node.style.top = `${o.y}%`;
          node.style.width = u(w);
          node.style.height = u(w);
          node.style.margin = `${u(-w / 2)} 0 0 ${u(-w / 2)}`;
          if (STICKER_DRAW[o.kind]) for (const p of svg.querySelectorAll('path')) p.style.strokeDasharray = '1';
          for (const s of svg.querySelectorAll('.st')) { s.style.transformBox = 'fill-box'; s.style.transformOrigin = 'center'; }
        }
      } else if (o.kind === 'title') {
        const span = document.createElement('span');
        span.textContent = o.text;
        node.append(span);
      } else if (o.kind === 'lower') {
        const name = document.createElement('div');
        name.textContent = o.text;
        node.append(name);
        if (o.text2) {
          const role = document.createElement('div');
          role.className = 'ov-role';
          role.textContent = o.text2;
          node.append(role);
        }
      } else if (o.kind === 'counter') {
        num = document.createElement('div');
        node.append(num);
        if (o.text) {
          const label = document.createElement('div');
          label.className = 'ov-label';
          label.textContent = o.text;
          node.append(label);
        }
      }
      node.hidden = true;
      this.layer.append(node);
      return { o, node, num, svg, pic };
    });
    this.cap = document.createElement('div');
    this.cap.className = `ve-fx-cap cap-${captionStyle}`;
    this.cap.hidden = true;
    this.layer.append(this.cap);
  }

  /** Sets --u: how many screen pixels one design pixel is (the short side of the preview / 1080). */
  measure() {
    const box = this.layer.parentElement;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (w && h) box.style.setProperty('--u', (Math.min(w, h) / 1080).toFixed(5));
  }

  /** Paints time t. clips: the timeline clips; rows: layout(clips); captions: timeline lines. */
  paint(t, { rows, captions }) {
    // picture effect of the clip under the playhead
    const row = rows.find((r) => t < r.end - 1e-6) || rows[rows.length - 1];
    const v = this.video.style;
    if (row) {
      const s = clipFxState(row.clip, t - row.start, row.end - row.start);
      v.opacity = String(s.opacity);
      v.transform = s.scale !== 1 || s.x ? `translateX(${s.x.toFixed(2)}%) scale(${s.scale.toFixed(4)})` : '';
      v.filter = s.blur > 0.05 ? `blur(${u(s.blur)})` : '';
      this.flash.style.opacity = String(s.flash);
    } else {
      v.opacity = '';
      v.transform = '';
      v.filter = '';
      this.flash.style.opacity = '0';
    }
    for (const it of this.items) {
      if (it.pic) {
        const k = emojiState(it.o, t);
        it.node.hidden = !k;
        if (!k) continue;
        it.node.style.opacity = String(k.opacity);
        it.node.style.transform = `translateY(${u(k.y)}) scale(${k.scale.toFixed(4)}) rotate(${k.rot.toFixed(1)}deg)`;
        continue;
      }
      if (it.svg) {
        const k = stickerState(it.o, t);
        it.node.hidden = !k;
        if (!k) continue;
        it.node.style.opacity = String(k.opacity);
        it.node.style.transform = `translateY(${u(k.y)}) scale(${k.scale.toFixed(4)})`;
        if (k.draw !== null) for (const p of it.svg.querySelectorAll('path')) p.style.strokeDashoffset = String((1 - k.draw).toFixed(4));
        if (k.stars) it.svg.querySelectorAll('.st').forEach((el, i) => { el.style.transform = `scale(${k.stars[i].scale.toFixed(4)}) rotate(${k.stars[i].rot.toFixed(1)}deg)`; });
        continue;
      }
      const s = overlayState(it.o, t);
      it.node.hidden = !s;
      if (!s) continue;
      it.node.style.opacity = String(s.opacity);
      it.node.style.transform = `translate(${u(s.x)}, ${u(s.y)}) scale(${s.scale.toFixed(4)})`;
      if (it.num) it.num.textContent = s.text;
    }
    const c = captionAt(captions, t);
    this.cap.hidden = !c;
    if (c) {
      if (this.cap.textContent !== c.text) this.cap.textContent = c.text;
      const p = captionPop(c, t);
      this.cap.style.opacity = String(p);
      this.cap.style.transform = `translateY(${u((1 - p) * 24)})`;
    }
  }

  /** Back to a plain picture (nothing to preview). */
  clear() {
    this.key = '';
    this.layer.replaceChildren();
    this.items = [];
    const v = this.video.style;
    v.opacity = '';
    v.transform = '';
    v.filter = '';
  }
}
