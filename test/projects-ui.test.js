'use strict';
// PROJECTS section model (renderer/ui/projects.js): status, logs, chip text, folder list.
const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../renderer/ui/projects.js');
const st = (id, status, extra = {}) => ({ projectId: id, name: id.toUpperCase(), cwd: `D:\\${id}`, status, startedAt: 1, ...extra });

test('status updates keep one entry per project; removed drops it; announce is not stored', async () => {
  const { createModel, applyStatus } = await load();
  const m = createModel();
  applyStatus(m, st('a', 'running'));
  applyStatus(m, st('a', 'done', { announce: 'เสร็จ' }));
  applyStatus(m, st('b', 'running'));
  assert.strictEqual(m.projects.size, 2);
  assert.strictEqual(m.projects.get('a').info.status, 'done');
  assert.ok(!('announce' in m.projects.get('a').info));
  applyStatus(m, st('b', 'stopped'));
  assert.deepStrictEqual(m.projects.get('b').log, [{ kind: 'err', text: 'หยุดงานแล้ว' }]);
  applyStatus(m, st('b', 'stopped')); // repeated status: no second line
  assert.strictEqual(m.projects.get('b').log.length, 1);
  assert.strictEqual(applyStatus(m, { projectId: 'a', status: 'removed' }), null);
  assert.deepStrictEqual([...m.projects.keys()], ['b']);
});

test('events go to their own project log; text deltas merge; unknown projects and quiet events are ignored', async () => {
  const { createModel, applyStatus, applyEvent } = await load();
  const m = createModel();
  applyStatus(m, st('a', 'running'));
  applyStatus(m, st('b', 'running'));
  const ev = (projectId, channel, payload) => applyEvent(m, { projectId, channel, payload });
  ev('a', 'turn:start', {});
  ev('a', 'chat:item', { type: 'text', text: 'สวัส' });
  ev('a', 'chat:item', { type: 'text', text: 'ดี' });
  ev('a', 'activity', { kind: 'tool-use', name: 'Bash', summary: 'กำลังรัน Bash: npm test' });
  ev('a', 'activity', { kind: 'tool-result', name: 'Bash', isError: false });
  ev('b', 'error', { code: 'NO_DATA', message: 'ไม่มีข้อมูล' });
  ev('a', 'state', { state: 'THINKING' });
  assert.strictEqual(ev('zzz', 'chat:item', { type: 'text', text: 'x' }), null);
  const log = m.projects.get('a').log;
  assert.deepStrictEqual(log.map((l) => [l.kind, l.text]), [
    ['sep', 'งานใหม่'],
    ['text', 'สวัสดี'],
    ['tool', 'กำลังรัน Bash: npm test'],
  ]);
  assert.strictEqual(log[2].status, 'running');
  assert.deepStrictEqual(m.projects.get('b').log, [{ kind: 'err', text: 'ไม่มีข้อมูล' }]);
});

test('the log keeps the newest 300 lines', async () => {
  const { createModel, applyStatus, applyEvent } = await load();
  const m = createModel();
  applyStatus(m, st('a', 'running'));
  for (let i = 0; i < 350; i++) applyEvent(m, { projectId: 'a', channel: 'notice', payload: { text: `n${i}` } });
  const log = m.projects.get('a').log;
  assert.strictEqual(log.length, 300);
  assert.strictEqual(log[0].text, 'n50');
});

test('chip text counts running, waiting and failed projects', async () => {
  const { createModel, applyStatus, chipText } = await load();
  const m = createModel();
  assert.strictEqual(chipText(m), '');
  applyStatus(m, st('a', 'running'));
  applyStatus(m, st('b', 'awaiting-approval'));
  applyStatus(m, st('c', 'error'));
  assert.strictEqual(chipText(m), 'งานเบื้องหลัง 2 · รออนุมัติ 1 · ผิดพลาด 1');
  applyStatus(m, st('a', 'done'));
  applyStatus(m, st('b', 'done'));
  assert.strictEqual(chipText(m), 'โปรเจกต์ 3 · ผิดพลาด 1');
});

test('folder choices: existing projects first, then picked, then the list without the HUD folder; no duplicates', async () => {
  const { folderChoices } = await load();
  const out = folderChoices(
    [{ path: 'D:\\main', current: true }, { path: 'D:\\lib' }, { path: 'D:\\A' }],
    [{ cwd: 'D:\\a', name: 'a' }],
    ['D:\\new', 'D:\\LIB'],
  );
  assert.deepStrictEqual(out.map((x) => x.path), ['D:\\a', 'D:\\new', 'D:\\LIB']);
  assert.match(out[0].label, /โปรเจกต์เดิม/);
});

