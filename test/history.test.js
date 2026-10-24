'use strict';
// Conversation history: reading Claude Code transcripts, cleaning JARVIS's own
// prefixes out of the text, and continuing an old conversation with --resume.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listSessions, readSession, deleteSession, encode, cleanUserText } = require('../lib/history');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hist-'));
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

function fixture() {
  const base = tmp();
  const cwd = path.resolve('/work/My Site (2)');
  const dir = path.join(base, encode(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const line = (o) => JSON.stringify(o) + '\n';
  const user = (text, ts, extra = {}) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
  const asst = (content, ts) => line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content } });
  fs.writeFileSync(path.join(dir, `${ID1}.jsonl`),
    line({ type: 'queue-operation', operation: 'x', timestamp: '2026-10-19T10:00:00Z' }) +
    user('[JARVIS: เปิดโหมดโค้ด — อ่านก่อนแก้\n- ตรวจผล]\n[ผู้ใช้แนบไฟล์/โฟลเดอร์ต่อไปนี้ (อ่านได้เลย โฟลเดอร์แก้ไขได้ด้วย)]\n- ไฟล์: D:\\notes\\me.md\n\nสร้างเว็บ portfolio', '2026-10-19T10:00:01Z') +
    asst([{ type: 'thinking', thinking: 'hmm' }], '2026-10-19T10:00:02Z') +
    asst([{ type: 'text', text: 'ได้ครับ เริ่มเลย' }], '2026-10-19T10:00:03Z') +
    asst([{ type: 'tool_use', id: 't', name: 'Write', input: {} }], '2026-10-19T10:00:04Z') +
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }) +
    asst([{ type: 'text', text: 'เสร็จแล้ว\n```jarvis-result\n{"a":1}\n```' }], '2026-10-19T10:00:05Z') +
    user('meta', '2026-10-19T10:00:06Z', { isMeta: true }) +
    user('<command-name>/clear</command-name>', '2026-10-19T10:00:07Z') +
    user('ขอบคุณ', '2026-10-19T10:00:08Z'),
  );
  fs.writeFileSync(path.join(dir, `${ID2}.jsonl`), user('อีกเรื่อง', '2026-10-18T09:00:00Z'));
  fs.writeFileSync(path.join(dir, `${ID3}.jsonl`), line({ type: 'queue-operation', operation: 'x' })); // never asked anything
  fs.writeFileSync(path.join(dir, 'not-a-session.jsonl'), user('x', 'y'));
  const old = new Date('2026-10-18T09:00:00Z');
  fs.utimesSync(path.join(dir, `${ID2}.jsonl`), old, old);
  return { base, cwd };
}

test('listSessions: newest first, titled by the first question, empty ones skipped', () => {
  const { base, cwd } = fixture();
  const list = listSessions(cwd, { base });
  assert.deepStrictEqual(list.map((s) => s.id), [ID1, ID2]);
  assert.strictEqual(list[0].title, '📎 me.md สร้างเว็บ portfolio');
  assert.strictEqual(list[0].startedAt, '2026-10-19T10:00:00Z');
  assert.deepStrictEqual(listSessions(path.resolve('/no/such/project'), { base }), []);
});

test('readSession: text only, one reply joined, JARVIS prefixes and screen blocks summarised', () => {
  const { base, cwd } = fixture();
  const msgs = readSession(cwd, ID1, { base });
  assert.deepStrictEqual(msgs.map((m) => [m.role, m.text]), [
    ['user', '📎 me.md\nสร้างเว็บ portfolio'],
    ['assistant', 'ได้ครับ เริ่มเลย\n\nเสร็จแล้ว\n[แสดงบนจอ: result]'],
    ['user', 'ขอบคุณ'],
  ]);
  assert.strictEqual(readSession(cwd, '../../etc/passwd', { base }), null);
  assert.strictEqual(readSession(cwd, ID3.replace('3333', '9999'), { base }), null);
});

