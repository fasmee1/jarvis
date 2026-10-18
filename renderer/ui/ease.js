// One easing curve for the whole HUD: cubic-bezier(0.22, 1, 0.36, 1).
// Registered with GSAP as "calm" so every timeline can use ease: 'calm'.

export const EASE_CSS = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Cubic-bezier easing (x1, y1, x2, y2) as a plain function of progress 0..1. */
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - p;
      const d = dx(t);
      if (Math.abs(err) < 1e-6 || Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // fall back to bisection if Newton wandered off
    if (t < 0 || t > 1 || Math.abs(sx(t) - p) > 1e-4) {
      let lo = 0;
      let hi = 1;
      t = p;
      for (let i = 0; i < 24; i++) {
        if (sx(t) < p) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return sy(t);
  };
}

export const calm = bezier(0.22, 1, 0.36, 1);

if (window.gsap && window.gsap.registerEase) window.gsap.registerEase('calm', calm);
