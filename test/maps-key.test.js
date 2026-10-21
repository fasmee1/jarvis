'use strict';
// Google Maps key store for the optional Google Earth 3D map.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MapsKey } = require('../lib/maps-key');

test('maps key: ion token uses its own env var and file', () => {
  const k = new MapsKey({ dataDir: os.tmpdir(), kind: 'ion' });
  assert.strictEqual(k.env, 'CESIUM_ION_TOKEN');
  assert.ok(k.file.endsWith('cesium-ion.key'));
  assert.throws(() => new MapsKey({ dataDir: os.tmpdir(), kind: 'x' }));
});

test('maps key: env var wins, empty set removes the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-maps-'));
  const k = new MapsKey({ dataDir: dir });
  const prev = process.env.GOOGLE_MAPS_API_KEY;
  try {
    delete process.env.GOOGLE_MAPS_API_KEY;
    assert.strictEqual(k.get(), '');
    process.env.GOOGLE_MAPS_API_KEY = 'AIza-test';
    assert.strictEqual(k.get(), 'AIza-test');
    fs.writeFileSync(k.file, 'x');
    k.set('');
    assert.ok(!fs.existsSync(k.file));
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
