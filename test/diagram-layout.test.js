'use strict';
// Layout for flowchart / DFD / ER diagrams, and the jarvis-flow / jarvis-er block schemas.
const test = require('node:test');
const assert = require('node:assert');
const { validate } = require('../lib/blocks/validate');
const { SCHEMAS, PROTOCOL_DOC } = require('../lib/blocks/schemas');

const load = () => import('../renderer/ui/diagram-layout.js');
const box = (id, w = 100, h = 40) => ({ id, w, h });

test('layout: chain goes down one layer per step, branches share a layer', async () => {
  const { layoutGraph } = await load();
  const nodes = ['a', 'b', 'c', 'd'].map((id) => box(id));
  const r = layoutGraph(nodes, [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }], 'TB');
  assert.deepStrictEqual(r.layers.map((l) => l.length), [1, 2, 1]);
  assert.ok(r.pos.get('a').y < r.pos.get('b').y && r.pos.get('b').y === r.pos.get('c').y && r.pos.get('c').y < r.pos.get('d').y);
  assert.notStrictEqual(r.pos.get('b').x, r.pos.get('c').x);
  for (const p of r.pos.values()) assert.ok(p.x >= 0 && p.y >= 0 && p.x + 100 <= r.width && p.y + 40 <= r.height);
});

test('layout: LR direction swaps the axes', async () => {
  const { layoutGraph } = await load();
  const r = layoutGraph([box('a'), box('b')], [{ from: 'a', to: 'b' }], 'LR');
  assert.ok(r.pos.get('a').x < r.pos.get('b').x);
  assert.strictEqual(r.pos.get('a').y, r.pos.get('b').y);
});

test('layout: cycles, self loops, duplicates and unknown ids do not hang or crash', async () => {
  const { layoutGraph } = await load();
  const r = layoutGraph([box('a'), box('b'), box('c')], [
    { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' },
    { from: 'a', to: 'a' }, { from: 'a', to: 'b' }, { from: 'a', to: 'zzz' },
  ]);
  assert.strictEqual(r.pos.size, 3);
  assert.deepStrictEqual(r.layers.map((l) => l.length), [1, 1, 1]);
  assert.deepStrictEqual(layoutGraph([], []).layers, []);
});

test('layout: unconnected nodes still get a place, no two boxes overlap', async () => {
  const { layoutGraph } = await load();
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => box(id));
  const r = layoutGraph(nodes, [{ from: 'a', to: 'b' }]);
  const ps = [...r.pos.values()];
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const hit = ps[i].x < ps[j].x + 100 && ps[j].x < ps[i].x + 100 && ps[i].y < ps[j].y + 40 && ps[j].y < ps[i].y + 40;
      assert.strictEqual(hit, false);
    }
  }
});

test('borderPoint: leaves the box edge, diamonds use their slanted edge', async () => {
  const { borderPoint } = await load();
  const n = { w: 100, h: 40 };
  const p = { x: 0, y: 0 };
  assert.deepStrictEqual(borderPoint(n, p, { x: 250, y: 20 }), { x: 100, y: 20 });
  assert.deepStrictEqual(borderPoint(n, p, { x: 50, y: 200 }), { x: 50, y: 40 });
  assert.deepStrictEqual(borderPoint(n, p, { x: 250, y: 20 }, true), { x: 100, y: 20 });
  const d = borderPoint(n, p, { x: 100, y: 60 }, true);
  assert.ok(Math.abs(d.x - 66.667) < 0.01 && Math.abs(d.y - 33.333) < 0.01); // on the slanted edge, not the box corner
});

test('label sizing: Thai text wraps and the box grows', async () => {
  const { textSize, wrapLabel } = await load();
  const short = textSize('เริ่ม');
  const long = textSize('ลูกค้าเลือกบริการและเวลาที่ต้องการจองคิวร้านตัดผม');
  assert.ok(long.w > short.w && long.h > short.h);
  const lines = wrapLabel('ลูกค้าเลือกบริการและเวลาที่ต้องการจองคิวร้านตัดผม', 120);
  assert.ok(lines.length > 1 && lines.every((l) => [...l].length <= 15));
  assert.strictEqual(lines.join(''), 'ลูกค้าเลือกบริการและเวลาที่ต้องการจองคิวร้านตัดผม');
});

test('jarvis-flow schema accepts flowchart and DFD, rejects bad shapes', () => {
  const ok = { type: 'dfd', direction: 'LR', nodes: [{ id: 'u', label: 'ลูกค้า', shape: 'external' }, { id: 'p', label: 'จองคิว', shape: 'process' }], edges: [{ from: 'u', to: 'p', label: 'คำขอจอง' }] };
  assert.deepStrictEqual(validate(SCHEMAS.flow, ok), []);
  assert.ok(validate(SCHEMAS.flow, { nodes: [{ id: 'a', label: 'x', shape: 'blob' }] }).length);
  assert.ok(validate(SCHEMAS.flow, { type: 'mindmap', nodes: [{ id: 'a', label: 'x' }] }).length);
  assert.ok(validate(SCHEMAS.flow, { nodes: [] }).length);
});

test('jarvis-er schema accepts entities with keys and cardinality, rejects bad ones', () => {
  const ok = {
    entities: [{ id: 'user', name: 'ลูกค้า', fields: [{ name: 'id', type: 'int', key: 'pk' }, { name: 'ชื่อ' }] }, { id: 'booking', name: 'การจอง', fields: [{ name: 'user_id', key: 'fk' }] }],
    relations: [{ from: 'user', to: 'booking', label: 'จอง', fromCard: '1', toCard: '0..N' }],
  };
  assert.deepStrictEqual(validate(SCHEMAS.er, ok), []);
  assert.ok(validate(SCHEMAS.er, { entities: [{ id: 'a', name: 'x', fields: [{ name: 'f', key: 'uk' }] }] }).length);
  assert.ok(validate(SCHEMAS.er, { entities: [{ id: 'a', name: 'x' }], relations: [{ from: 'a', to: 'a', toCard: 'many' }] }).length);
});

test('protocol doc and planning prompt mention the new blocks', () => {
  const { PLANNING_MODE_PROMPT } = require('../lib/prompt');
  assert.match(PROTOCOL_DOC, /jarvis-flow/);
  assert.match(PROTOCOL_DOC, /jarvis-er/);
  assert.match(PLANNING_MODE_PROMPT, /jarvis-flow/);
  assert.match(PLANNING_MODE_PROMPT, /jarvis-er/);
  assert.match(PLANNING_MODE_PROMPT, /docs\/02-tech-stack\.md/);
  // design, build and open-to-view phases
  assert.match(PLANNING_MODE_PROMPT, /DESIGN\.md/);
  assert.match(PLANNING_MODE_PROMPT, /ขั้นพัฒนาระบบ/);
  assert.match(PLANNING_MODE_PROMPT, /http:\/\/localhost/);
  assert.match(PLANNING_MODE_PROMPT, /ห้ามทำ git commit/);
});
