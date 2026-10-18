'use strict';
// Manual end-to-end check against the REAL Claude Code CLI (uses your login and
// a little quota; model haiku). Not part of `npm test`.
//   node scripts/integration-real.js
// Verifies: persistent stream-json session, permission MCP → HUD approval,
// "always allow" rule file, guard hook deny in bypassPermissions, guard "ask"
// routed to the HUD, jarvis block extraction, TTS segments, audit log.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JarvisCore } = require('../lib/jarvis-core');
const { SettingsStore } = require('../lib/settings');

const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-it-'));
const proj = path.join(work, 'proj');
fs.mkdirSync(proj);
const settings = new SettingsStore(path.join(work, 'userdata'));
settings.update({ model: 'haiku', approvalTimeoutSec: 60 });

const events = [];
let onApproval = null;
let resolveTurn = null;
const ui = (ch, p) => {
  events.push([ch, p]);
  if (ch === 'approval:request' && onApproval) setTimeout(() => onApproval(p), 50);
  if (ch === 'turn:result' && resolveTurn) resolveTurn(p);
  if (ch === 'error') console.log('  [error]', p.code, p.message);
};

const core = new JarvisCore({ settings, tempDir: path.join(work, 'tmp'), ui, appRoot: root, logDir: work });

function turn(text) {
  events.length = 0;
  return new Promise((resolve) => {
    resolveTurn = resolve;
    core.send({ text, t0: Date.now() });
  });
}

const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
};

(async () => {
  await core.init();
  core.setCwd(proj);


  const only = process.argv[2]; // e.g. "bom" to run one step
  const step = (name) => !only || only === name;
  let asked = [];
  let r;

  if (step('write')) {
    // 1. Write needs approval → approve "always" → file exists + rule saved.
    onApproval = (req) => {
      asked.push(req.tool);
      core.respondApproval({ id: req.id, decision: 'always' });
    };
    r = await turn('Use the Write tool to create hello.txt containing exactly: hi. Then say done in Thai, one short sentence.');
    check('approval requested for Write', asked.includes('Write'), asked.join(','));
    check('file written after approval', fs.existsSync(path.join(proj, 'hello.txt')));
    const local = path.join(proj, '.claude', 'settings.local.json');
    check('always-allow rule saved', fs.existsSync(local) && fs.readFileSync(local, 'utf8').includes('Edit(./hello.txt)'));
    check('latency t2 recorded', !!(r.latency && r.latency.t2), `t2−t0 ${r.latency.t2 - r.latency.t0} ms`);
    check('tts segments emitted', events.some(([c]) => c === 'tts:segment'));
  }

  if (step('deny')) {
    // 2. Deny with reason → permission_denials reported.
    asked = [];
    onApproval = (req) => {
      asked.push(req.tool);
      core.respondApproval({ id: req.id, decision: 'deny-reason', reason: 'ไม่ต้องสร้างไฟล์นี้' });
    };
    r = await turn('Use the Write tool to create other.txt containing x. If denied, do not retry; just say so briefly.');
    check('denied file not created', !fs.existsSync(path.join(proj, 'other.txt')));
    check('denials reported in result', r.denials.length > 0, JSON.stringify(r.denials));
  }

  if (step('bom')) {
    // 3. jarvis block extraction from a real answer.
    onApproval = (req) => core.respondApproval({ id: req.id, decision: 'deny' });
    r = await turn('Reply with one short Thai sentence, then a ```jarvis-bom block containing JSON {"items":[{"name":"LED","qty":2}]} and nothing else. Do not use tools.');
    const items = events.filter(([c]) => c === 'chat:item').map(([, p]) => p);
    const ok = items.some((p) => p.type === 'block' && p.kind === 'bom' && p.data.items[0].qty === 2);
    check('jarvis-bom block parsed', ok, ok ? '' : JSON.stringify(items.filter((p) => p.type !== 'text')).slice(0, 600));
    const spoken = events.filter(([c]) => c === 'tts:segment').map(([, p]) => p.text).join(' ');
    check('block JSON not spoken', !spoken.includes('{') && !spoken.includes('qty'), spoken);
  }

  if (step('upload')) {
    // 4. Guard "ask" for firmware upload goes to the HUD even for an allowed tool.
    asked = [];
    onApproval = (req) => {
      asked.push(`${req.kind}:${req.tool}`);
      core.respondApproval({ id: req.id, decision: 'deny' });
    };
    r = await turn('Run this exact shell command with the Bash tool: arduino-cli upload -p COM99 --fqbn arduino:avr:uno . — if it is denied, just say so briefly.');
    check('upload command asked on screen via guard', asked.some((a) => a.startsWith('guard:')), asked.join(','));
  }

  if (step('bypass')) {
    // 5. bypassPermissions: the guard hook still blocks listed commands.
    const m = core.setPermissionMode('bypassPermissions', 'ยืนยัน');
    check('bypass enabled with confirmation', m.ok);
    settings.update({ guardBlock: [...settings.get().guardBlock, 'JARVIS_GUARD_TEST'] });
    core.onSettingsChanged(['guardBlock']);
    r = await turn('Run this exact shell command with the Bash tool: echo JARVIS_GUARD_TEST — then report the tool result briefly. Do not retry.');
    const res = events.filter(([c, p]) => c === 'activity' && p.kind === 'tool-result');
    check('guard blocks in bypass mode', res.some(([, p]) => /JARVIS guard/.test(p.text)), res.map(([, p]) => p.text.slice(0, 100)).join(' | '));
    core.newSession({ silent: true });
    check('new session resets bypass → default', settings.get().permissionMode === 'default');
  }

  if (step('latency')) {
    // 6. Cold start vs pre-warmed process: time to first text delta.
    const t2 = async () => (await turn('ตอบสั้น ๆ ว่า พร้อมครับ')).latency;
    core.newSession({ silent: true });
    core.session && core.session.dispose();
    core.session = null;
    const cold = await t2();
    core.newSession({ silent: true }); // warms in the background
    await new Promise((res) => setTimeout(res, 12000)); // user "still talking"
    const warm = await t2();
    const second = await t2();
    check('pre-warmed first answer is faster than cold start', warm.t2 - warm.t0 < cold.t2 - cold.t0,
      `cold ${cold.t2 - cold.t0} ms · warm ${warm.t2 - warm.t0} ms · next turn ${second.t2 - second.t0} ms`);
  }

  if (!only) {
    // 7. Audit log.
    const audit = path.join(proj, '.jarvis', 'audit.log');
    const lines = fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n') : [];
    check('audit log written', lines.length >= 4, `${lines.length} lines`);
  }

  core.cleanup();
  console.log('work dir:', work);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
