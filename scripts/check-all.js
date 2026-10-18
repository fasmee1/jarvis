'use strict';
// Runs `node --check` on every project .js/.mjs file (outside node_modules).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(c|m)?js$/.test(e.name)) files.push(full);
  }
})(root);

// Node 24 silently accepts syntax errors in .js files that use ESM syntax
// (module-type detection), so ES modules are checked as a temporary .mjs copy.
const os = require('os');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-check-'));
const isEsm = (src) => /^\s*(import\s[^(]|export\s)/m.test(src);

let failed = 0;
for (const f of files) {
  let target = f;
  if (f.endsWith('.js') && isEsm(fs.readFileSync(f, 'utf8'))) {
    target = path.join(tmpDir, path.basename(f, '.js') + '-' + files.indexOf(f) + '.mjs');
    fs.copyFileSync(f, target);
  }
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✕ ${path.relative(root, f)}\n${r.stderr}`);
  }
}
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`node --check: ${files.length - failed}/${files.length} ok`);
process.exit(failed ? 1 : 0);
