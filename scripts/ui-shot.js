'use strict';
// Dev helper: launch the app, optionally run a page script, capture a screenshot.
//   node scripts/ui-shot.js <out.png> [delayMs] [pageScript] [cwd]
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const [out, delay = '5000', script = '', cwd = ''] = process.argv.slice(2);
if (!out) {
  console.error('usage: node scripts/ui-shot.js <out.png> [delayMs] [pageScript] [cwd]');
  process.exit(2);
}
const electron = require(path.join(__dirname, '..', 'node_modules', 'electron'));
const env = { ...process.env, JARVIS_SCREENSHOT: path.resolve(out), JARVIS_SCREENSHOT_QUIT: '1', JARVIS_SCREENSHOT_DELAY: delay };
delete env.ELECTRON_RUN_AS_NODE;
if (script) env.JARVIS_SCREENSHOT_SCRIPT = script;
else delete env.JARVIS_SCREENSHOT_SCRIPT;
if (cwd) env.JARVIS_START_CWD = cwd;
try { fs.unlinkSync(out); } catch { /* none */ }
const t0 = Date.now();
const p = spawn(electron, [path.join(__dirname, '..')], { env, stdio: 'ignore' });
const kill = setTimeout(() => { p.kill(); console.log('timeout — killed'); }, Number(delay) + 30000);
p.on('exit', (code) => {
  clearTimeout(kill);
  const log = out.replace(/\.png$/i, '') + '.console.log';
  console.log(`exit ${code} after ${((Date.now() - t0) / 1000).toFixed(1)}s · screenshot ${fs.existsSync(out) ? 'OK' : 'MISSING'}`);
  if (fs.existsSync(log)) process.stdout.write(fs.readFileSync(log, 'utf8').split('\n').filter((l) => /error|warn|ERR/i.test(l)).slice(0, 15).join('\n'));
});
