'use strict';
// Bundles the optional Google Earth 3D map (three.js + 3d-tiles-renderer) into
// renderer/ui/vendor/earth3d.min.js and copies the Draco decoder next to it.
//   node scripts/build-earth3d.js
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'renderer', 'ui', 'vendor');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'earth3d', 'entry.js')],
  outfile: path.join(vendor, 'earth3d.min.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'chrome130',
  legalComments: 'eof',
  logLevel: 'info',
});

const dracoSrc = path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco');
const dracoDst = path.join(vendor, 'draco');
fs.mkdirSync(dracoDst, { recursive: true });
for (const f of ['draco_decoder.wasm', 'draco_wasm_wrapper.js']) fs.copyFileSync(path.join(dracoSrc, f), path.join(dracoDst, f));
console.log('draco decoder →', path.relative(root, dracoDst));
