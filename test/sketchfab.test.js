'use strict';
// Sketchfab model source (lib/model3d) with a fake fetch and a fake unzip.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sketchfab } = require('../lib/model3d/sketchfab');
const { BlockExtractor } = require('../lib/blocks/extractor');

const UID = 'a'.repeat(32);
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function setup(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-sf-'));
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, auth: opts.headers && opts.headers.Authorization });
    return handler(url, opts);
  };
  const extract = async (zip, to) => fs.writeFileSync(path.join(to, 'scene.gltf'), '{}');
  const sf = new Sketchfab({ getToken: () => 'tok', modelsDir: dir, fetchFn, extract });
  return { sf, dir, calls };
}

const searchHit = { uid: UID, name: 'Sports car', user: { displayName: 'Ann' }, license: { label: 'CC Attribution' }, viewerUrl: `https://sketchfab.com/3d-models/car-${UID}`, isDownloadable: true };

test('sketchfab: search maps hits and drops bad uids', async () => {
  const { sf } = setup(() => json({ results: [searchHit, { uid: 'bad', name: 'x' }] }));
  const hits = await sf.search('car');
  assert.strictEqual(hits.length, 1);
  assert.deepStrictEqual([hits[0].name, hits[0].author, hits[0].license], ['Sports car', 'Ann', 'CC Attribution']);
});

test('sketchfab: search drops unrelated hits and ranks title matches first', async () => {
  const hit = (c, name, tags = []) => ({ uid: c.repeat(32), name, tags: tags.map((t) => ({ name: t })), isDownloadable: true });
  const { sf } = setup(() => json({ results: [
    hit('1', 'A Road Trip In 2016 - Whale class transport', ['transport', 'road']),
    hit('2', 'Old harbor crane', ['port', 'cruise']), // one of two words in tags only: not related
    hit('3', 'Boat', ['cruise', 'ship']), // every word in tags: related, lower score
    hit('4', 'Luxury Cruise Ship', []),
  ] }));
  const names = (await sf.search('cruise ship')).map((h) => h.name);
  assert.deepStrictEqual(names, ['Luxury Cruise Ship', 'Boat']);
});

test('sketchfab: no token is a readable error', async () => {
  const sf = new Sketchfab({ getToken: () => '', modelsDir: os.tmpdir(), fetchFn: async () => json({}) });
  await assert.rejects(sf.search('car'), (err) => err.code === 'NO_TOKEN' && /token/.test(err.message));
});

test('sketchfab: 401 with Token scheme retries with Bearer', async () => {
  const { sf, calls } = setup((url, opts) => (opts.headers.Authorization.startsWith('Token') ? json({}, 401) : json({ results: [] })));
  await sf.search('car');
  assert.deepStrictEqual(calls.map((c) => c.auth), ['Token tok', 'Bearer tok']);
});

test('sketchfab: fetchModel downloads, extracts and returns a model result with credit', async () => {
  const { sf, dir } = setup((url) => {
    if (url.includes('/search')) return json({ results: [searchHit] });
    if (url.endsWith('/download')) return json({ gltf: { url: 'https://cdn.example/m.zip', size: 10 } });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) };
  });
  const r = await sf.fetchModel('sports car');
  assert.strictEqual(r.type, 'model');
  assert.strictEqual(r.glb, `app://jarvis/models/${UID}/scene.gltf`);
  assert.match(r.credit, /Ann/);
  assert.match(r.credit, /CC Attribution/);
  assert.ok(fs.existsSync(path.join(dir, UID, 'scene.gltf')));
  assert.ok(!fs.existsSync(path.join(dir, `${UID}.zip`)));
});

test('sketchfab: no glTF in the download response is skipped, then reported', async () => {
  const { sf } = setup((url) => (url.includes('/search') ? json({ results: [searchHit] }) : json({ usdz: { url: 'https://x' } })));
  await assert.rejects(sf.fetchModel('car'), /glTF/);
});

test('sketchfab: download refuses a malformed uid', async () => {
  const { sf } = setup(() => json({}));
  await assert.rejects(sf.download('../etc'), /รหัส/);
});

test('model-search block validates and rejects an empty query', () => {
  const items = [];
  const ex = new BlockExtractor((i) => items.push(i));
  ex.push('```jarvis-model-search\n{"query":"robot dog"}\n```\n```jarvis-model-search\n{}\n```\n');
  ex.end();
  assert.strictEqual(items.filter((i) => i.type === 'block' && i.kind === 'model-search').length, 1);
  assert.strictEqual(items.filter((i) => i.type === 'block-error').length, 1);
});
