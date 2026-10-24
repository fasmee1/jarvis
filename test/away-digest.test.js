'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AwayDigest, digestText } = require('../lib/away-digest');

const st = (o) => ({ projectId: 'p-1', name: 'เว็บร้าน', status: 'done', filesChanged: 0, ...o });

test('spoken lines: finished, failed and waiting are spoken once; running and stopped are silent', () => {
  const d = new AwayDigest();
  assert.strictEqual(d.record(st({ status: 'running' })), null);
  assert.strictEqual(d.record(st({ status: 'done', filesChanged: 3 })), 'โปรเจกต์ เว็บร้าน เสร็จแล้วครับ แก้ 3 ไฟล์');
  assert.strictEqual(d.record(st({ status: 'done', filesChanged: 3 })), null, 'the same status again is not repeated');
  assert.match(d.record(st({ projectId: 'p-2', name: 'API', status: 'error', error: 'npm test ล้ม\nบรรทัดสอง' })), /^โปรเจกต์ API ติดครับ npm test ล้ม บรรทัดสอง$/);
  assert.strictEqual(d.record(st({ projectId: 'p-3', name: 'บอท', status: 'awaiting-approval' })), 'โปรเจกต์ บอท รอให้คุณตัดสินใจครับ');
  assert.strictEqual(d.record(st({ projectId: 'p-3', status: 'awaiting-approval' })), null, 'a todo update while waiting is silent');
  assert.strictEqual(d.record(st({ projectId: 'p-4', status: 'stopped' })), null);
  assert.strictEqual(d.record(null), null);
});

test('digest on return: only after being away long enough, counts by outcome, then cleared', () => {
  const d = new AwayDigest({ minAwayMs: 1000 });
  d.record(st({ projectId: 'a', status: 'done' }));
  d.record(st({ projectId: 'b', status: 'done' }));
  d.record(st({ projectId: 'c', status: 'error', error: 'ติด' }));
  d.record(st({ projectId: 'd', status: 'awaiting-approval' }));
  d.away(10_000);
  d.away(10_500); // a second blur does not restart the clock
  const r = d.back(12_000);
  assert.deepStrictEqual([r.done, r.error, r.waiting, r.awayMs], [2, 1, 1, 2000]);
  assert.strictEqual(r.text, 'ระหว่างที่คุณไม่อยู่ ทำเสร็จ 2 งาน ติด 1 งาน รอคุณตัดสินใจ 1 งาน');
  assert.strictEqual(r.items.length, 4);
  d.away(20_000);
  assert.strictEqual(d.back(30_000), null, 'nothing new since the last summary');
});

test('no digest for a short absence, with nothing to report, or without a blur', () => {
  const d = new AwayDigest({ minAwayMs: 5000 });
  d.record(st({ status: 'done' }));
  d.away(0);
  assert.strictEqual(d.back(1000), null, 'too short');
  assert.strictEqual(d.back(99_000), null, 'never left');
  d.away(100_000);
  assert.ok(d.back(110_000), 'the finished task is still unseen');
  const e = new AwayDigest({ minAwayMs: 0 });
  e.away(0);
  assert.strictEqual(e.back(10), null);
});

test('a project that starts again, is removed, or was looked at drops out of the summary', () => {
  const d = new AwayDigest({ minAwayMs: 0 });
  d.record(st({ projectId: 'a', status: 'done' }));
  d.record(st({ projectId: 'a', status: 'running' }));
  d.record(st({ projectId: 'b', status: 'done' }));
  d.record(st({ projectId: 'b', status: 'removed' }));
  d.record(st({ projectId: 'c', status: 'done' }));
  d.seen();
  d.away(0);
  assert.strictEqual(d.back(100), null);
  assert.strictEqual(digestText({ done: 0, error: 0, waiting: 0 }), '');
});
