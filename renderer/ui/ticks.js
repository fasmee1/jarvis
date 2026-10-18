// The reactor's fine tick ring, in SVG: a minor tick every 5° (4px, 10%), a
// major tick every 45° (8px, 30%) and slightly longer ticks at 0/90/180/270°
// (12px). The ring turns very slowly (one rotation per 120 s); the four degree
// labels stay put, all at the same offset outside the ring on their axis.
// Angles are degrees clockwise from 12 o'clock; the core box is 720×720.

const NS = 'http://www.w3.org/2000/svg';
const C = 360;
const R_TICKS = 292; // ticks point inward from the outer hairline
const R_LABEL = 312; // label centres: one consistent offset outside the ring

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
const pt = (r, d) => {
  const a = (d * Math.PI) / 180;
  return [C + Math.sin(a) * r, C - Math.cos(a) * r];
};

export class Ticks {
  constructor(wrap, canvas) {
    this.over = el('svg', { class: 'tick-layer tick-over', viewBox: '0 0 720 720', 'aria-hidden': 'true' });
    canvas.after(this.over);
    const g = el('g', { class: 'tk-ring' });
    for (let d = 0; d < 360; d += 5) {
      const cardinal = d % 90 === 0;
      const major = d % 45 === 0;
      const len = cardinal ? 12 : major ? 8 : 4;
      const [x1, y1] = pt(R_TICKS, d);
      const [x2, y2] = pt(R_TICKS - len, d);
      g.append(el('line', {
        x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2),
        'stroke-width': 1, opacity: major ? 0.3 : 0.1,
      }));
    }
    const labels = el('g', { class: 'tk-labels' });
    for (const d of [0, 90, 180, 270]) {
      const [x, y] = pt(R_LABEL, d);
      labels.append(el('text', { x: x.toFixed(1), y: y.toFixed(1), 'text-anchor': 'middle', 'dominant-baseline': 'central' }, `${d}°`));
    }
    this.over.append(g, labels);
  }

  /** The ring turns with CSS (see .tk-ring); nothing to do per frame. */
  frame() {}
}