test('readSession: tool calls keep their order, summary, diff and result', () => {
  const base = tmp();
  const cwd = path.resolve('/work/tools');
  const dir = path.join(base, encode(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const line = (o) => JSON.stringify(o) + '\n';
  const asst = (content) => line({ type: 'assistant', message: { role: 'assistant', content } });
  const result = (id, content, is_error) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
  fs.writeFileSync(path.join(dir, `${ID1}.jsonl`),
    line({ type: 'user', timestamp: '2026-10-19T10:00:00Z', message: { role: 'user', content: 'แก้ a.js' } }) +
    asst([{ type: 'text', text: 'ขออ่านก่อน' }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.js' } }]) +
    result('r1', [{ type: 'text', text: 'let a = 1' }]) +
    asst([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'a.js', old_string: 'a = 1', new_string: 'a = 2' } }]) +
    result('e1', 'denied', true) +
    asst([{ type: 'tool_use', id: 'td', name: 'TodoWrite', input: {} }]) +
    asst([{ type: 'text', text: 'เสร็จ' }]));
  const [, reply] = readSession(cwd, ID1, { base });
  assert.deepStrictEqual(reply.parts.map((p) => p.type === 'tool' ? p.name : p.text), ['ขออ่านก่อน', 'Read', 'Edit', 'เสร็จ']);
  const [, read, edit] = reply.parts;
  assert.match(read.summary, /อ่านไฟล์ a\.js/);
  assert.deepStrictEqual(read.result, { text: 'let a = 1', isError: false });
  assert.ok(edit.preview.diff.some((d) => d.op === '+' && /a = 2/.test(d.line)));
  assert.strictEqual(edit.result.isError, true);
  assert.strictEqual(reply.text, 'ขออ่านก่อน\n\nเสร็จ');
});

test('readSession: a jarvis-result block is kept whole so it can be opened again', () => {
  const base = tmp();
  const cwd = path.resolve('/work/results');
  const dir = path.join(base, encode(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const line = (o) => JSON.stringify(o) + '\n';
  const data = { type: 'text', title: 'สรุป', spokenSummary: 'ครับ', markdown: 'เนื้อหา' };
  const reply = 'นี่ครับ\n```jarvis-result\n' + JSON.stringify(data) + '\n```\nเสร็จ';
  fs.writeFileSync(path.join(dir, `${ID1}.jsonl`),
    line({ type: 'user', timestamp: '2026-10-19T10:00:00Z', message: { role: 'user', content: 'ขอสรุป' } }) +
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } }));
  const [, a] = readSession(cwd, ID1, { base });
  assert.deepStrictEqual(a.parts.map((p) => p.type), ['text', 'result', 'text']);
  assert.deepStrictEqual(a.parts[1].data, data);
  assert.match(a.text, /\[แสดงบนจอ: result\]/);
});

test('deleteSession: trashes only that transcript, nothing for bad ids', async () => {
  const { base, cwd } = fixture();
  const trashed = [];
  const trash = (f) => { trashed.push(f); fs.rmSync(f); };
  assert.strictEqual(await deleteSession(cwd, '../../etc/passwd', { base, trash }), false);
  assert.strictEqual(await deleteSession(cwd, ID3.replace('3333', '9999'), { base, trash }), false);
  assert.strictEqual(await deleteSession(cwd, ID2, { base }), false); // no trash function: refuse
  assert.strictEqual(await deleteSession(cwd, ID2, { base, trash }), true);
  assert.deepStrictEqual(trashed.map((f) => path.basename(f)), [`${ID2}.jsonl`]);
  assert.deepStrictEqual(listSessions(cwd, { base }).map((x) => x.id), [ID1]);
});

test('cleanUserText removes carried-over context and image notes', () => {
  assert.strictEqual(cleanUserText('[บริบทจาก session ก่อนหน้า]\nสรุป\n[จบบริบท]\n\nต่อเลย'), 'ต่อเลย');
  assert.strictEqual(cleanUserText('[แนบภาพจากกล้อง 1 ภาพ ณ ตอนที่ผู้ใช้ถาม]\nดูนี่'), '📷 ดูนี่');
});

test('core.resumeSession: next CLI start uses --resume <id>, modes are re-announced', () => {
  const { SettingsStore } = require('../lib/settings');
  const { JarvisCore } = require('../lib/jarvis-core');
  const events = [];
  const core = new JarvisCore({ settings: new SettingsStore(tmp()), tempDir: tmp(), ui: (k, d) => events.push([k, d]), appRoot: tmp(), logDir: tmp() });
  core.warm = () => {};
  core.nodeCmd = { command: 'node', env: {} };
  core.setCwd(tmp());
  core.codingMode = true;
  let disposed = false;
  core.session = { busy: true, dispose: () => { disposed = true; } };
  assert.throws(() => core.resumeSession(ID1), /รอให้ตอบ/);
  core.session.busy = false;
  core.resumeSession(ID1);
  assert.ok(disposed);
  assert.strictEqual(core.session, null);
  assert.strictEqual(core.resumeId, ID1);
  assert.strictEqual(core.codingModeDirty, true);
  const args = core.argsFor(core.resumeId);
  assert.strictEqual(args[args.indexOf('--resume') + 1], ID1);
  assert.ok(events.some(([k, d]) => k === 'session' && d.kind === 'resumed' && d.sessionId === ID1));
});
