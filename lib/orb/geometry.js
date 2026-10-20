'use strict';
// Floating Orb geometry (pure, DIP units). `pos` is the top-left of the visible
// orb circle; the window adds a glow margin around it, and grows beside the orb
// while the reply bubble is open.

const SIZES = { S: 64, M: 88, L: 120 };
const PAD = 28; // glow / drag-shadow margin around the circle
const EDGE = 24; // resting distance from the screen edges
const SNAP = 40; // closer than this to an edge on release → snap to EDGE
const GAP = 10; // between the orb circle and the bubble
const PANEL_PAD = 8; // room for the bubble's shadow

const orbSize = (name) => SIZES[name] || SIZES.M;

function defaultPos(wa, size) {
  return { x: wa.x + wa.width - EDGE - size, y: wa.y + wa.height - EDGE - size };
}

/** Keep the whole circle inside the work area. */
function clampPos(p, size, wa) {
  return {
    x: Math.round(Math.min(Math.max(p.x, wa.x), wa.x + wa.width - size)),
    y: Math.round(Math.min(Math.max(p.y, wa.y), wa.y + wa.height - size)),
  };
}

/** On release: within SNAP of an edge → rest at EDGE from it. */
function snapPos(p, size, wa) {
  let { x, y } = p;
  if (x - wa.x < SNAP) x = wa.x + EDGE;
  else if (wa.x + wa.width - (x + size) < SNAP) x = wa.x + wa.width - EDGE - size;
  if (y - wa.y < SNAP) y = wa.y + EDGE;
  else if (wa.y + wa.height - (y + size) < SNAP) y = wa.y + wa.height - EDGE - size;
  return clampPos({ x, y }, size, wa);
}

/**
 * Saved position → position now. If its display is gone (monitor unplugged) or
 * nothing was saved, fall back to the default bottom-right of the primary display.
 */
function restorePos(saved, displays, primary, size) {
  const d = saved && displays.find((x) => x.id === saved.displayId);
  if (!d) return { pos: defaultPos(primary.workArea, size), displayId: primary.id };
  return { pos: clampPos(saved, size, d.workArea), displayId: d.id };
}

function orbBounds(p, size) {
  return { x: p.x - PAD, y: p.y - PAD, width: size + PAD * 2, height: size + PAD * 2 };
}

/**
 * Window layout with the bubble open. The bubble opens toward the screen centre:
 * left of the orb when the orb is on the right half, and downward when the orb is
 * on the top half (upward otherwise). The window is the union of both boxes.
 * Returns the window bounds plus the orb and bubble rects inside the window.
 */
function panelLayout(p, size, wa, panel) {
  const w = Math.round(panel.w);
  const h = Math.round(panel.h);
  const left = p.x + size / 2 > wa.x + wa.width / 2;
  const down = p.y + size / 2 < wa.y + wa.height / 2;
  let px = left ? p.x - GAP - w : p.x + size + GAP;
  // a one-line tip sits level with the orb; the reply bubble grows away from the edge
  let py = h <= size ? p.y + (size - h) / 2 : down ? p.y : p.y + size - h;
  py = Math.round(py);
  py = Math.min(Math.max(py, wa.y), wa.y + wa.height - h);
  px = Math.min(Math.max(px, wa.x), wa.x + wa.width - w);
  const ob = orbBounds(p, size);
  const x0 = Math.min(ob.x, px - PANEL_PAD);
  const y0 = Math.min(ob.y, py - PANEL_PAD);
  const x1 = Math.max(ob.x + ob.width, px + w + PANEL_PAD);
  const y1 = Math.max(ob.y + ob.height, py + h + PANEL_PAD);
  return {
    bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    orb: { x: p.x - x0, y: p.y - y0 },
    panel: { x: px - x0, y: py - y0, w, h },
    dir: { h: left ? 'left' : 'right', v: down ? 'down' : 'up' },
  };
}

/** Collapsed layout: just the orb with its margin. */
function orbLayout(p, size) {
  return { bounds: orbBounds(p, size), orb: { x: PAD, y: PAD }, panel: null, dir: null };
}

module.exports = { SIZES, PAD, EDGE, SNAP, GAP, orbSize, defaultPos, clampPos, snapPos, restorePos, orbBounds, panelLayout, orbLayout };
