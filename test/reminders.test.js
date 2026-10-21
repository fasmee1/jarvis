'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReminderStore, timeToEpoch, MAX_REMINDERS } = require('../lib/reminders');
const { BlockExtractor } = require('../lib/blocks/extractor');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rem-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('reminders: HH:MM means the next such moment, an explicit past date is refused', () => {
  const now = new Date(2026, 9, 21, 10, 0, 0).getTime();
  assert.equal(timeToEpoch('11:30', null, now), new Date(2026, 9, 21, 11, 30).getTime());
  assert.equal(timeToEpoch('09:00', null, now), new Date(2026, 9, 22, 9, 0).getTime());
  assert.equal(timeToEpoch('09:00', '2026-10-25', now), new Date(2026, 9, 25, 9, 0).getTime());
  assert.ok(Number.isNaN(timeToEpoch('09:00', '2026-10-01', now)));
  assert.ok(Number.isNaN(timeToEpoch('25:00', null, now)));
  assert.ok(Number.isNaN(timeToEpoch('abc', null, now)));
});

test('reminders: add validates, sorts, persists and cancels', () => {
  const dir = tmp();
  let t = 1_000_000;
  const r = new ReminderStore({ dir, now: () => t });
  assert.equal(r.add({ text: '', inSeconds: 5 }), null);
  assert.equal(r.add({ text: 'x' }), null);
  assert.equal(r.add({ text: 'x', inSeconds: -1 }), null);
  r.add({ text: 'ซักผ้า', inSeconds: 600 });
  r.add({ text: 'โทรหาแม่', inSeconds: 60 });
  assert.deepEqual(r.list().map((x) => x.text), ['โทรหาแม่', 'ซักผ้า']);
  assert.equal(new ReminderStore({ dir, now: () => t }).list().length, 2);
  assert.equal(r.cancel('ซัก'), 1);
  assert.equal(r.cancel(''), 0);
  assert.equal(r.list().length, 1);
  r.stop();
});

test('reminders: the list is capped', () => {
  const r = new ReminderStore({ now: () => 0 });
  for (let i = 0; i < MAX_REMINDERS + 5; i++) r.add({ text: `n${i}`, inSeconds: 60 + i });
  assert.equal(r.list().length, MAX_REMINDERS);
  r.stop();
});

test('reminders: fires when due, once, and marks one that came due while the app was closed as late', async () => {
  const fired = [];
  const r = new ReminderStore({ onDue: (x) => fired.push(x) });
  r.add({ text: 'เร็ว', inSeconds: 0.05 });
  await wait(150);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].text, 'เร็ว');
  assert.equal(fired[0].late, false);
  assert.equal(r.list().length, 0);

  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'reminders.json'), JSON.stringify([{ id: 'a', text: 'เก่า', at: Date.now() - 3600 * 1000 }]));
  const late = [];
  const r2 = new ReminderStore({ dir, onDue: (x) => late.push(x) });
  r2.start();
  assert.equal(late.length, 1);
  assert.equal(late[0].late, true);
  r.stop();
  r2.stop();
});

test('reminders: a throwing onDue does not block the other reminders', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'reminders.json'), JSON.stringify([
    { id: 'a', text: 'หนึ่ง', at: 1 }, { id: 'b', text: 'สอง', at: 2 },
  ]));
  const seen = [];
  const r = new ReminderStore({ dir, onDue: (x) => { seen.push(x.text); throw new Error('boom'); } });
  r.start();
  assert.deepEqual(seen, ['หนึ่ง', 'สอง']);
});

test('reminders: a jarvis-reminder block passes the schema and applies', () => {
  const items = [];
  const ex = new BlockExtractor((i) => items.push(i));
  ex.push('ตั้งแล้ว\n```jarvis-reminder\n{"add":[{"text":"ประชุม","time":"14:30"},{"text":"พักสายตา","inSeconds":1200}],"cancel":["เก่า"]}\n```\n');
  ex.end();
  const b = items.find((i) => i.type === 'block');
  assert.equal(b.kind, 'reminder');
  const r = new ReminderStore({ now: () => new Date(2026, 9, 21, 10, 0).getTime() });
  assert.equal(r.apply(b.data), 2);
  assert.equal(r.list().length, 2);
  r.stop();
});
