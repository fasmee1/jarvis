'use strict';
// Picture -> GLB converter (lib/model3d/image-to-3d) with a fake Gradio client; nothing leaves the machine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ImageTo3d } = require('../lib/model3d/image-to-3d');
const { BlockExtractor } = require('../lib/blocks/extractor');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-i23d-'));
const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(32)]);

function make(overrides = {}) {
  const dir = tmp();
  const calls = [];
  const connect = async () => ({
    predict: async (ep, payload) => {
      calls.push([ep, payload]);
      if (ep === '/preprocess_image') return { data: [{ path: 'p.png', url: 'https://x/p.png' }] };
      if (ep === '/generate_and_extract_glb') return { data: [null, { url: 'https://x/a.glb' }, { url: 'https://x/b.glb' }] };
      return { data: [] };
    },
    close: () => calls.push(['close']),
  });
  const fetchFn = async () => ({ ok: true, status: 200, arrayBuffer: async () => glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length) });
  const t = new ImageTo3d({ modelsDir: dir, connect, handleFile: async (p) => ({ path: p }), fetchFn, ...overrides });
  const img = path.join(dir, 'pic.jpg');
  fs.writeFileSync(img, 'x');
  return { t, dir, img, calls };
}

test('image-to-3d: runs the three Space calls in order and saves a GLB', async () => {
  const { t, dir, img, calls } = make();
  const r = await t.convert(img, { title: 'Me' });
  assert.deepStrictEqual(calls.map((c) => c[0]), ['/start_session', '/preprocess_image', '/generate_and_extract_glb', 'close']);
  assert.strictEqual(calls[2][1].image.url, 'https://x/p.png'); // the cleaned image feeds the generator
  assert.strictEqual(r.type, 'model');
  const id = r.glb.match(/^app:\/\/jarvis\/models\/([0-9a-f]{16})\/model\.glb$/)[1];
  assert.ok(fs.readFileSync(path.join(dir, id, 'model.glb')).slice(0, 4).toString() === 'glTF');
  assert.match(r.credit, /TRELLIS/);
});

test('image-to-3d: rejects non-images, relative paths, missing and oversize files', () => {
  const { dir, img } = make();
  assert.ok(ImageTo3d.checkImage(img));
  assert.throws(() => ImageTo3d.checkImage('pic.jpg'), /เต็ม/);
  assert.throws(() => ImageTo3d.checkImage(path.join(dir, 'a.txt')), /jpg/);
  assert.throws(() => ImageTo3d.checkImage(path.join(dir, 'none.png')), /ไม่พบ/);
  const big = path.join(dir, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.throws(() => ImageTo3d.checkImage(big), /10 MB/);
});

test('image-to-3d: a non-GLB download is refused and nothing is kept', async () => {
  const { t, dir, img } = make({ fetchFn: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) }) });
  await assert.rejects(t.convert(img), /ไม่ใช่ GLB/);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f !== 'pic.jpg'), []);
});

test('image-to-3d: a quota error becomes a readable message and the client is closed', async () => {
  const calls = [];
  const connect = async () => ({ predict: async () => { throw new Error('ZeroGPU quota exceeded'); }, close: () => calls.push('close') });
  const { t, img } = make({ connect });
  await assert.rejects(t.convert(img), /โควตา/);
  assert.deepStrictEqual(calls, ['close']);
});

test('image-to-3d block validates', () => {
  const items = [];
  const ex = new BlockExtractor((i) => items.push(i));
  ex.push('```jarvis-image-to-3d\n{"path":"C:/a/b.jpg"}\n```\n```jarvis-image-to-3d\n{}\n```\n');
  ex.end();
  assert.strictEqual(items.filter((i) => i.type === 'block' && i.kind === 'image-to-3d').length, 1);
  assert.strictEqual(items.filter((i) => i.type === 'block-error').length, 1);
});
