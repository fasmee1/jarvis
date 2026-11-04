'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('holo core: every app state maps to a visual kind', async () => {
  const { holoKind } = await import('../renderer/ui/holo-state.js');
  for (const s of ['TRANSCRIBING', 'THINKING', 'TOOL_RUNNING', 'STREAMING']) assert.equal(holoKind(s), 'THINKING');
  assert.equal(holoKind('WAKE_LISTENING'), 'WAKE');
  assert.equal(holoKind('WAKE_DETECTED'), 'WAKE');
  assert.equal(holoKind('LISTENING'), 'LISTENING');
  assert.equal(holoKind('FOLLOW_UP'), 'FOLLOW_UP');
  assert.equal(holoKind('SPEAKING'), 'SPEAKING');
  assert.equal(holoKind('AWAITING_APPROVAL'), 'APPROVAL');
  assert.equal(holoKind('ERROR'), 'ERROR');
  assert.equal(holoKind('STANDBY'), 'STANDBY');
  assert.equal(holoKind('SOMETHING_NEW'), 'STANDBY');
});

test('holo core: real audio level drives listening / speaking only', async () => {
  const { holoTarget } = await import('../renderer/ui/holo-state.js');
  const quiet = holoTarget('SPEAKING', 0);
  const loud = holoTarget('SPEAKING', 1);
  assert.ok(loud.glow > quiet.glow);
  assert.ok(loud.swarm > quiet.swarm);
  assert.ok(quiet.wave > 0); // waveform ring shows while speaking
  // standby ignores the level (no fake reaction)
  assert.deepEqual(holoTarget('STANDBY', 1), holoTarget('STANDBY', 0));
  // thinking sends pulses on a timer; standby does not
  assert.ok(holoTarget('THINKING').pulse > 0);
  assert.equal(holoTarget('STANDBY').pulse, 0);
  // error leans orange and dims
  assert.ok(holoTarget('ERROR').orange > holoTarget('STANDBY').orange);
  assert.ok(holoTarget('ERROR').glow < holoTarget('STANDBY').glow);
});

test('holo core: reduced motion keeps brightness but stops movement', async () => {
  const { holoTarget } = await import('../renderer/ui/holo-state.js');
  const r = holoTarget('THINKING', 0, { reduced: true });
  assert.equal(r.speed, 0);
  assert.equal(r.swarm, 0);
  assert.equal(r.pulse, 0);
  assert.equal(r.glow, holoTarget('THINKING', 0).glow);
});

test('holo core: easing moves toward the target without overshoot', async () => {
  const { easeToward } = await import('../renderer/ui/holo-state.js');
  const cur = { glow: 0 };
  easeToward(cur, { glow: 1 }, 0.1, 3);
  assert.ok(cur.glow > 0 && cur.glow < 1);
  easeToward(cur, { glow: 1 }, 100, 3);
  assert.ok(Math.abs(cur.glow - 1) < 1e-9);
  easeToward(cur, { glow: 0.5 }, 0, 3); // dt 0: no change
  assert.ok(Math.abs(cur.glow - 1) < 1e-9);
});
