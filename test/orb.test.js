'use strict';
// Floating Orb: position, snapping, multi-monitor fallback, bubble direction,
// and the saved position in settings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../lib/orb/geometry');
const { sanitize, SettingsStore } = require('../lib/settings');

const WA = { x: 0, y: 0, width: 1920, height: 1040 }; // 1080p minus a 40 px taskbar
const S = 64;

test('default: bottom-right of the work area, 24 px from both edges', () => {
  assert.deepStrictEqual(G.defaultPos(WA, S), { x: 1920 - 24 - 64, y: 1040 - 24 - 64 });
  // the window is the circle plus its glow margin (96×96 for M)
  assert.deepStrictEqual(G.orbBounds({ x: 100, y: 200 }, S), { x: 84, y: 184, width: 96, height: 96 });
  assert.deepStrictEqual([G.orbSize('S'), G.orbSize('M'), G.orbSize('L'), G.orbSize('?')], [48, 64, 80, 64]);
});

test('clamp: never off-screen (or under the taskbar)', () => {
  assert.deepStrictEqual(G.clampPos({ x: -50, y: 5000 }, S, WA), { x: 0, y: 1040 - 64 });
  assert.deepStrictEqual(G.clampPos({ x: 3000, y: -10 }, S, WA), { x: 1920 - 64, y: 0 });
  // second monitor to the left with a negative origin
  const left = { x: -1280, y: 0, width: 1280, height: 1024 };
  assert.deepStrictEqual(G.clampPos({ x: -2000, y: 100 }, S, left), { x: -1280, y: 100 });
});

test('snap: within 40 px of an edge → rest at 24 px; elsewhere stays put', () => {
  assert.deepStrictEqual(G.snapPos({ x: 30, y: 500 }, S, WA), { x: 24, y: 500 });
  assert.deepStrictEqual(G.snapPos({ x: 1920 - 64 - 10, y: 1040 - 64 - 39 }, S, WA), { x: 1920 - 64 - 24, y: 1040 - 64 - 24 });
  assert.deepStrictEqual(G.snapPos({ x: 800, y: 400 }, S, WA), { x: 800, y: 400 });
  assert.deepStrictEqual(G.snapPos({ x: 2, y: 3 }, S, WA), { x: 24, y: 24 });
});

test('restore: saved display gone (monitor unplugged) → default on the primary display', () => {
  const primary = { id: 1, workArea: WA };
  const other = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };
  const saved = { x: 3000, y: 700, displayId: 2 };
  assert.deepStrictEqual(G.restorePos(saved, [primary, other], primary, S), { pos: { x: 3000, y: 700 }, displayId: 2 });
  assert.deepStrictEqual(G.restorePos(saved, [primary], primary, S), { pos: G.defaultPos(WA, S), displayId: 1 });
  assert.deepStrictEqual(G.restorePos(null, [primary], primary, S).pos, G.defaultPos(WA, S));
  // display shrank (resolution change): clamped back on screen
  const small = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 720 } };
  assert.deepStrictEqual(G.restorePos(saved, [primary, small], primary, S).pos, { x: 3000, y: 720 - 64 });
  assert.deepStrictEqual(G.restorePos({ x: 3500, y: 700, displayId: 2 }, [primary, small], primary, S).pos, { x: 1920 + 1280 - 64, y: 720 - 64 });
});

test('bubble opens toward the screen centre', () => {
  const panel = { w: 320, h: 236 };
  // bottom-right orb: bubble to the left, growing up; orb keeps its screen position
  const br = G.defaultPos(WA, S);
  const a = G.panelLayout(br, S, WA, panel);
  assert.deepStrictEqual(a.dir, { h: 'left', v: 'up' });
  assert.strictEqual(a.bounds.x + a.orb.x, br.x);
  assert.strictEqual(a.bounds.y + a.orb.y, br.y);
  assert.ok(a.bounds.x + a.panel.x + panel.w <= br.x - G.GAP);
  assert.strictEqual(a.bounds.y + a.panel.y + panel.h, br.y + S); // bottom-aligned with the orb
  // top-left orb: bubble to the right, growing down
  const b = G.panelLayout({ x: 24, y: 24 }, S, WA, panel);
  assert.deepStrictEqual(b.dir, { h: 'right', v: 'down' });
  assert.strictEqual(b.bounds.x + b.panel.x, 24 + S + G.GAP);
  assert.strictEqual(b.bounds.y + b.panel.y, 24);
  // the bubble itself never leaves the work area
  for (const l of [a, b]) {
    assert.ok(l.bounds.x + l.panel.x >= WA.x && l.bounds.x + l.panel.x + l.panel.w <= WA.x + WA.width);
    assert.ok(l.bounds.y + l.panel.y >= WA.y && l.bounds.y + l.panel.y + l.panel.h <= WA.y + WA.height);
  }
  // collapsed: the orb with its margin only
  assert.deepStrictEqual(G.orbLayout(br, S), { bounds: G.orbBounds(br, S), orb: { x: G.PAD, y: G.PAD }, panel: null, dir: null });
});

test('settings: orb defaults, and only a well-formed position is accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-orb-'));
  const st = new SettingsStore(dir);
  const s = st.get();
  assert.strictEqual(s.orbEnabled, true);
  assert.strictEqual(s.orbOnTopFullscreen, false);
  assert.strictEqual(s.orbSize, 'M');
  assert.strictEqual(s.orbAutoOpenResults, false);
  assert.strictEqual(s.orbShortcut, 'Control+Shift+Space');
  assert.strictEqual(s.orbPos, null);
  assert.ok(sanitize({ orbPos: { x: -1500, y: 20, displayId: 2528732444 } }).ok);
  assert.ok(sanitize({ orbPos: null }).ok);
  for (const bad of [{ x: 1, y: 2 }, { x: 1.5, y: 2, displayId: 1 }, { x: 1, y: 2, displayId: 1, extra: 1 }, [1, 2, 3], 'x', { x: 1e9, y: 0, displayId: 1 }]) {
    assert.strictEqual(sanitize({ orbPos: bad }).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(sanitize({ orbSize: 'XL' }).ok, false);
  // persisted and read back
  st.update({ orbPos: { x: 10, y: 20, displayId: 7 } });
  assert.deepStrictEqual(new SettingsStore(dir).get().orbPos, { x: 10, y: 20, displayId: 7 });
});
