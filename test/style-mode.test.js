'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function setup({ stored = {}, osReduce = false } = {}) {
  const store = { ...stored };
  global.document = { documentElement: { dataset: {} } };
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  global.matchMedia = () => ({ matches: osReduce, addEventListener() {} });
  return store;
}

test('style mode: defaults, persistence and validation', async () => {
  const store = setup();
  const m = await import(`../renderer/ui/style-mode.js?a=${Math.random()}`);
  assert.equal(m.getStyle(), 'hud');
  assert.equal(m.getMotion(), 'auto');
  m.setStyle('calm');
  assert.equal(document.documentElement.dataset.style, 'calm');
  assert.equal(store['jarvis.style'], 'calm');
  m.setStyle('neon'); // unknown values are ignored
  assert.equal(m.getStyle(), 'calm');
  m.setMotion('bogus');
  assert.equal(m.getMotion(), 'auto');
});

test('style mode: motion preference overrides the OS setting', async () => {
  setup({ osReduce: true });
  const m = await import(`../renderer/ui/style-mode.js?b=${Math.random()}`);
  assert.equal(m.motionReduced(), true); // auto follows the OS
  m.setMotion('full');
  assert.equal(m.motionReduced(), false);
  m.setMotion('reduced');
  assert.equal(m.motionReduced(), true);
});

test('style mode: subscribers get the current state at once and on change', async () => {
  setup();
  const m = await import(`../renderer/ui/style-mode.js?c=${Math.random()}`);
  const seen = [];
  const off = m.onStyleChange((s) => seen.push(`${s.style}/${s.reduced}`));
  m.setStyle('calm');
  m.setMotion('reduced');
  off();
  m.setStyle('hud');
  assert.deepEqual(seen, ['hud/false', 'calm/false', 'calm/true']);
});

test('style mode: the arc style is accepted and persisted', async () => {
  const store = setup();
  const m = await import(`../renderer/ui/style-mode.js?d=${Math.random()}`);
  m.setStyle('arc');
  assert.equal(m.getStyle(), 'arc');
  assert.equal(store['jarvis.style'], 'arc');
});
