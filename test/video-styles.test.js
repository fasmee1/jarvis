'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StyleStore, cleanStyle, MAX_CUSTOM } = require('../lib/video/styles');
const { BUILTIN_STYLES } = require('../lib/video/presets');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-styles-')), 'video', 'styles.json');
const mine = { name: '  รีวิวอาหาร  ', prompt: 'เปิดด้วยจานที่น่ากินที่สุด\r\nตัดช่วงเคี้ยวเงียบ ๆ ออก', pace: 'normal', targetSec: 45 };

test('cleanStyle: trims and checks every field', () => {
  assert.deepStrictEqual(cleanStyle(mine), { name: 'รีวิวอาหาร', prompt: 'เปิดด้วยจานที่น่ากินที่สุด\nตัดช่วงเคี้ยวเงียบ ๆ ออก', pace: 'normal', targetSec: 45 });
  assert.strictEqual(cleanStyle({ ...mine, targetSec: '' }).targetSec, 0);
  assert.strictEqual(cleanStyle({ ...mine, targetSec: undefined }).targetSec, 0);
  assert.throws(() => cleanStyle(null), /ไม่ถูกต้อง/);
  assert.throws(() => cleanStyle({ ...mine, name: '   ' }), /ชื่อแนว/);
  assert.throws(() => cleanStyle({ ...mine, name: 'ก'.repeat(41) }), /ไม่เกิน 40/);
  assert.throws(() => cleanStyle({ ...mine, prompt: '' }), /คำอธิบาย/);
  assert.throws(() => cleanStyle({ ...mine, prompt: 'ก'.repeat(2001) }), /ไม่เกิน 2000/);
  assert.throws(() => cleanStyle({ ...mine, pace: 'turbo' }), /จังหวะ/);
  assert.throws(() => cleanStyle({ ...mine, pace: 'constructor' }), /จังหวะ/);
  assert.throws(() => cleanStyle({ ...mine, targetSec: -1 }), /ความยาว/);
  assert.throws(() => cleanStyle({ ...mine, targetSec: 1.5 }), /ความยาว/);
  assert.throws(() => cleanStyle({ ...mine, targetSec: 601 }), /ความยาว/);
  assert.throws(() => cleanStyle({ ...mine, name: 7 }), /ชื่อแนว/);
});

test('store: starts with the four built-ins, nothing written yet', () => {
  const file = tmpFile();
  const s = new StyleStore({ file });
  assert.deepStrictEqual(s.list().map((x) => [x.id, x.builtin, x.edited]), BUILTIN_STYLES.map((b) => [b.id, true, false]));
  assert.strictEqual(s.last().id, 'viral');
  assert.ok(!fs.existsSync(file));
});

test('store: add, change, remove own styles; saved to disk and read back', () => {
  const file = tmpFile();
  const s = new StyleStore({ file });
  const added = s.save(mine);
  assert.match(added.id, /^u[0-9a-f]{8}$/);
  assert.strictEqual(added.name, 'รีวิวอาหาร');
  assert.strictEqual(added.builtin, false);
  const changed = s.save({ ...mine, id: added.id, name: 'รีวิวร้านอาหาร', pace: 'fast' });
  assert.deepStrictEqual([changed.id, changed.name, changed.pace], [added.id, 'รีวิวร้านอาหาร', 'fast']);
  s.setLast(added.id);
  const again = new StyleStore({ file });
  assert.strictEqual(again.list().length, 5);
  assert.strictEqual(again.last().id, added.id);
  again.remove(added.id);
  assert.strictEqual(again.list().length, 4);
  assert.strictEqual(again.last().id, 'viral'); // the picked style was deleted
  assert.throws(() => again.remove(added.id), /ไม่พบ/);
  assert.throws(() => again.save({ ...mine, id: 'u00000000' }), /ไม่พบ/);
  assert.throws(() => again.setLast('nope'), /ไม่พบ/);
});

test('store: built-ins can be edited and reset, not deleted', () => {
  const s = new StyleStore({ file: tmpFile() });
  const e = s.save({ ...mine, id: 'vlog' });
  assert.deepStrictEqual([e.id, e.name, e.builtin, e.edited], ['vlog', 'รีวิวอาหาร', true, true]);
  assert.throws(() => s.remove('vlog'), /ลบไม่ได้/);
  const r = s.reset('vlog');
  assert.deepStrictEqual([r.name, r.edited], ['วล็อกชิล', false]);
  assert.throws(() => s.reset('u12345678'), /เฉพาะแนวสำเร็จรูป/);
});

test('store: limit on own styles', () => {
  const s = new StyleStore({ file: tmpFile() });
  for (let i = 0; i < MAX_CUSTOM; i++) s.save({ ...mine, name: `แนว ${i}` });
  assert.throws(() => s.save(mine), /ไม่เกิน 50/);
});

test('store: a broken or hand-edited file keeps only valid entries', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.strictEqual(new StyleStore({ file }).list().length, 4);
  fs.writeFileSync(file, JSON.stringify({
    custom: [
      { id: 'u0000000a', ...mine },
      { id: '../evil', ...mine },
      { id: 'u0000000b', name: '', prompt: 'x', pace: 'fast' },
      { id: 'u0000000c', ...mine, pace: 'warp' },
    ],
    overrides: { promo: { ...mine, name: 'ขายของ' }, notabuiltin: mine, vlog: { name: 'x' } },
    last: 'u0000000a',
  }));
  const s = new StyleStore({ file });
  assert.deepStrictEqual(s.list().filter((x) => !x.builtin).map((x) => x.id), ['u0000000a']);
  assert.strictEqual(s.get('promo').name, 'ขายของ');
  assert.strictEqual(s.get('vlog').name, 'วล็อกชิล');
  assert.strictEqual(s.last().id, 'u0000000a');
});

test('renderer: target length as words', async () => {
  const { fmtTarget } = await import('../renderer/ui/video-styles.js');
  assert.strictEqual(fmtTarget(0), 'ไม่จำกัดความยาว');
  assert.strictEqual(fmtTarget(30), 'ไม่เกิน 30 วินาที');
  assert.strictEqual(fmtTarget(60), 'ไม่เกิน 1 นาที');
  assert.strictEqual(fmtTarget(90), 'ไม่เกิน 1 นาที 30 วินาที');
  assert.strictEqual(fmtTarget('x'), 'ไม่จำกัดความยาว');
});
