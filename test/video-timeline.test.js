'use strict';
const test = require('node:test');
const assert = require('node:assert');

let T;
test.before(async () => {
  T = await import('../renderer/ui/video-timeline.js');
});

// s1: two pieces with a cut between them (2..5 removed), the second at 2× speed; then s2.
const clips = [
  { id: 'c1', src: 's1', in: 0, out: 2, speed: 1 },
  { id: 'c2', src: 's1', in: 5, out: 9, speed: 2 },
  { id: 'c3', src: 's2', in: 1, out: 4, speed: 1 },
];
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('layout and total length', () => {
  assert.deepStrictEqual(T.layout(clips).map((r) => [r.start, r.end]), [[0, 2], [2, 4], [4, 7]]);
  assert.strictEqual(T.totalLength(clips), 7);
  assert.deepStrictEqual(T.layout([]), []);
});

test('locate: timeline time → clip and source time, cuts skipped, speed applied', () => {
  assert.deepStrictEqual([T.locate(clips, 1).index, T.locate(clips, 1).sourceTime], [0, 1]);
  const b = T.locate(clips, 2); // exactly at a boundary: the later clip
  assert.deepStrictEqual([b.index, b.sourceTime], [1, 5]);
  assert.ok(near(T.locate(clips, 3).sourceTime, 7)); // 1 s into a 2× clip = 2 s of source
  assert.deepStrictEqual([T.locate(clips, 4.5).index, T.locate(clips, 4.5).sourceTime], [2, 1.5]);
  const end = T.locate(clips, 99);
  assert.deepStrictEqual([end.index, end.sourceTime, end.atEnd], [2, 4, true]);
  assert.strictEqual(T.locate(clips, -3).sourceTime, 0);
  assert.strictEqual(T.locate([], 1), null);
});

test('timelineTime is the inverse of locate', () => {
  for (const t of [0, 0.5, 2, 3.25, 4, 6.9]) {
    const l = T.locate(clips, t);
    assert.ok(near(T.timelineTime(clips, l.index, l.sourceTime), t), `t=${t}`);
  }
  assert.strictEqual(T.timelineTime(clips, 1, 100), 4); // clamped to the clip
  assert.strictEqual(T.timelineTime(clips, 9, 1), 0);
});

test('mapRanges: silences and speech follow cuts and speed', () => {
  const ranges = [
    { start: 1, end: 3, text: 'a' }, // half in c1, half cut away
    { start: 4, end: 6, text: 'b' }, // half cut away, half in c2 (2×)
    { start: 10, end: 12, text: 'c' }, // after the last piece of s1: gone
  ];
  assert.deepStrictEqual(T.mapRanges(clips, 's1', ranges), [{ start: 1, end: 2, text: 'a' }, { start: 2, end: 2.5, text: 'b' }]);
  assert.deepStrictEqual(T.mapRanges(clips, 's2', [{ start: 0, end: 2 }]), [{ start: 4, end: 5 }]);
  assert.deepStrictEqual(T.mapRanges(clips, 's9', ranges), []);
  // the same source used twice shows its range twice
  const twice = [{ id: 'a', src: 's1', in: 0, out: 4, speed: 1 }, { id: 'b', src: 's1', in: 0, out: 4, speed: 1 }];
  assert.deepStrictEqual(T.mapRanges(twice, 's1', [{ start: 1, end: 2 }]), [{ start: 1, end: 2 }, { start: 5, end: 6 }]);
});

test('fmtTime', () => {
  assert.strictEqual(T.fmtTime(0), '0:00.0');
  assert.strictEqual(T.fmtTime(83.25), '1:23.2');
  assert.strictEqual(T.fmtTime(59.99), '0:59.9');
  assert.strictEqual(T.fmtTime(3725), '1:02:05.0');
  assert.strictEqual(T.fmtTime(-4), '0:00.0');
  assert.strictEqual(T.fmtTime(NaN), '0:00.0');
  assert.strictEqual(T.fmtTime(0.3), '0:00.3');
});

test('ruler ticks keep labels apart; zoom fits; frame step', () => {
  const a = T.ticks(20, 40); // 40 px/s, 70 px gap → 2 s steps
  assert.strictEqual(a.step, 2);
  assert.strictEqual(a.list.length, 11);
  assert.deepStrictEqual(a.list.slice(0, 3).map((k) => k.t), [0, 2, 4]);
  assert.strictEqual(T.ticks(1, 1000).step, 0.1);
  assert.ok(T.ticks(36000, 0.01).list.length <= 5001);
  assert.deepStrictEqual(T.ticks(0, 40).list, []);
  assert.strictEqual(T.fitZoom(20, 800), 40);
  assert.strictEqual(T.fitZoom(1, 800), 400);
  assert.strictEqual(T.fitZoom(0, 800), 40);
  assert.ok(near(T.frameStep(25), 0.04));
  assert.ok(near(T.frameStep(null), 1 / 30));
});
