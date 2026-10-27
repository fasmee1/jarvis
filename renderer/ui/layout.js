// Art-directed home composition, defined on a 1920×1080 design canvas with a
// 24px grid (80 × 45 cells). The whole stage is scaled uniformly to the window,
// so every card, bend and mark stays snapped to the same grid at any size.
//
// Card: { id, col, row, w, h (cells), tag, size, cut, anchor:{side,at}, node(deg), route, depth }
//   cut   — which corners are cut at 45°: tl,tr,br,bl (art-directed per card)
//   anchor— where the leader line leaves the card: side l|r|t|b, `at` 0..1 along that side
//   node  — angle on the core's node ring (clockwise from 12 o'clock)
//   route — 'h45' horizontal then 45°, 'v45' vertical then 45°, 'd' straight
//   depth — parallax layer 0 (far) | 1 (near)

export const CELL = 24;
export const W = 1920;
export const H = 1080;
export const CORE = { x: 960, y: 540, rNode: 276, rOuter: 292 };

// Three sizes — small 11×5 (MIC, TTS), medium 13×7 (STEP, TOKENS, CAMERA,
// ELAPSED), large 18×9 (LAST REPLY, LATENCY) — mirrored around the reactor's
// vertical axis (col 40): every left card has a twin at col 80 − col − w.
const BASE = [
  { id: 'reply', col: 6, row: 5, w: 18, h: 9, tag: 'A3', size: 'large', cut: ['tl', 'br'], anchor: { side: 'r', at: 0.45 }, node: 310, route: 'h45', depth: 1 },
  { id: 'mic', col: 26, row: 3, w: 11, h: 5, tag: 'B4', size: 'small', cut: ['tl', 'br'], anchor: { side: 'b', at: 0.55 }, node: 334, route: 'v45', depth: 0 },
  { id: 'tts', col: 43, row: 3, w: 11, h: 5, tag: 'C6', size: 'small', cut: ['tl', 'br'], anchor: { side: 'b', at: 0.45 }, node: 26, route: 'v45', depth: 0 },
  { id: 'latency', col: 56, row: 5, w: 18, h: 9, tag: 'D8', size: 'large', cut: ['tl', 'br'], anchor: { side: 'l', at: 0.45 }, node: 50, route: 'h45', depth: 1 },
  { id: 'step', col: 10, row: 21, w: 13, h: 7, tag: 'B2', size: 'medium', cut: ['tl', 'br'], anchor: { side: 'r', at: 36 / 168 }, node: 270, route: 'd', depth: 1 },
  { id: 'tokens', col: 57, row: 21, w: 13, h: 7, tag: 'C7', size: 'medium', cut: ['tl', 'br'], anchor: { side: 'l', at: 36 / 168 }, node: 90, route: 'd', depth: 0 },
  // bottom pair: straight 45° connectors into the 225° / 135° nodes
  { id: 'camera', col: 15, row: 36, w: 13, h: 7, tag: 'B5', size: 'medium', cut: ['tl', 'br'], anchor: { side: 't', at: 276 / 312 }, node: 225, route: 'd', depth: 0 },
  { id: 'edit', col: 52, row: 36, w: 13, h: 7, tag: 'D6', size: 'medium', cut: ['tl', 'br'], anchor: { side: 't', at: 36 / 312 }, node: 135, route: 'd', depth: 1 },
];

// ~1440: pull the far cards a little closer to the core.
const MID = BASE.map((c) => ({ ...c, ...({ reply: { col: 7, w: 17 }, latency: { col: 56, w: 17 } }[c.id] || {}) }));
// ≤1280 / narrow aspect: drop the least important cards (hide order: tts, tokens, latency chart, mic).
const NARROW = BASE.map((c) => ({ ...c, hidden: c.id === 'tts' || c.id === 'tokens', compact: c.id === 'latency' }));

export const LAYOUTS = [
  { name: 'wide', minWidth: 1700, cards: BASE },
  { name: 'mid', minWidth: 1300, cards: MID },
  { name: 'narrow', minWidth: 0, cards: NARROW },
];

// Frame: only four thin corner brackets (drawn in window space by cards.js).

export function cardRect(c) {
  if (c.px) return c.px; // live override (e.g. the camera panel while it expands)
  return { x: c.col * CELL, y: c.row * CELL, w: c.w * CELL, h: c.h * CELL };
}

export function nodePoint(deg, r = CORE.rNode) {
  const a = (deg * Math.PI) / 180;
  return { x: CORE.x + Math.sin(a) * r, y: CORE.y - Math.cos(a) * r };
}

export function anchorPoint(c) {
  const r = cardRect(c);
  const { side, at } = c.anchor;
  if (side === 'l') return { x: r.x, y: r.y + r.h * at };
  if (side === 'r') return { x: r.x + r.w, y: r.y + r.h * at };
  if (side === 't') return { x: r.x + r.w * at, y: r.y };
  return { x: r.x + r.w * at, y: r.y + r.h };
}

/** Leader polyline from the card anchor to its core node, with 45°/90° bends. */
export function leaderPoints(c) {
  const a = anchorPoint(c);
  const n = nodePoint(c.node);
  const dx = n.x - a.x;
  const dy = n.y - a.y;
  if (c.route === 'h45') {
    // run horizontally, then finish on an exact 45° diagonal into the node
    return [a, { x: n.x - Math.sign(dx) * Math.abs(dy), y: a.y }, n];
  }
  if (c.route === 'v45') {
    return [a, { x: a.x, y: n.y - Math.sign(dy) * Math.abs(dx) }, n];
  }
  return [a, n];
}

function overlaps(r1, r2, gap) {
  return r1.x < r2.x + r2.w + gap && r2.x < r1.x + r1.w + gap && r1.y < r2.y + r2.h + gap && r2.y < r1.y + r1.h + gap;
}

/** Cards must keep ≥2 cells from each other and from the core's outer ring. */
export function collides(cards) {
  const vis = cards.filter((c) => !c.hidden).map(cardRect);
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) if (overlaps(vis[i], vis[j], 2 * CELL)) return true;
    const r = vis[i];
    const cx = Math.max(r.x, Math.min(CORE.x, r.x + r.w));
    const cy = Math.max(r.y, Math.min(CORE.y, r.y + r.h));
    if (Math.hypot(cx - CORE.x, cy - CORE.y) < CORE.rOuter + 2 * CELL) return true;
  }
  return false;
}

/** Pick the layout for the current window size (falls through on collisions). */
export function pickLayout(winW, winH) {
  const aspect = winW / winH;
  for (const l of LAYOUTS) {
    if (winW < l.minWidth) continue;
    if (aspect < 1.45 && l.name !== 'narrow') continue;
    if (!collides(l.cards)) return l;
  }
  return LAYOUTS[LAYOUTS.length - 1];
}
