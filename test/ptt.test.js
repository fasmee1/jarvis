'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PttTracker, parseAccelerator } = require('../lib/ptt');
const { UiohookKey } = require('uiohook-napi');

const K = UiohookKey;

test('parseAccelerator maps modifiers and the main key', () => {
  assert.deepEqual(parseAccelerator('Control+Space', K), { mods: ['ctrl'], key: K.Space });
  assert.deepEqual(parseAccelerator('ctrl+shift+f9', K), { mods: ['ctrl', 'shift'], key: K.F9 });
  assert.equal(parseAccelerator('Control+Nope', K), null);
  assert.equal(parseAccelerator('A+B', K), null);
  assert.equal(parseAccelerator('Control', K), null);
  assert.equal(parseAccelerator('', K), null);
});

test('hold: down on combo, up when the main key is released', () => {
  const t = new PttTracker('Control+Space', K);
  assert.equal(t.feed('down', K.Ctrl), null);
  assert.equal(t.feed('down', K.Space), 'down');
  assert.equal(t.feed('down', K.Space), null, 'auto-repeat is ignored');
  assert.equal(t.feed('up', K.Space), 'up');
  assert.equal(t.feed('up', K.Ctrl), null);
});

test('hold ends when a required modifier is released first', () => {
  const t = new PttTracker('Control+Space', K);
  t.feed('down', K.Ctrl);
  t.feed('down', K.Space);
  assert.equal(t.feed('up', K.Ctrl), 'up');
  assert.equal(t.feed('up', K.Space), null);
});

test('extra or missing modifiers do not trigger', () => {
  const t = new PttTracker('Control+Space', K);
  assert.equal(t.feed('down', K.Space), null, 'no Ctrl');
  t.feed('up', K.Space);
  t.feed('down', K.Ctrl);
  t.feed('down', K.Shift);
  assert.equal(t.feed('down', K.Space), null, 'Ctrl+Shift+Space is another combo');
});

test('right-hand modifiers count and other keys are ignored', () => {
  const t = new PttTracker('Control+Space', K);
  assert.equal(t.feed('down', K.CtrlRight), null);
  assert.equal(t.feed('down', K.A), null);
  assert.equal(t.feed('down', K.Space), 'down');
});

test('reset closes an open hold', () => {
  const t = new PttTracker('F9', K);
  assert.equal(t.feed('down', K.F9), 'down');
  assert.equal(t.reset(), 'up');
  assert.equal(t.reset(), null);
});

test('invalid accelerator gives an inert tracker', () => {
  const t = new PttTracker('Bogus+Key', K);
  assert.equal(t.valid, false);
  assert.equal(t.feed('down', K.Space), null);
});
