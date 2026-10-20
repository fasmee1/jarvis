'use strict';
// Local coding voice commands (รันเทสต์ / รันเช็ก / ดู diff / ยกเลิกการแก้ล่าสุด),
// their on-screen reports, and project context (CLAUDE.md hint, "about you" profile).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SettingsStore } = require('../lib/settings');
const { JarvisCore } = require('../lib/jarvis-core');
const { buildSystemPrompt } = require('../lib/prompt');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cv-'));
const load = (async () => ({
  cmd: await import('../renderer/handsfree/commands.js'),
  rep: await import('../renderer/ui/code-report.js'),
}))();

function mkCore(settingsDir = tmp()) {
  const events = [];
  const core = new JarvisCore({ settings: new SettingsStore(settingsDir), tempDir: tmp(), ui: (k, d) => events.push([k, d]), appRoot: tmp(), logDir: tmp() });
  core.warm = () => {};
  return { core, events };
}

test('voice: coding commands are local, longer requests still go to Claude', async () => {
  const { parseCommand } = (await load).cmd;
  const op = (t, ctx) => { const c = parseCommand(t, ctx); return c && c.action === 'code' ? c.op : null; };
  for (const t of ['รันเทสต์', 'จาร์วิส รันเทสต์หน่อยครับ', 'ช่วยรันเทสให้หน่อย', 'Run the tests.', 'รันเทสต์อีกรอบ']) assert.strictEqual(op(t), 'test', t);
  for (const t of ['รันเช็ก', 'รันเช็ค', 'ตรวจโค้ด', 'run lint']) assert.strictEqual(op(t), 'check', t);
  for (const t of ['ดู diff ล่าสุด', 'ดูดิฟ', 'แก้อะไรไปบ้าง', 'show the diff']) assert.strictEqual(op(t), 'diff', t);
  for (const t of ['ยกเลิกการแก้ล่าสุด', 'ย้อนการแก้เมื่อกี้', 'undo last change']) assert.strictEqual(op(t), 'undo', t);
  // the Result Viewer being open doesn't change them
  assert.strictEqual(op('ดูดิฟ', { viewer: true }), 'diff');
  for (const t of ['ทดสอบ', 'ทดสอบ ทดสอบ', 'ยกเลิก', 'รันเทสต์แล้วแก้ให้ผ่าน', 'เขียนเทสต์ให้ฟังก์ชันนี้']) assert.strictEqual(op(t), null, t);
  assert.deepStrictEqual(parseCommand('ย้อนกลับ', { viewer: true }), { action: 'viewer', op: 'prev' });
});

test('report: test results read and spoken in Thai', async () => {
  const { checkReport } = (await load).rep;
  const base = { kind: 'test', command: 'npm test', exitCode: 0, durationMs: 4200, error: '', tail: '# pass 12', cancelled: false, timedOut: false };
  const ok = checkReport({ ...base, ok: true, counts: { passed: 12, failed: 0 } });
  assert.strictEqual(ok.speak, 'เทสต์ผ่านทั้งหมด 12 ข้อครับ');
  assert.match(ok.line, /✅ npm test: ผ่าน \(ผ่าน 12 · ไม่ผ่าน 0\) · 4 วินาที/);
  const bad = checkReport({ ...base, ok: false, exitCode: 1, counts: { passed: 10, failed: 2 }, error: 'not ok 3 - adds', tail: 'a\n```\nb' });
  assert.strictEqual(bad.speak, 'เทสต์ไม่ผ่าน 2 ข้อ จาก 12 ข้อ ดูรายละเอียดบนจอครับ');
  assert.match(bad.markdown, /not ok 3 - adds/);
  assert.strictEqual(bad.markdown.split('\n').filter((l) => l === '```').length, 2, 'output cannot close the code fence');
  assert.strictEqual(checkReport({ ...base, kind: 'check', command: 'npm run check', ok: false, exitCode: 2, counts: null }).speak, 'เช็กไม่ผ่าน ดูรายละเอียดบนจอครับ');
  assert.strictEqual(checkReport({ ...base, ok: false, cancelled: true, counts: null }).speak, 'หยุดรันเทสต์แล้วครับ');
});

test('report: diff summary, table and empty case', async () => {
  const { diffReport, undoLines } = (await load).rep;
  const d = diffReport({ scope: 'turn', files: [{ file: 'a|b.js', add: 3, del: 1 }, { file: 'img.png', add: null, del: null }], created: ['new.js'], patch: 'diff --git a/x b/x\n+y\n', truncated: false, add: 3, del: 1 });
  assert.strictEqual(d.speak, 'แก้ 2 ไฟล์ เพิ่ม 3 บรรทัด ลบ 1 บรรทัด สร้างไฟล์ใหม่ 1 ไฟล์ ดูบนจอครับ');
  assert.match(d.markdown, /\| a\\\|b\.js \| 3 \| 1 \|/);
  assert.match(d.markdown, /\| img\.png \| bin \| bin \|/);
  assert.strictEqual(diffReport({ scope: 'uncommitted', files: [], created: [], patch: '', add: 0, del: 0 }).empty, true);
  const lines = undoLines({ restore: ['a.js'], remove: ['b.js', 'c.js'], headMoved: true });
  assert.deepStrictEqual(lines.map((l) => l.split(' ')[0]), ['คืนค่า', 'ย้ายไฟล์ที่สร้างใหม่', 'มีการ']);
});

