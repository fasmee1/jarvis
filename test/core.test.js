'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SettingsStore, sanitize } = require('../lib/settings');
const { resolveClaudeCommand, cliJsForCmd } = require('../lib/claude/resolve');
const { lineDiff } = require('../lib/diff');
const { validate } = require('../lib/blocks/validate');
const { SCHEMAS } = require('../lib/blocks/schemas');
const { pcm16ToWav, rms } = require('../lib/stt/wav');
const { v } = require('../lib/ipc-validate');
const { toolSummary } = require('../lib/jarvis-core');
const { ClaudeSession } = require('../lib/claude/session');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-core-'));

test('bypassPermissions needs the typed confirmation and is never persisted', () => {
  const dir = tmp();
  const s = new SettingsStore(dir);
  assert.strictEqual(s.update({ permissionMode: 'bypassPermissions' }).ok, false);
  assert.strictEqual(s.setPermissionMode('bypassPermissions', 'yes').ok, false);
  assert.strictEqual(s.setPermissionMode('bypassPermissions', 'ยืนยัน').ok, true);
  assert.strictEqual(s.get().permissionMode, 'bypassPermissions');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.strictEqual(saved.permissionMode, 'default');
  assert.strictEqual(new SettingsStore(dir).get().permissionMode, 'default');
});

test('settings sanitize rejects unknown keys and bad types', () => {
  assert.strictEqual(sanitize({ nope: 1 }).ok, false);
  assert.strictEqual(sanitize({ approvalTimeoutSec: 5 }).ok, false);
  assert.strictEqual(sanitize({ approvalTimeoutSec: 120, sfx: false }).ok, true);
  assert.strictEqual(sanitize({ mcpConfigPaths: [1] }).ok, false);
});

test('resolveClaudeCommand: .exe runs directly, .cmd shim runs cli.js via node (not Electron)', () => {
  const dir = tmp();
  const exe = path.join(dir, 'claude.exe');
  fs.writeFileSync(exe, '');
  assert.deepStrictEqual(resolveClaudeCommand({ customPath: exe }).prefixArgs, []);

  const npmDir = path.join(dir, 'npm');
  const cli = path.join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '');
  const cmd = path.join(npmDir, 'claude.cmd');
  fs.writeFileSync(cmd, '@"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*');
  assert.strictEqual(cliJsForCmd(cmd), cli);
  const nodeDir = path.join(dir, 'nodebin');
  fs.mkdirSync(nodeDir);
  const fakeNode = path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.writeFileSync(fakeNode, '');
  const r = resolveClaudeCommand({ customPath: cmd, env: { PATH: nodeDir } });
  assert.strictEqual(r.command, fakeNode);
  assert.deepStrictEqual(r.prefixArgs, [cli]);
  assert.notStrictEqual(r.command, process.execPath);

  assert.throws(() => resolveClaudeCommand({ customPath: path.join(dir, 'missing.exe') }), (e) => e.code === 'CLAUDE_NOT_FOUND');
});

test('lineDiff marks added and removed lines', () => {
  const d = lineDiff('a\nb\nc', 'a\nB\nc');
  assert.deepStrictEqual(d.filter((x) => x.op !== ' '), [{ op: '-', line: 'b' }, { op: '+', line: 'B' }]);
});

test('schemas validate good and bad block data', () => {
  assert.deepStrictEqual(validate(SCHEMAS.steps, { steps: [{ title: 'a' }], current: 1 }), []);
  assert.ok(validate(SCHEMAS.steps, { steps: [] }).length);
  assert.ok(validate(SCHEMAS.diagram, { nodes: [{ id: 'a' }] }).length);
  assert.deepStrictEqual(validate(SCHEMAS.bom, { items: [{ name: 'LED', qty: 2 }] }), []);
});

test('WAV encoding and RMS', () => {
  const pcm = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) pcm.writeInt16LE(i % 2 ? 16000 : -16000, i * 2);
  const wav = pcm16ToWav(pcm);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(24), 16000);
  assert.strictEqual(wav.length, 44 + 3200);
  assert.ok(rms(pcm) > 0.4);
  assert.strictEqual(rms(Buffer.alloc(100)), 0);
});

test('IPC validators reject oversized and wrong-typed input', () => {
  assert.throws(() => v.str('x'.repeat(11), 10));
  assert.throws(() => v.str(5, 10));
  assert.throws(() => v.obj([]));
  assert.throws(() => v.bytes(new ArrayBuffer(20), 10));
  assert.strictEqual(v.bytes(new Uint8Array(4).buffer, 10).length, 4);
  assert.throws(() => v.oneOf('x', ['a']));
});

test('toolSummary describes tools in Thai', () => {
  assert.match(toolSummary('Bash', { command: 'arduino-cli compile .' }), /กำลังรัน Bash: arduino-cli compile/);
  assert.match(toolSummary('Edit', { file_path: 'a.ino' }), /แก้ไฟล์ a.ino/);
});