test('elapsed time reads as m:ss or h:mm:ss', async () => {
  const { fmtElapsed } = await load();
  assert.strictEqual(fmtElapsed(5000), '0:05');
  assert.strictEqual(fmtElapsed(65000), '1:05');
  assert.strictEqual(fmtElapsed(3725000), '1:02:05');
});

test('home cards: approvals, running, errors first, newest first, at most 3 plus a count', async () => {
  const { createModel, applyStatus, homeCards } = await load();
  const m = createModel();
  assert.deepStrictEqual(homeCards(m), { shown: [], more: 0 });
  applyStatus(m, st('a', 'done', { startedAt: 5 }));
  applyStatus(m, st('b', 'running', { startedAt: 1 }));
  applyStatus(m, st('c', 'running', { startedAt: 3 }));
  applyStatus(m, st('d', 'awaiting-approval', { startedAt: 2 }));
  applyStatus(m, st('e', 'error', { startedAt: 4 }));
  const r = homeCards(m);
  assert.deepStrictEqual(r.shown.map((p) => p.projectId), ['d', 'c', 'b']);
  assert.strictEqual(r.more, 2);
  assert.deepStrictEqual(homeCards(m, 10).shown.map((p) => p.projectId), ['d', 'c', 'b', 'e', 'a']);
});

test('progress text and bar: steps done, files changed, nothing to say without a plan', async () => {
  const { progressText, progressPercent } = await load();
  assert.strictEqual(progressText({}), '');
  assert.strictEqual(progressPercent({}), 0);
  const p = { progress: { done: 1, total: 4, current: 'x' }, filesChanged: 2 };
  assert.strictEqual(progressText(p), '1/4 ขั้นตอน · แก้ 2 ไฟล์');
  assert.strictEqual(progressPercent(p), 25);
  assert.strictEqual(progressText({ progress: { done: 0, total: 0 }, filesChanged: 3 }), 'แก้ 3 ไฟล์');
});

test('log: edits keep a capped diff, failed tools say why, the user message shows, subagent calls and todos stay out', async () => {
  const { createModel, applyStatus, applyEvent } = await load();
  const m = createModel();
  applyStatus(m, st('a', 'running'));
  const ev = (channel, payload) => applyEvent(m, { projectId: 'a', channel, payload });
  const diff = Array.from({ length: 100 }, (_, i) => ({ op: '+', line: `l${i}` }));
  ev('activity', { kind: 'tool-use', name: 'Edit', summary: 'แก้ไฟล์ a.js', preview: { file: 'a.js', diff } });
  ev('activity', { kind: 'tool-use', name: 'Read', summary: 'อ่านไฟล์ b', parent: 'sub1' });
  ev('activity', { kind: 'tool-result', name: 'Bash', isError: true, text: 'exit 1\nmore' });
  ev('todos', { todos: [{ content: 'x', status: 'pending' }] });
  ev('user:message', { text: 'แก้บั๊กให้หน่อย' });
  const log = m.projects.get('a').log;
  assert.deepStrictEqual(log.map((l) => l.kind), ['tool', 'err', 'user']);
  assert.strictEqual(log[0].diff.length, 40);
  assert.strictEqual(log[1].text, 'Bash ไม่สำเร็จ: exit 1');
  assert.strictEqual(log[2].text, 'แก้บั๊กให้หน่อย');
});

