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

// ---- HUD style: the reference composition (1672×940 stage units) mapped onto the 1920×1080 canvas ----
// One uniform scale; the reference core centre (836, 481) lands on CORE (960, 540).
export const HS = 1920 / 1672;
export const HUD_K = 1.15; // reference core scale: ring radius 243 · K
export const HUD_R_OUT = 243 * HUD_K * HS; // node ring radius on the 1920 canvas
const hx = (x) => (x - 836) * HS + 960;
const hy = (y) => (y - 481) * HS + 540;
// reference boxes (ref units): x,y,w,h · cut corners · node angle (ref: 0 = right, clockwise) · leader edge/t/route
const HUD_BASE = {
  reply: { x: 104, y: 116, w: 392, h: 240, cut: { tl: 26, br: 26 }, node: -135, edge: 'r', t: 0.55, route: 'h45', tag: 'A3', size: 'large', depth: 1 },
  mic: { x: 584, y: 24, w: 240, h: 128, cut: { tr: 18 }, node: -110, edge: 'b', t: 0.6, route: 'v45', tag: 'B4', size: 'small', depth: 0.45 },
  latency: { x: 1196, y: 140, w: 380, h: 214, cut: { tl: 16, br: 34 }, node: -40, edge: 'l', t: 0.7, route: 'h45', tag: 'D8', size: 'large', depth: 1 },
  step: { x: 128, y: 452, w: 320, h: 160, cut: { tr: 20, bl: 20 }, node: 165, edge: 'r', t: 0.2, route: 'h45', tag: 'B2', size: 'medium', depth: 0.7 },
  tokens: { x: 1292, y: 436, w: 264, h: 164, cut: { tl: 18 }, node: 22, edge: 'l', t: 0.25, route: 'h45', tag: 'C7', size: 'medium', depth: 0.7 },
  tts: { x: 884, y: 24, w: 240, h: 128, cut: { tl: 18 }, node: -70, edge: 'b', t: 0.4, route: 'v45', tag: 'C6', size: 'small', depth: 0.45 },
  camera: { x: 160, y: 662, w: 300, h: 160, cut: { bl: 16, tr: 16 }, node: 120, edge: 'r', t: 0.8, route: 'h45', tag: 'B5', size: 'medium', depth: 0.45 },
  edit: { x: 1010, y: 770, w: 292, h: 140, cut: { br: 20, tl: 14 }, node: 75, edge: 'l', t: 0.5, route: 'h45', tag: 'D6', size: 'medium', depth: 0.45 },
};
const HUD_GROW = { wide: 1, mid: 1.05, narrow: 1.12 };
// narrow windows hide cards in this order (window width below the limit)
const HUD_HIDE = { tts: 1180, tokens: 1040, mic: 820 };

function hudCards(name) {
  const k = HUD_GROW[name];
  const out = [];
  for (const id of Object.keys(HUD_BASE)) {
    const b = HUD_BASE[id];
    const ew = b.w * (k - 1), eh = b.h * (k - 1);
    const left = b.x + b.w / 2 < 836, up = b.y + b.h / 2 < 481;
    const x = Math.round(left ? b.x - ew : b.x), y = Math.round(up ? b.y - eh : b.y);
    const w = Math.round(b.w + ew), h = Math.round(b.h + eh);
    const cutPx = {};
    for (const c of ['tl', 'tr', 'br', 'bl']) cutPx[c] = (b.cut[c] || 0) * HS;
    out.push({
      id, hud: true, tag: b.tag, size: b.size, depth: b.depth, cut: Object.keys(b.cut), cutPx,
      col: hx(x) / CELL, row: hy(y) / CELL, w: (w * HS) / CELL, h: (h * HS) / CELL,
      anchor: { side: b.edge, at: b.t }, node: (b.node + 90 + 360) % 360, route: b.route,
    });
  }
  return out;
}

// Calm style (orbital): the orbits fill the middle band (y ≈ 280–800), so the cards sit in a top
// and a bottom row, mirrored around the vertical axis. Each card's energy line leaves the middle of
// its inner edge and runs straight to its moving satellite (ui/orbits.js). `node` is kept for the
// 2D reactor and the dock timelines; the satellite replaces it on screen.
const top = (id, col, w, h, size, node) => ({ id, col, row: 4, w, h, tag: '', size, cut: ['tl', 'br'], anchor: { side: 'b', at: 0.5 }, node, route: 'd', depth: 0 });
const bottom = (id, col, node) => ({ id, col, row: 34, w: 13, h: 7, tag: '', size: 'medium', cut: ['tl', 'br'], anchor: { side: 't', at: 0.5 }, node, route: 'd', depth: 0 });
const ORBIT_CARDS = [
  top('reply', 2, 16, 9, 'large', 310),
  top('mic', 23, 11, 5, 'small', 334),
  top('tts', 46, 11, 5, 'small', 26),
  top('latency', 62, 16, 9, 'large', 50),
  bottom('step', 2, 250),
  bottom('camera', 16, 210),
  bottom('edit', 51, 150),
  bottom('tokens', 65, 110),
];
const ORBIT_LAYOUT = { name: 'orbit', minWidth: 0, cards: ORBIT_CARDS };

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
export function pickLayout(winW) {
  if (STYLE === 'hud') return pickHud(winW);
  return ORBIT_LAYOUT; // one composition: the stage scales uniformly to the window
}

// ---------- style switch ----------
let STYLE = 'calm';
export const getLayoutStyle = () => STYLE;

/** 'hud' moves the node ring out to the reference radius and swaps the card composition. */
export function setLayoutStyle(style) {
  STYLE = style === 'hud' ? 'hud' : 'calm';
  CORE.rNode = STYLE === 'hud' ? HUD_R_OUT : 276;
  CORE.rOuter = STYLE === 'hud' ? HUD_R_OUT : 292;
}

function pickHud(winW) {
  const order = ['wide', 'mid', 'narrow'];
  let i = winW >= 1600 ? 0 : winW >= 1360 ? 1 : 2;
  for (; i < order.length; i++) if (!collides(hudCards(order[i]))) break;
  const name = order[Math.min(i, 2)];
  const cards = hudCards(name).map((c) => ({ ...c, hidden: !!c.hidden || (HUD_HIDE[c.id] ? winW < HUD_HIDE[c.id] : false) }));
  const off = cards.filter((c) => c.hidden && c.id !== 'camera' && c.id !== 'edit').map((c) => c.id).join(',');
  return { name: `hud-${name}${off ? '-' + off : ''}`, minWidth: 0, cards };
}