// A fake "claude" that speaks stream-json, to test ClaudeSession end to end.
const FAKE = `
let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);const m=JSON.parse(l);
const text=typeof m.message.content==='string'?m.message.content:m.message.content.map(c=>c.text||'').join('');
const o=e=>process.stdout.write(JSON.stringify(e)+'\\n');
o({type:'system',subtype:'init',session_id:'S1',mcp_servers:[{name:'jarvis',status:'connected'}],slash_commands:['cost']});
if(text==='hang'){return;}
o({type:'stream_event',event:{type:'message_start',message:{id:'m1'}}});
const reply='ตอบ:'+text;
// split a line mid-way to exercise buffering
const line=JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:reply}}})+'\\n';
process.stdout.write(line.slice(0,7));setTimeout(()=>{process.stdout.write(line.slice(7));
o({type:'assistant',message:{id:'m1',content:[{type:'text',text:reply}]}});
o({type:'assistant',message:{id:'m2',content:[{type:'tool_use',id:'t1',name:'Bash',input:{command:'echo hi'}}]}});
o({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'hi'}]},tool_result_meta:[{id:'t1',permission_decision:{decision:'accept'}}]});
o({type:'result',subtype:'success',is_error:false,session_id:'S1',total_cost_usd:0.01,permission_denials:[]});},20);}});
`;

function fakeSession(extra = {}) {
  const dir = tmp();
  const script = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(script, FAKE);
  return new ClaudeSession({
    resolveCommand: () => ({ command: process.execPath, prefixArgs: [script] }),
    buildArgs: () => [],
    cwd: dir,
    env: process.env,
    ...extra,
  });
}

test('ClaudeSession: persistent process, deltas once, tools, result, two turns on one process', async () => {
  const s = fakeSession();
  const texts = [];
  const tools = [];
  const spawns = [];
  s.on('text', ({ text }) => texts.push(text));
  s.on('tool-use', (t) => tools.push(t.name));
  s.on('spawn', () => spawns.push(1));
  const turn = () => new Promise((resolve) => s.once('result', resolve));
  s.send('สวัสดี', { t0: Date.now() });
  const r1 = await turn();
  assert.strictEqual(r1.ev.total_cost_usd, 0.01);
  assert.ok(r1.latency.t2 >= r1.latency.t0);
  await new Promise((r) => setImmediate(r));
  s.send('อีกรอบ');
  await turn();
  assert.deepStrictEqual(texts, ['ตอบ:สวัสดี', 'ตอบ:อีกรอบ']);
  assert.deepStrictEqual(tools, ['Bash', 'Bash']);
  assert.strictEqual(spawns.length, 1, 'one process for both turns');
  assert.strictEqual(s.sessionId, 'S1');
  s.dispose();
});

test('ClaudeSession: stop() kills the process and the next send respawns with --resume', async () => {
  const resumes = [];
  const s = fakeSession({ buildArgs: (resume) => { resumes.push(resume); return []; } });
  const ended = new Promise((resolve) => s.once('turn-end', resolve));
  s.send('hang');
  await new Promise((r) => s.once('init', r));
  s.stop();
  const e = await ended;
  assert.strictEqual(e.cancelled, true);
  assert.strictEqual(s.busy, false);
  const done = new Promise((resolve) => s.once('result', resolve));
  s.send('ต่อ');
  await done;
  assert.deepStrictEqual(resumes, [null, 'S1']);
  s.dispose();
});

test('ClaudeSession reports a missing executable', async () => {
  const s = new ClaudeSession({
    resolveCommand: () => ({ command: path.join(tmp(), 'nope.exe'), prefixArgs: [] }),
    buildArgs: () => [],
    cwd: os.tmpdir(),
    env: process.env,
  });
  const err = new Promise((resolve) => s.once('error-info', resolve));
  s.send('x');
  const e = await err;
  assert.strictEqual(e.code, 'CLAUDE_NOT_FOUND');
  assert.strictEqual(s.busy, false);
});

test('voice/typed model commands map to --model aliases', () => {
  const { parseModelCommand } = require('../lib/jarvis-core');
  assert.strictEqual(parseModelCommand('/model haiku'), 'haiku');
  assert.strictEqual(parseModelCommand('เปลี่ยนโมเดลเป็น sonnet'), 'sonnet');
  assert.strictEqual(parseModelCommand('เปลี่ยนโมเดลเป็นโอปุสครับ'), 'opus');
  assert.strictEqual(parseModelCommand('สลับโมเดลเป็น ไฮกุ'), 'haiku');
  assert.strictEqual(parseModelCommand('ใช้โมเดล ค่าเริ่มต้น'), '');
  assert.strictEqual(parseModelCommand('/model'), null);
  assert.strictEqual(parseModelCommand('เปลี่ยนโมเดลเป็น gpt'), null);
  assert.strictEqual(parseModelCommand('ช่วยอธิบายว่าเปลี่ยนโมเดลเป็น sonnet ยังไง'), null);
});