test('a tool row is updated in place when its result arrives; the plan (TodoWrite) is not a row', async () => {
  const { createModel, applyStatus, applyEventChange } = await load();
  const m = createModel();
  applyStatus(m, st('a', 'running'));
  const ev = (channel, payload) => applyEventChange(m, { projectId: 'a', channel, payload });
  const use = ev('activity', { kind: 'tool-use', id: 't1', name: 'Bash', summary: 'รัน npm test', input: { command: 'npm test' } });
  assert.strictEqual(use.op, 'add');
  assert.match(use.entry.input, /npm test/);
  assert.strictEqual(ev('activity', { kind: 'tool-use', id: 't2', name: 'TodoWrite', summary: 'อัปเดตรายการงาน', input: {} }).op, null);
  const done = ev('activity', { kind: 'tool-result', id: 't1', name: 'Bash', isError: false, text: 'ok 12 tests' });
  assert.strictEqual(done.op, 'update');
  assert.strictEqual(done.entry, use.entry, 'the same entry, so its node can be redrawn');
  assert.deepStrictEqual([done.entry.status, done.entry.result], ['ok', 'ok 12 tests']);
  const use2 = ev('activity', { kind: 'tool-use', id: 't3', name: 'Edit', summary: 'แก้ไฟล์', input: {} });
  const bad = ev('activity', { kind: 'tool-result', id: 't3', isError: true, decision: 'reject', text: 'denied by user' });
  assert.deepStrictEqual([bad.entry === use2.entry, bad.entry.status, bad.entry.rejected], [true, 'err', true]);
  assert.strictEqual(m.projects.get('a').log.length, 2, 'results did not add rows');
  // text deltas merge into the last text entry
  assert.strictEqual(ev('chat:item', { type: 'text', text: 'a' }).op, 'add');
  assert.strictEqual(ev('chat:item', { type: 'text', text: 'b' }).op, 'merge');
  assert.strictEqual(m.projects.get('a').log.at(-1).text, 'ab');
  assert.strictEqual(applyEventChange(m, { projectId: 'zzz', channel: 'error', payload: {} }), null);
});

test('the popup opens on the project that needs you: approval, then running, then the newest', async () => {
  const { createModel, applyStatus, pickProject } = await load();
  const m = createModel();
  assert.strictEqual(pickProject(m), null);
  applyStatus(m, st('a', 'done', { startedAt: 9 }));
  assert.strictEqual(pickProject(m), 'a');
  applyStatus(m, st('b', 'running', { startedAt: 1 }));
  assert.strictEqual(pickProject(m), 'b');
  applyStatus(m, st('c', 'awaiting-approval', { startedAt: 0 }));
  assert.strictEqual(pickProject(m), 'c');
});

const memStorage = () => {
  const d = new Map();
  return { getItem: (k) => (d.has(k) ? d.get(k) : null), setItem: (k, v) => d.set(k, String(v)), removeItem: (k) => d.delete(k), d };
};

test('history: saved log comes back in front of the new one; running tools show as failed; tool input is dropped', async () => {
  const { createModel, applyStatus, saveHistory, restoreHistory } = await load();
  const s = memStorage();
  const log = [
    { kind: 'user', text: 'ทำหน้า login' },
    { kind: 'tool', id: 't1', name: 'Bash', text: 'npm test', status: 'running', input: '{"x":1}', result: 'y'.repeat(2000) },
    { kind: 'text', text: 'เสร็จแล้ว' },
  ];
  assert.ok(saveHistory(s, 'a', log));
  assert.ok(!JSON.parse(s.getItem('jarvis.pjlog.a')).log[1].input);
  const m = createModel();
  applyStatus(m, st('a', 'idle'));
  m.projects.get('a').log.push({ kind: 'sep', text: 'งานใหม่' });
  assert.ok(restoreHistory(m, 'a', s));
  const got = m.projects.get('a').log;
  assert.deepStrictEqual(got.map((e) => e.kind), ['user', 'tool', 'text', 'sep']);
  assert.strictEqual(got[1].status, 'err');
  assert.strictEqual(got[1].result.length, 500);
  assert.ok(!restoreHistory(m, 'a', s)); // only once per project
});

test('history: bad or missing data gives an empty log; clear removes it; no storage is fine', async () => {
  const { loadHistory, saveHistory, clearHistory, packLog } = await load();
  const s = memStorage();
  assert.deepStrictEqual(loadHistory(s, 'a'), []);
  s.setItem('jarvis.pjlog.a', '{nope');
  assert.deepStrictEqual(loadHistory(s, 'a'), []);
  s.setItem('jarvis.pjlog.a', JSON.stringify({ v: 1, log: [{ kind: 'bogus', text: 'x' }, null, { kind: 'text', text: 'ok' }, { kind: 'text' }] }));
  assert.deepStrictEqual(loadHistory(s, 'a'), [{ kind: 'text', text: 'ok' }]);
  clearHistory(s, 'a');
  assert.strictEqual(s.getItem('jarvis.pjlog.a'), null);
  assert.strictEqual(saveHistory(null, 'a', []), false);
  assert.deepStrictEqual(loadHistory(null, 'a'), []);
  const full = { setItem() { throw new Error('quota'); } };
  assert.strictEqual(saveHistory(full, 'a', [{ kind: 'text', text: 'x' }]), false);
  assert.strictEqual(packLog(Array.from({ length: 400 }, () => ({ kind: 'text', text: 'x' }))).length, 300);
});
