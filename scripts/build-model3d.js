'use strict';
// Bundles the orbit model viewer (three.js) into renderer/ui/vendor/model3d.min.js.
//   node scripts/build-model3d.js
const path = require('path');
const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'model3d', 'entry.js')],
  outfile: path.join(__dirname, '..', 'renderer', 'ui', 'vendor', 'model3d.min.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'chrome130',
  legalComments: 'eof',
  logLevel: 'info',
});
