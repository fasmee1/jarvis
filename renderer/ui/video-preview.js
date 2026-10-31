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

// ---- HyperFrames graphics (overlay kind 'hf', see lib/video/hf-graphics.js) ----

/** The canvas the render uses for these sources (same rule as hf-project canvasFor). */
export function canvasFor(sources) {
  const v = sources.find((s) => s.video && s.video.width && s.video.height);
  if (!v) return { width: 1080, height: 1920 };
  const { width: w, height: h } = v.video;
  if (h > w * 1.05) return { width: 1080, height: 1920 };
  if (w > h * 1.05) return { width: 1920, height: 1080 };
  return { width: 1080, height: 1080 };
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** {{var}} → the variable's text (escaped), like the render. */
export function fillMarkup(markup, vars) {
  const text = Object.fromEntries((vars || []).filter((v) => v.type === 'text').map((v) => [v.id, v.value]));
  return String(markup).replace(/\{\{\s*([a-z][a-z0-9_]{0,19})\s*\}\}/g, (_, id) => escHtml(text[id] || ''));
}

const EASE_POW = { power0: 1, linear: 1, none: 1, power1: 2, quad: 2, power2: 3, cubic: 3, power3: 4, quart: 4, power4: 5, quint: 5, strong: 5 };

/** A GSAP ease name ("power3.out", "back.out(1.7)", "sine.inOut") as a function of 0..1. */
export function parseEase(name) {
  const m = /^([a-z]+\d?)(?:\.(inOut|in|out))?(?:\(([\d.]+))?/.exec(String(name || 'power1.out')) || [];
  const kind = m[1] || 'power1';
  const dir = m[2] || 'out';
  const arg = Number(m[3]);
  if (kind === 'none' || kind === 'linear' || kind === 'power0') return (p) => p;
  let fin; // the "in" form
  if (EASE_POW[kind]) fin = (p) => p ** EASE_POW[kind];
  else if (kind === 'sine') fin = (p) => 1 - Math.cos((p * Math.PI) / 2);
  else if (kind === 'expo') fin = (p) => (p === 0 ? 0 : 2 ** (10 * (p - 1)));
  else if (kind === 'circ') fin = (p) => 1 - Math.sqrt(1 - p * p);
  else if (kind === 'back' || kind === 'elastic') { const c = Number.isFinite(arg) ? arg : 1.70158; fin = (p) => p * p * ((c + 1) * p - c); }
  else if (kind === 'bounce') fin = (p) => 1 - bounceOut(1 - p);
  else fin = (p) => p;
  if (dir === 'in') return fin;
  if (dir === 'out') return (p) => 1 - fin(1 - p);
  return (p) => (p < 0.5 ? fin(p * 2) / 2 : 1 - fin((1 - p) * 2) / 2);
}

const BASE = { x: 0, y: 0, xPercent: 0, yPercent: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, autoAlpha: 1 };
const num = (v) => (typeof v === 'number' ? v : Number.parseFloat(v));

/**
 * The tweened values of one element at time t (seconds from the graphic's start).
 * entries: [{ tween, k }] — the tweens that target it, k = its index among the tween's targets (stagger).
 * Numbers interpolate; other values switch once the tween starts.
 */
export function tweenValuesAt(entries, t) {
  const out = {};
  const begin = (e) => e.tween.at + e.k * (e.tween.stagger || 0);
  const sorted = entries.slice().sort((a, b) => begin(a) - begin(b));
  for (const e of sorted) {
    const { tween } = e;
    const start = begin(e);
    const p = clamp01((t - start) / tween.dur);
    const ease = parseEase(tween.ease);
    for (const [prop, to] of Object.entries(tween.to)) {
      if (prop === 'repeat' || prop === 'yoyo' || prop === 'delay') continue;
      if (t < start) {
        // a fromTo shows its start values before it plays, unless something earlier set them
        if (tween.from && prop in tween.from && !(prop in out)) out[prop] = tween.from[prop];
        continue;
      }
      const from = tween.from && prop in tween.from ? tween.from[prop] : prop in out ? out[prop] : BASE[prop];
      const a = num(from);
      const b = num(to);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const unit = typeof to === 'string' ? String(to).replace(/^[-\d.]+/, '') : '';
        const v = a + (b - a) * ease(p);
        out[prop] = unit ? `${v}${unit}` : v;
      } else out[prop] = p > 0 ? to : from;
    }
  }
  return out;
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
  build(overlays, captionStyle, canvas = { width: 1080, height: 1920 }) {
    const key = JSON.stringify([overlays, captionStyle, canvas]);
    if (key === this.key) return;
    this.key = key;
    this.layer.replaceChildren();
    this.flash = document.createElement('div');
    this.flash.className = 've-fx-flash';
    this.layer.append(this.flash);
    this.canvas = canvas;
    const sheet = [];
    this.graphics = [];
    overlays.forEach((o, i) => {
      if (o.kind !== 'hf') return;
      const g = this._graphic(o, i);
      if (!g) return;
      this.graphics.push(g);
      if (o.css) sheet.push(`#pv-g-${i} { ${o.css} }`);
    });
    this._sheet(sheet.join('\n'));
    this.items = overlays.filter((o) => o.kind !== 'hf').map((o) => {
      const node = document.createElement('div');
      node.className = `ve-ov-item ${OV_CLASS[o.kind] || ''}`;
      let num = null;
      if (o.kind === 'title') {
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
      return { o, node, num };
    });
    this.cap = document.createElement('div');
    this.cap.className = `ve-fx-cap cap-${captionStyle}`;
    this.cap.hidden = true;
    this.layer.append(this.cap);
  }

  /** One HyperFrames graphic: the real markup in a canvas-sized box, scaled to the preview. */
  _graphic(o, i) {
    const doc = new DOMParser().parseFromString(`<div class="g-in">${fillMarkup(o.markup, o.vars)}</div>`, 'text/html');
    const inner = doc.body.firstElementChild;
    if (!inner) return null;
    const box = document.createElement('div');
    box.className = 'pv-hfg';
    box.id = `pv-g-${i}`;
    for (const v of o.vars || []) if (v.type === 'color') box.style.setProperty(`--${v.id}`, v.value);
    box.style.width = `${this.canvas.width}px`;
    box.style.height = `${this.canvas.height}px`;
    const node = document.importNode(inner, true);
    box.append(node);
    box.hidden = true;
    this.layer.append(box);
    // which elements each tween moves (and their order, for stagger)
    const targets = new Map();
    for (const tween of o.tweens || []) {
      let els = [];
      try { els = tween.sel ? [...node.querySelectorAll(tween.sel)] : [node]; } catch { els = []; }
      els.forEach((el, k) => {
        if (!targets.has(el)) targets.set(el, []);
        targets.get(el).push({ tween, k });
      });
    }
    return { o, box, targets };
  }

  /** The graphics' CSS, as a constructed sheet (the page's CSP allows no inline <style>). */
  _sheet(text) {
    if (!this.css) {
      this.css = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.css];
    }
    try {
      this.css.replaceSync(`.pv-hfg { position: absolute; left: 0; top: 0; transform-origin: 0 0; color: #000; font-weight: 400; text-shadow: none; text-align: left; }\n.pv-hfg[hidden] { display: none; }\n.pv-hfg > .g-in { position: absolute; inset: 0; }\n${text}`);
    } catch { /* a bad rule only loses the look */ }
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
    const scale = this.layer.clientWidth / ((this.canvas && this.canvas.width) || 1080);
    for (const g of this.graphics || []) {
      const on = t >= g.o.start && t <= g.o.end;
      g.box.hidden = !on;
      if (!on) continue;
      g.box.style.transform = `scale(${scale.toFixed(5)})`;
      for (const [el, entries] of g.targets) paintProps(el, tweenValuesAt(entries, t - g.o.start));
    }
    for (const it of this.items) {
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
    this.graphics = [];
    const v = this.video.style;
    v.opacity = '';
    v.transform = '';
    v.filter = '';
  }
}

const TRANSFORM = new Set(['x', 'y', 'xPercent', 'yPercent', 'scale', 'scaleX', 'scaleY', 'rotation']);
const PX = /^(width|height|top|left|right|bottom|fontSize|letterSpacing|borderRadius|padding\w*|margin\w*|strokeWidth)$/;
const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Puts tweened values on an element like GSAP does (transform parts combined, numbers in px where GSAP would). */
function paintProps(el, v) {
  const st = el.style;
  const n = (k, d) => (k in v ? Number.parseFloat(v[k]) || 0 : d);
  if ([...TRANSFORM].some((k) => k in v)) {
    const sx = n('scaleX', n('scale', 1));
    const sy = n('scaleY', n('scale', 1));
    st.transform = `translate(${n('xPercent', 0)}%, ${n('yPercent', 0)}%) translate(${n('x', 0)}px, ${n('y', 0)}px) rotate(${n('rotation', 0)}deg) scale(${sx}, ${sy})`;
  }
  for (const [k, val] of Object.entries(v)) {
    if (TRANSFORM.has(k)) continue;
    if (k === 'autoAlpha') {
      st.opacity = String(val);
      st.visibility = Number(val) > 0 ? '' : 'hidden';
    } else st.setProperty(kebab(k), typeof val === 'number' && PX.test(k) ? `${val}px` : String(val));
  }
}
