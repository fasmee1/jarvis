'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { BlockExtractor } = require('../lib/blocks/extractor');
const { SpeechSegmenter } = require('../lib/tts/segmenter');
const { cleanForSpeech } = require('../lib/tts/clean');

function run(chunks) {
  const items = [];
  const x = new BlockExtractor((i) => items.push(i));
  for (const c of chunks) x.push(c);
  x.end();
  return items;
}

const text = (items) => items.filter((i) => i.type === 'text').map((i) => i.text).join('');

test('extracts a jarvis-steps block streamed char by char; prose outside stays text', () => {
  const src = 'เริ่มกันเลยครับ\n```jarvis-steps\n{"steps":[{"title":"ต่อสาย"},{"title":"อัปโหลด"}]}\n```\nแสดงบนจอแล้วครับ';
  const items = run([...src]);
  const blocks = items.filter((i) => i.type === 'block');
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, 'steps');
  assert.strictEqual(blocks[0].data.steps[1].title, 'อัปโหลด');
  assert.strictEqual(text(items), 'เริ่มกันเลยครับ\nแสดงบนจอแล้วครับ');
  assert.ok(!text(items).includes('{'));
});

test('emits prose before the line is finished (low latency)', () => {
  const items = [];
  const x = new BlockExtractor((i) => items.push(i));
  x.push('สวัสดีครับ วันนี้');
  assert.strictEqual(text(items), 'สวัสดีครับ วันนี้');
});

test('holds a possible fence opener until the line completes', () => {
  const items = [];
  const x = new BlockExtractor((i) => items.push(i));
  x.push('``');
  assert.strictEqual(items.length, 0);
  x.push('`jarvis-arduino\nvoid setup(){}\n');
  assert.strictEqual(items.length, 0);
  x.push('```\n');
  assert.strictEqual(items[0].type, 'block');
  assert.strictEqual(items[0].code, 'void setup(){}');
});

test('inline backticks in prose are not fences', () => {
  const items = run(['ใช้คำสั่ง `arduino-cli` ครับ\n']);
  assert.strictEqual(text(items), 'ใช้คำสั่ง `arduino-cli` ครับ\n');
});

test('a jarvis fence that starts mid-line is still extracted', () => {
  const items = run([...'ได้เลยครับ```jarvis-bom\n{"items":[{"name":"LED","qty":2}]}\n```\nเสร็จแล้ว']);
  assert.strictEqual(items.find((i) => i.type === 'block').data.items[0].qty, 2);
  assert.strictEqual(text(items), 'ได้เลยครับ\nเสร็จแล้ว');
});

test('closing fence at the very end of the message (no newline) closes the block', () => {
  const items = run(['ได้ครับ\n```jarvis-bom\n{"items":[{"name":"LED","qty":2}]}\n```']);
  assert.strictEqual(items.find((i) => i.type === 'block').kind, 'bom');
  assert.ok(!items.some((i) => i.type === 'block-error'));
});

test('prose is coalesced into one item per push', () => {
  const items = [];
  const x = new BlockExtractor((i) => items.push(i));
  x.push('สวัสดีครับ ยินดีต้อนรับ');
  x.push(' สู่ JARVIS\nบรรทัดสอง');
  assert.strictEqual(items.length, 2);
});

test('invalid block JSON / schema becomes block-error, not a crash', () => {
  const items = run(['```jarvis-bom\n{"items":[{"name":"LED"}]}\n```\n', '```jarvis-steps\n{oops\n```\n', '```jarvis-nope\n{}\n```\n']);
  const errs = items.filter((i) => i.type === 'block-error');
  assert.strictEqual(errs.length, 3);
  assert.match(errs[0].error, /qty/);
});

test('ordinary code fences are display-only code items', () => {
  const items = run(['ดูโค้ดนี้\n```python\nprint(1)\n```\n']);
  assert.deepStrictEqual(items.find((i) => i.type === 'code'), { type: 'code', lang: 'python', code: 'print(1)' });
  assert.strictEqual(text(items), 'ดูโค้ดนี้\n');
});

test('unclosed jarvis block at end is reported', () => {
  const items = run(['```jarvis-diagram\n{"nodes":[]']);
  assert.strictEqual(items[0].type, 'block-error');
});

test('segmenter cuts at sentence marks, newlines and long Thai runs', () => {
  const segs = [];
  const s = new SpeechSegmenter((x) => segs.push(x), { softLimit: 20 });
  s.push('Hello there. ');
  assert.deepStrictEqual(segs, ['Hello there.']);
  s.push('ข้อความภาษาไทยยาวมากไม่มีจุดเลย ต่อไปอีกนิด');
  assert.strictEqual(segs.length, 2);
  s.push('\nบรรทัดใหม่');
  s.flush();
  assert.deepStrictEqual(segs.slice(-2), ['ต่อไปอีกนิด', 'บรรทัดใหม่']);
});

test('segmenter does not split decimals like 3.5', () => {
  const segs = [];
  const s = new SpeechSegmenter((x) => segs.push(x));
  s.push('ใช้ไฟ 3.5 โวลต์');
  s.flush();
  assert.deepStrictEqual(segs, ['ใช้ไฟ 3.5 โวลต์']);
});

test('cleanForSpeech strips markdown, URLs, JSON, tables, emoji', () => {
  assert.strictEqual(cleanForSpeech('**สำคัญ** ดูที่ https://example.com นะครับ 🚀'), 'สำคัญ ดูที่ นะครับ');
  assert.strictEqual(cleanForSpeech('## หัวข้อ\n- ข้อแรก\n| a | b |\n|---|---|'), 'หัวข้อ ข้อแรก');
  assert.strictEqual(cleanForSpeech('{"steps":[1,2]}'), '');
  assert.strictEqual(cleanForSpeech('[ลิงก์](http://x.y) และ `code`'), 'ลิงก์ และ code');
});
