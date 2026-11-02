// Pure geometry for HUD cards: chamfered outlines and corner accents that sit exactly on the outline.
// (Ported from the reference HUD; no DOM.)
const r1 = (n) => Math.round(n * 100) / 100;

/** Outline of a w x h box with 45-degree cuts {tl,tr,br,bl} (px). Starts at the top edge, runs clockwise. */
export function outlinePath(w, h, cut = {}) {
  const c = { tl: 0, tr: 0, br: 0, bl: 0, ...cut };
  return `M${r1(c.tl)} 0H${r1(w - c.tr)}L${r1(w)} ${r1(c.tr)}V${r1(h - c.br)}L${r1(w - c.br)} ${r1(h)}H${r1(c.bl)}L0 ${r1(h - c.bl)}V${r1(c.tl)}Z`;
}

/** Arm length: about 12% of the dimension, kept inside [min, max] (28..40 px for cards, larger for the camera frame). */
export const armLength = (dim, { pct = 0.12, min = 28, max = 40 } = {}) => Math.min(max, Math.max(min, dim * pct));

/**
 * L-shaped accent at the top-left ('tl') or bottom-right ('br') corner, following the chamfer.
 * The path is drawn with arms 30% longer than rest (hover size); `rest` and `hover` give the dash values that
 * show the rest length or the full extended length, so hover only has to switch two CSS variables.
 * Every point lies on the outline, so the accent sits exactly on top of the base border.
 */
export function cornerAccent(w, h, cut, corner, opts = {}) {
  const c = { tl: 0, tr: 0, br: 0, bl: 0, ...cut };
  const k = 1.3;
  const ah = armLength(w, opts), av = armLength(h, opts); // rest arms: horizontal / vertical
  const ahE = ah * k, avE = av * k;
  const d = corner === 'tl' ? c.tl : c.br;
  let pts;
  if (corner === 'tl') pts = [[0, d + avE], [0, d], [d, 0], [d + ahE, 0]];
  else pts = [[w, h - d - avE], [w, h - d], [w - d, h], [w - d - ahE, h]];
  const diag = d * Math.SQRT2, total = avE + diag + ahE, rest = av + diag + ah;
  return {
    pts: pts.map(([x, y]) => [r1(x), r1(y)]),
    d: 'M' + pts.map(([x, y]) => `${r1(x)} ${r1(y)}`).join('L'),
    arms: { h: ah, v: av }, total: r1(total), restLen: r1(rest),
    rest: { dash: `${r1(rest)} ${r1(total)}`, offset: r1(-(avE - av)) },
    hover: { dash: `${r1(total)} ${r1(total)}`, offset: 0 },
  };
}

