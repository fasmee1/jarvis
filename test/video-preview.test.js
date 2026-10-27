'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fxm = require('../lib/video/effects');

const load = () => import('../renderer/ui/video-preview.js');
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not near ${b}`);

test('preview: durations are the ones the render uses', async () => {
  const { IN_DUR, OUT_DUR } = await load();
  for (const [id, x] of Object.entries(fxm.FX)) if (id !== 'none') assert.strictEqual(IN_DUR[id], x.dur, `in ${id}`);
  for (const [id, x] of Object.entries(fxm.FX_OUT)) if (id !== 'none') assert.strictEqual(OUT_DUR[id], x.dur, `out ${id}`);
  assert.deepStrictEqual(Object.keys(IN_DUR).sort(), Object.keys(fxm.FX).filter((k) => k !== 'none').sort());
  assert.deepStrictEqual(Object.keys(OUT_DUR).sort(), Object.keys(fxm.FX_OUT).filter((k) => k !== 'none').sort());
});

test('preview: easing starts and ends where the tween does', async () => {
  const { out1, out2, out3, in2, backOut } = await load();
  for (const f of [out1, out2, out3, in2, backOut(2), backOut(1.6)]) { near(f(0), 0); near(f(1), 1); }
  assert.ok(backOut(2)(0.6) > 1, 'back overshoots');
});

test('preview: how the picture looks coming in and going out', async () => {
  const { clipFxState } = await load();
  const plain = clipFxState({}, 1, 5);
  assert.deepStrictEqual(plain, { opacity: 1, scale: 1, x: 0, blur: 0, flash: 0 });
  assert.strictEqual(clipFxState({ fx: 'fade' }, 0, 5).opacity, 0);
  near(clipFxState({ fx: 'fade' }, 0.2, 5).opacity, 0.5);
  assert.strictEqual(clipFxState({ fx: 'fade' }, 0.4, 5).opacity, 1);
  near(clipFxState({ fx: 'zoom' }, 0, 5).scale, 1.2);
  near(clipFxState({ fx: 'zoom' }, 0.5, 5).scale, 1);
  near(clipFxState({ fx: 'slide' }, 0, 5).x, 14);
  near(clipFxState({ fx: 'blur' }, 0, 5).blur, 26);
  near(clipFxState({ fx: 'flash' }, 0, 5).flash, 0.95);
  assert.strictEqual(clipFxState({ fx: 'flash' }, 0.31, 5).flash, 0);
  near(clipFxState({ fxOut: 'fade' }, 5, 5).opacity, 0);
  near(clipFxState({ fxOut: 'fade' }, 4.8, 5).opacity, 0.5);
  assert.strictEqual(clipFxState({ fxOut: 'fade' }, 4, 5).opacity, 1);
  near(clipFxState({ fxOut: 'zoom' }, 5, 5).scale, 1.15);
  const both = clipFxState({ fx: 'fade', fxOut: 'fade' }, 0.1, 0.3);
  assert.ok(both.opacity < 0.3, 'in and out fade together on a very short clip');
  assert.deepStrictEqual(clipFxState({ fx: 'explode', fxOut: 'nope' }, 1, 5), plain, 'unknown ids change nothing');
});

test('preview: overlays appear, move, and go', async () => {
  const { overlayState } = await load();
  const title = { kind: 'title', text: 'x', start: 1, end: 4 };
  assert.strictEqual(overlayState(title, 0.9), null);
  assert.strictEqual(overlayState(title, 4.1), null);
  assert.strictEqual(overlayState(title, 1).opacity, 0);
  near(overlayState(title, 1.45).scale, 1);
  assert.strictEqual(overlayState(title, 2.5).opacity, 1);
  assert.ok(overlayState(title, 3.9).opacity < 0.5, 'fading out at the end');
  const lower = { kind: 'lower', text: 'a', text2: 'b', start: 0, end: 3 };
  near(overlayState(lower, 0).x, -90);
  near(overlayState(lower, 1).x, 0);
  const counter = { kind: 'counter', from: 0, to: 12500, suffix: '+', start: 0, end: 4 };
  assert.strictEqual(overlayState(counter, 0.1).text, '0+');
  assert.strictEqual(overlayState(counter, 3).text, '12,500+');
  const mid = overlayState(counter, 1).text;
  assert.ok(/^\d{1,2},?\d{3}\+$|^\d{1,3}\+$/.test(mid) && mid !== '12,500+' && mid !== '0+', mid);
  const negative = { kind: 'counter', from: 100, to: 0, suffix: '', start: 0, end: 4 };
  assert.strictEqual(overlayState(negative, 3).text, '0', 'counts down too');
});

test('preview: the subtitle line at a time', async () => {
  const { captionAt, captionPop } = await load();
  const caps = [{ start: 0, end: 1, text: 'a' }, { start: 1.5, end: 2, text: 'b' }];
  assert.strictEqual(captionAt(caps, 0.5).text, 'a');
  assert.strictEqual(captionAt(caps, 1.2), null);
  assert.strictEqual(captionAt(caps, 1), null, 'the end is exclusive');
  assert.strictEqual(captionAt(caps, 1.5).text, 'b');
  assert.strictEqual(captionAt(undefined, 1), null);
  near(captionPop(caps[0], 0.1), 0.5);
  assert.strictEqual(captionPop(caps[0], 0.9), 1);
});

test('preview: when each sound starts, and which ones playing passes', async () => {
  const { buildCues, cuesBetween } = await load();
  const rows = [
    { clip: { id: 'c1', sfx: 'none' }, start: 0, end: 4 },
    { clip: { id: 'c2', sfx: 'whoosh' }, start: 4, end: 8 },
    { clip: { id: 'c3', sfx: 'dl-aaaaaaaa' }, start: 8, end: 12 },
    { clip: { id: 'c4', sfx: 'ding' }, start: 12, end: 14 },
  ];
  const sounds = { whoosh: { url: 'u/w', lead: 0.12 }, 'dl-aaaaaaaa': { url: 'u/d', lead: 0 }, ding: { url: '', lead: 0 } };
  const overlays = [{ id: 'o1', start: 0.5, sfx: 'whoosh' }, { id: 'o2', start: 2, sfx: 'missing' }, { id: 'o3', start: 1, sfx: 'none' }];
  const cues = buildCues(rows, overlays, sounds);
  assert.deepStrictEqual(cues.map((c) => [c.at, c.id]), [[0.38, 'whoosh'], [3.88, 'whoosh'], [8, 'dl-aaaaaaaa']], 'no url or unknown id = no sound; the lead moves it before the cut');
  assert.deepStrictEqual(cuesBetween(cues, 3.8, 3.9).map((c) => c.at), [3.88]);
  assert.deepStrictEqual(cuesBetween(cues, 3.88, 3.95), [], 'the start of the range is exclusive: no double play');
  assert.deepStrictEqual(cuesBetween(cues, 3.0, 8.5), [], 'a jump is a seek, not playing');
  assert.deepStrictEqual(cuesBetween(cues, 3.95, 3.8), []);
  assert.deepStrictEqual(buildCues([{ clip: { sfx: 'whoosh' }, start: 0.05, end: 1 }], [], sounds).map((c) => c.at), [0], 'never before time 0');
});