test('core: local test run is reported to Claude with the next message', async () => {
  const proj = tmp();
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(\'not ok 1 - math\');process.exit(1)"' } }));
  const { core, events } = mkCore();
  core.setCwd(proj);
  assert.deepStrictEqual(core.snapshot().checks.test, { command: 'npm test' });
  const r = await core.runCheck('test');
  assert.strictEqual(r.ok, false);
  assert.ok(events.some(([k, d]) => k === 'terminal' && /not ok 1/.test(d.text)));
  const sent = [];
  core.ensureSession = () => ({ busy: false });
  core._startTurn = (content) => { sent.push(content.at(-1).text); return 't'; };
  core.send({ text: 'แก้ให้ผ่าน' });
  assert.match(sent[0], /\[JARVIS: ผู้ใช้สั่งรัน npm test เองในเครื่อง — ไม่ผ่าน \(exit 1\) ท้าย output:\n[\s\S]*not ok 1 - math\]/);
  core.send({ text: 'ต่อ' });
  assert.strictEqual(sent[1], 'ต่อ'); // said once

  core.session = { busy: true };
  await assert.rejects(core.runCheck('test'), /รอให้ JARVIS ทำงานรอบนี้เสร็จก่อน/);
  assert.throws(() => core.undoPreview(), /รอให้ JARVIS/);
});

test('core: each turn saves an undo point; undo tells Claude what changed', async () => {
  const proj = tmp();
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: proj, windowsHide: true });
  g('init', '-q');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(proj, 'a.js'), '1\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  const { core } = mkCore();
  core.setCwd(proj);
  core.session = { send: () => 't', busy: false, dispose() {} };
  core._makePipeline = () => null;
  core._startTurn([], { t0: Date.now() });
  fs.writeFileSync(path.join(proj, 'a.js'), '2\n'); // what Claude did in that turn
  core.session.busy = false;
  const p = core.undoPreview();
  assert.deepStrictEqual(p.restore, ['a.js']);
  core.tools.trash = (f) => fs.rmSync(f);
  const r = await core.undoApply(p.token);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(proj, 'a.js'), 'utf8'), '1\n');
  assert.match(core.codeNotes[0], /ผู้ใช้ย้อนการแก้ไฟล์ของงานล่าสุดกลับแล้ว — คืนค่า: a\.js/);
  // a new project forgets the old one's undo points
  core.setCwd(tmp());
  assert.strictEqual(core.tools.snapshots.length, 0);
  assert.deepStrictEqual(core.codeNotes, []);
});

test('project context: CLAUDE.md is detected; the profile reaches the system prompt and the open session', () => {
  const proj = tmp();
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  const { core } = mkCore();
  core.setCwd(proj);
  assert.strictEqual(core.snapshot().isCodeProject, true);
  assert.strictEqual(core.snapshot().hasClaudeMd, false);
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'CLAUDE.md'), '# x');
  assert.strictEqual(core.snapshot().hasClaudeMd, true);

  assert.ok(!buildSystemPrompt().includes('ข้อมูลเกี่ยวกับผู้ใช้'));
  assert.match(buildSystemPrompt({ profile: '  เขียน Python เป็นหลัก ' }), /ข้อมูลเกี่ยวกับผู้ใช้[^\n]*\nเขียน Python เป็นหลัก\n\n/);
  assert.strictEqual(core.settings.update({ userProfile: 'x'.repeat(2001) }).ok, false);
  assert.strictEqual(core.settings.update({ userProfile: 'ชอบคำตอบสั้น' }).ok, true);
  core.onSettingsChanged(['userProfile']);
  core.nodeCmd = { command: 'node', env: {} };
  assert.ok(core.argsFor(null).some((a) => a.includes('ชอบคำตอบสั้น')));
  const sent = [];
  core.ensureSession = () => ({ busy: false });
  core._startTurn = (content) => { sent.push(content.at(-1).text); return 't'; };
  core.codingModeDirty = false;
  core.send({ text: 'สวัสดี' });
  assert.strictEqual(sent[0], '[JARVIS: ข้อมูลเกี่ยวกับผู้ใช้ (อัปเดตแล้ว) — ชอบคำตอบสั้น]\nสวัสดี');
  core.newSession({ silent: true });
  assert.strictEqual(core.profileDirty, false); // the new conversation has it in its system prompt
});
