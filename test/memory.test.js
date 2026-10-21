'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryStore, MAX_ITEMS, MAX_TEXT, MAX_RENDER } = require('../lib/memory');
const { buildSystemPrompt } = require('../lib/prompt');
const { BlockExtractor } = require('../lib/blocks/extractor');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem-'));

test('memory: add, dedupe, forget, persist', () => {
  const dir = tmp();
  const m = new MemoryStore(dir);
  assert.equal(m.add('ชอบให้ตอบสั้น ๆ'), true);
  assert.equal(m.add('ชอบให้ตอบสั้น ๆ'), false);
  assert.equal(m.add('  '), false);
  m.add('บอร์ดที่ใช้คือ ESP32');
  assert.equal(new MemoryStore(dir).list().length, 2);
  assert.equal(m.forget('esp32'), 1);
  assert.deepEqual(new MemoryStore(dir).list(), ['ชอบให้ตอบสั้น ๆ']);
  assert.equal(m.forget(''), 0);
});

test('memory: size limits keep the token cost bounded', () => {
  const m = new MemoryStore(null);
  for (let i = 0; i < MAX_ITEMS + 10; i++) m.add(`ข้อ ${i} ` + 'ก'.repeat(500));
  assert.equal(m.list().length, MAX_ITEMS);
  assert.ok(m.list().every((t) => t.length <= MAX_TEXT));
  assert.ok(m.render().length <= MAX_RENDER);
  assert.match(m.render(), /ข้อ 29/); // newest kept
  assert.doesNotMatch(m.render(), /ข้อ 0 /);
});

test('memory: version bumps only on a real change; corrupt file starts empty', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'memory.json'), '{not json');
  const m = new MemoryStore(dir);
  assert.equal(m.list().length, 0);
  const v = m.version;
  m.add('a');
  assert.equal(m.version, v + 1);
  m.add('a');
  m.forget('zzz');
  assert.equal(m.version, v + 1);
  assert.equal(m.apply({ add: ['b'], forget: ['a'] }), true);
  assert.deepEqual(m.list(), ['b']);
});

test('memory: system prompt carries the memory only when there is some', () => {
  assert.doesNotMatch(buildSystemPrompt(), /ความจำระยะยาว:/);
  assert.match(buildSystemPrompt({ memory: '- ชอบตอบสั้น' }), /ความจำระยะยาว:\n- ชอบตอบสั้น/);
  assert.match(buildSystemPrompt(), /jarvis-memory/);
});

test('memory: a jarvis-memory block passes the schema', () => {
  const items = [];
  const ex = new BlockExtractor((i) => items.push(i));
  ex.push('จำแล้ว\n```jarvis-memory\n{"add":["ชอบตอบสั้น"],"forget":["เก่า"]}\n```\n');
  ex.end();
  const b = items.find((i) => i.type === 'block');
  assert.equal(b.kind, 'memory');
  assert.deepEqual(b.data.add, ['ชอบตอบสั้น']);
});
