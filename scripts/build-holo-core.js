'use strict';
// Bundles the calm style holographic core (three.js) into renderer/ui/vendor/holo-core.min.js.
//   node scripts/build-holo-core.js
const path = require('path');
const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'holo-core', 'entry.js')],
  outfile: path.join(__dirname, '..', 'renderer', 'ui', 'vendor', 'holo-core.min.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'chrome130',
  legalComments: 'eof',
  logLevel: 'info',
});
