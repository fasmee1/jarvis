'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Simulate ten minutes of orbiting in 0.1 s steps.
async function positions() {
  const { ORBITS, SATS, orbitPoint, satAngle } = await import('../renderer/ui/orbits.js');
  const frames = [];
  for (let t = 0; t <= 600; t += 0.1) frames.push(SATS.map((s) => ({ id: s.id, ...orbitPoint(ORBITS[s.orbit], satAngle(s, t)) })));
  return { frames, SATS, ORBITS, orbitPoint };
}

test('orbits: one satellite per card, every card has one', async () => {
  const { SATS } = await positions();
  const ids = SATS.map((s) => s.id).sort();
  assert.deepEqual(ids, ['camera', 'edit', 'latency', 'mic', 'reply', 'step', 'tokens', 'tts']);
});

test('orbits: depth is near at the bottom and far at the top', async () => {
  const { ORBITS, orbitPoint } = await positions();
  const o = ORBITS[0];
  const near = orbitPoint(o, 90);
  const far = orbitPoint(o, 270);
  assert.ok(near.depth > 0.99 && near.y > far.y);
  assert.ok(far.depth < -0.99);
});

test('orbits: satellites never overlap each other', async () => {
  const { frames } = await positions();
  let min = Infinity;
  for (const f of frames) {
    for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) min = Math.min(min, Math.hypot(f[i].x - f[j].x, f[i].y - f[j].y));
  }
  assert.ok(min >= 30, `closest pass ${min.toFixed(1)} px`); // satellites are 26 px across
});

test('orbits: satellites never run under a card of the calm layout', async () => {
  const { frames } = await positions();
  const { pickLayout, cardRect } = await import('../renderer/ui/layout.js');
  const rects = pickLayout(1920).cards.map(cardRect);
  const R = 16; // satellite ring + a little air
  for (const f of frames) {
    for (const p of f) {
      for (const r of rects) {
        const cx = Math.max(r.x, Math.min(p.x, r.x + r.w));
        const cy = Math.max(r.y, Math.min(p.y, r.y + r.h));
        assert.ok(Math.hypot(p.x - cx, p.y - cy) > R, `${p.id} touches a card at (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
      }
    }
  }
});

test('orbits: hit targets stay clear of the open-all button under the core', async () => {
  const { frames } = await positions();
  // the readout's open / close-all button: about x 890–1030, y 674–696 on the stage
  const btn = { x: 890, y: 674, w: 140, h: 22 };
  for (const f of frames) {
    for (const p of f) {
      const cx = Math.max(btn.x, Math.min(p.x, btn.x + btn.w));
      const cy = Math.max(btn.y, Math.min(p.y, btn.y + btn.h));
      assert.ok(Math.hypot(p.x - cx, p.y - cy) > 22, `${p.id} hit target covers the button at (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
    }
  }
});
