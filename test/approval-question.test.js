'use strict';
// AskUserQuestion popup: check boxes + a text box; the choice goes back to the CLI as updatedInput.answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeQuestions, buildAnswer } = require('../lib/approval-question');
const { JarvisCore } = require('../lib/jarvis-core');
const { SettingsStore } = require('../lib/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-q-'));
const INPUT = {
  questions: [
    { question: 'สัมภาษณ์แบบไหน', header: 'ความลึก', multiSelect: false, options: [{ label: 'เร็ว (แนะนำ)', description: '5 นาที' }, { label: 'ละเอียด', description: 'ครบทุกหัวข้อ' }] },
    { question: 'อยากได้แพลตฟอร์มไหน', multiSelect: true, options: [{ label: 'เว็บ' }, { label: 'มือถือ' }, { label: 'คอมพิวเตอร์' }] },
  ],
};

test('normalizeQuestions: cleans, caps and rejects what cannot be asked', () => {
  const qs = normalizeQuestions(INPUT);
  assert.strictEqual(qs.length, 2);
  assert.strictEqual(qs[0].options[0].description, '5 นาที');
  assert.strictEqual(qs[1].multiSelect, true);
  assert.strictEqual(normalizeQuestions({}), null);
  assert.strictEqual(normalizeQuestions({ questions: [] }), null);
  assert.strictEqual(normalizeQuestions({ questions: [{ question: '  ', options: [] }] }), null);
  assert.strictEqual(normalizeQuestions({ questions: [null] }), null);
  const many = normalizeQuestions({ questions: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, options: Array.from({ length: 20 }, (_, j) => ({ label: `o${j}` })) })) });
  assert.strictEqual(many.length, 4);
  assert.ok(many.every((q) => q.options.length === 8));
  const dup = normalizeQuestions({ questions: [{ question: 'q', options: [{ label: 'a' }, { label: 'a' }, { label: '' }] }] });
  assert.strictEqual(dup[0].options.length, 1);
});

test('buildAnswer: labels joined, typed text added, one answer per question', () => {
  const r = buildAnswer(INPUT, [{ picked: ['ละเอียด'], text: '' }, { picked: ['เว็บ', 'มือถือ'], text: 'มี LINE ด้วย' }]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.updatedInput.answers, { 'สัมภาษณ์แบบไหน': 'ละเอียด', 'อยากได้แพลตฟอร์มไหน': 'เว็บ, มือถือ, มี LINE ด้วย' });
  assert.deepStrictEqual(r.updatedInput.questions, INPUT.questions);
  // typing alone is a valid answer
  assert.strictEqual(buildAnswer(INPUT, [{ picked: [], text: 'แบบกลาง ๆ' }, { picked: ['เว็บ'] }]).ok, true);
});

test('buildAnswer: refuses wrong, missing, duplicate and oversized answers', () => {
  const ok = { picked: ['เว็บ'], text: '' };
  assert.strictEqual(buildAnswer(INPUT, [{ picked: ['ไม่มีข้อนี้'] }, ok]).ok, false);
  assert.strictEqual(buildAnswer(INPUT, [{ picked: ['เร็ว (แนะนำ)', 'ละเอียด'] }, ok]).ok, false); // single choice
  assert.strictEqual(buildAnswer(INPUT, [{ picked: [], text: '' }, ok]).ok, false); // nothing for question 1
  assert.strictEqual(buildAnswer(INPUT, [{ picked: ['เร็ว (แนะนำ)'] }]).ok, false); // one answer missing
  assert.strictEqual(buildAnswer(INPUT, [{ picked: ['เร็ว (แนะนำ)'] }, { picked: ['เว็บ', 'เว็บ'] }]).ok, false);
  assert.strictEqual(buildAnswer(INPUT, [{ picked: ['เร็ว (แนะนำ)'], text: 'x'.repeat(1001) }, ok]).ok, false);
  assert.strictEqual(buildAnswer(INPUT, 'nope').ok, false);
  assert.strictEqual(buildAnswer({ questions: 'x' }, []).ok, false);
});

test('question form logic: recommended is ticked first, single choice swaps, multi adds, order kept', async () => {
  const L = await import('../renderer/approval/question-logic.js');
  const qs = normalizeQuestions(INPUT);
  const st = L.initialState(qs);
  assert.deepStrictEqual([...st[0].picked], ['เร็ว (แนะนำ)']);
  assert.strictEqual(st[1].picked.size, 0);
  assert.strictEqual(L.isComplete(st), false); // question 2 still empty
  L.choose(st, 0, 'ละเอียด'); // round button: becomes the only one
  assert.deepStrictEqual([...st[0].picked], ['ละเอียด']);
  L.choose(st, 0, 'ละเอียด');
  assert.deepStrictEqual([...st[0].picked], ['ละเอียด']); // choosing again never unticks a round button
  L.choose(st, 0, 'เร็ว (แนะนำ)');
  L.toggle(st, 0, qs[0], 'ละเอียด');
  assert.deepStrictEqual([...st[0].picked], ['ละเอียด']); // swapped, not added
  L.toggle(st, 0, qs[0], 'ละเอียด');
  assert.strictEqual(st[0].picked.size, 0); // unticked
  L.toggle(st, 1, qs[1], 'คอมพิวเตอร์');
  L.toggle(st, 1, qs[1], 'เว็บ');
  assert.strictEqual(st[1].picked.size, 2);
  assert.strictEqual(L.isComplete(st), false); // question 1 empty now
  st[0].text = '  ตอบเอง ';
  assert.strictEqual(L.isComplete(st), true);
  assert.deepStrictEqual(L.collect(st, qs), [{ picked: [], text: 'ตอบเอง' }, { picked: ['เว็บ', 'คอมพิวเตอร์'], text: '' }]);
  assert.strictEqual(L.isRecommended({ label: 'Use X (Recommended)' }), true);
  assert.strictEqual(L.isRecommended({ label: 'ตัวเลือกอื่น' }), false);
});

function makeCore() {
  const events = [];
  const core = new JarvisCore({ settings: new SettingsStore(tmp()), tempDir: tmp(), ui: (k, d) => events.push([k, d]), appRoot: tmp(), logDir: tmp() });
  core.warm = () => {};
  core.broker = { timeoutSec: 60 }; // the real broker (a pipe server) is made in init(); only its timeout is read here
  return { core, events };
}
const ask = (core, id = 'q1') => core._onPermissionRequest({ id, kind: 'permission', tool_name: 'AskUserQuestion', tool_use_id: 'tu1', input: INPUT });

test('core: a question is shown with its options, never auto-approved, and answered by choosing', async () => {
  const { core, events } = makeCore();
  core.settings.update({ autoApproveSafe: true });
  const pending = ask(core);
  const shown = events.find(([k]) => k === 'approval:request')[1];
  assert.strictEqual(shown.questions.length, 2);
  assert.strictEqual(shown.rule, null);
  assert.strictEqual(shown.safe, false);
  assert.strictEqual(shown.timeoutSec, 0); // no countdown: the question waits for the user
  assert.match(shown.summary, /สัมภาษณ์แบบไหน/);

  // "once" without answers, or with a wrong one, is refused and the question stays open
  assert.strictEqual(core.respondApproval({ id: 'q1', decision: 'once' }).ok, false);
  assert.strictEqual(core.respondApproval({ id: 'q1', decision: 'once', answers: [{ picked: ['x'] }, { picked: ['เว็บ'] }] }).ok, false);
  assert.strictEqual(core.pending.size, 1);
  // safe-approve-all never answers a question for the user
  assert.strictEqual(core.approveSafePending(), 0);
  assert.strictEqual(core.pending.size, 1);

  const r = core.respondApproval({ id: 'q1', decision: 'once', answers: [{ picked: ['เร็ว (แนะนำ)'], text: '' }, { picked: ['เว็บ'], text: 'ภาษาไทย' }] });
  assert.strictEqual(r.ok, true);
  const out = await pending;
  assert.strictEqual(out.behavior, 'allow');
  assert.deepStrictEqual(out.updatedInput.answers, { 'สัมภาษณ์แบบไหน': 'เร็ว (แนะนำ)', 'อยากได้แพลตฟอร์มไหน': 'เว็บ, ภาษาไทย' });
  assert.strictEqual(core.pending.size, 0);
  assert.ok(events.some(([k]) => k === 'approval:close'));
});

test('core: skipping a question denies it with a reason Claude can read; "always" is not a thing for questions', async () => {
  const { core } = makeCore();
  const a = ask(core, 'q2');
  core.respondApproval({ id: 'q2', decision: 'deny' });
  const out = await a;
  assert.strictEqual(out.behavior, 'deny');
  assert.match(out.message, /ปฏิเสธ/);

  const b = ask(core, 'q3');
  assert.strictEqual(core.respondApproval({ id: 'q3', decision: 'always' }).ok, false); // needs answers too
  core.respondApproval({ id: 'q3', decision: 'deny-reason', reason: 'ไม่ตอบตอนนี้' });
  assert.match((await b).message, /ไม่ตอบตอนนี้/);
});

test('core: a malformed question is refused at once, with no popup', async () => {
  const { core, events } = makeCore();
  const out = await core._onPermissionRequest({ id: 'q4', kind: 'permission', tool_name: 'AskUserQuestion', tool_use_id: 'tu', input: { questions: [{ options: [] }] } });
  assert.strictEqual(out.behavior, 'deny');
  assert.ok(!events.some(([k]) => k === 'approval:request'));
});

test('contextFromText: the plan before the question becomes readable text', () => {
  const { contextFromText } = require('../lib/approval-question');
  const steps = '```jarvis-steps\n{"title":"แผน","steps":[{"title":"ทำหน้าแรก","detail":"มีปุ่มเพิ่มรายจ่าย"},{"title":"ทำกราฟ","done":true}]}\n```';
  const table = '```jarvis-result\n{"type":"table","title":"เทคโนโลยี","columns":["ส่วน","ที่ใช้"],"rows":[["หน้าจอ","Expo"]]}\n```';
  const out = contextFromText(`ผมวางแผนไว้แบบนี้ครับ\n${steps}\n\n\n\nและใช้ตามนี้\n${table}\n\`\`\`js\nconsole.log(1)\n\`\`\`\nเห็นด้วยไหม`);
  assert.match(out, /ผมวางแผนไว้แบบนี้ครับ/);
  assert.match(out, /แผน\n1\. ทำหน้าแรก — มีปุ่มเพิ่มรายจ่าย\n✔ ทำกราฟ/);
  assert.match(out, /ส่วน \| ที่ใช้\nหน้าจอ \| Expo/);
  assert.match(out, /เห็นด้วยไหม$/);
  assert.ok(!out.includes('{') && !out.includes('console.log') && !/\n{3}/.test(out));
  // a block still being written is cut off; empty and very long input are handled
  assert.strictEqual(contextFromText('ข้อความ\n```jarvis-steps\n{"steps":[{"ti'), 'ข้อความ');
  assert.strictEqual(contextFromText(''), '');
  assert.strictEqual(contextFromText(undefined), '');
  const long = contextFromText('ก'.repeat(20000));
  assert.ok(long.length <= 6001 && long.startsWith('…'));
});

test('core: the question panel carries only the question, no old text or plan', async () => {
  const { core, events } = makeCore();
  core.turnText = 'แผนของผม\n```jarvis-steps\n{"steps":[{"title":"ขั้นแรก"}]}\n```\nเห็นด้วยไหมครับ';
  const p = ask(core, 'q9');
  const shown = events.find(([k]) => k === 'approval:request')[1];
  assert.strictEqual(shown.context, undefined); // the plan stays on the main screen, not in the panel
  assert.strictEqual(shown.questions.length, 2);
  core.respondApproval({ id: 'q9', decision: 'deny' });
  await p;
});

test('core: a plan shown on screen in an earlier turn counts as shown, a stale or missing one does not', async () => {
  const { core, events } = makeCore();
  const plan = '```jarvis-steps\n{"title":"แผนแอปรายจ่าย","steps":[{"title":"ทำหน้าแรก","detail":"มีปุ่มเพิ่มรายจ่ายและดูยอดรวม"},{"title":"ทำกราฟ","detail":"กราฟแท่งรายเดือนของทุกหมวด"}]}\n```\n';
  const planQ = { questions: [{ question: 'ตามแผนบนจอ ให้ผมเริ่มสร้างเลยไหม', options: [{ label: 'เริ่มเลย (แนะนำ)' }, { label: 'ปรับแผนก่อน' }] }] };
  const askPlan = (id) => core._onPermissionRequest({ id, kind: 'permission', tool_name: 'AskUserQuestion', tool_use_id: 't', input: planQ });
  core.turnNo = 1;
  const pipe = core._makePipeline(); // the plan is displayed during turn 1
  pipe.extractor.push(plan);
  pipe.extractor.end();
  assert.ok(events.some(([k, d]) => k === 'chat:item' && d.kind === 'steps'));

  // turn 2: only a short line, but the plan is on screen from turn 1 → the panel opens
  core.turnNo = 2;
  core.turnText = 'ผมมีคำถามครับ';
  let p = askPlan('q10');
  assert.ok(events.some(([k, d]) => k === 'approval:request' && d.id === 'q10'));
  core.respondApproval({ id: 'q10', decision: 'deny' });
  await p;

  // four turns later the plan is stale: the question is sent back
  core.turnNo = 5;
  const sentBack = await askPlan('q12');
  assert.strictEqual(sentBack.behavior, 'deny');
  assert.match(sentBack.message, /เขียนแผนฉบับเต็มก่อน/);

  // a new conversation forgets it
  core.shownPlan = { text: 'x', turn: 0 };
  core.newSession(true);
  assert.strictEqual(core.shownPlan, null);
});

test('core: a question about "the plan" is sent back until a plan has been written (twice at most)', async () => {
  const { core, events } = makeCore();
  const planQ = { questions: [{ question: 'ตามแผนบนจอ ให้ผมเริ่มสร้างเลยไหม', options: [{ label: 'เริ่มเลย (แนะนำ)' }, { label: 'ปรับแผนก่อน' }] }] };
  const askPlan = (id) => core._onPermissionRequest({ id, kind: 'permission', tool_name: 'AskUserQuestion', tool_use_id: 't', input: planQ });
  core.turnNo = 3;
  core.turnText = 'ผมมีคำถามครับ'; // one sentence, no plan

  const a = await askPlan('g1');
  assert.strictEqual(a.behavior, 'deny');
  assert.match(a.message, /เขียนแผนฉบับเต็มก่อน/);
  assert.ok(!events.some(([k]) => k === 'approval:request')); // nothing was shown to the user
  assert.strictEqual((await askPlan('g2')).behavior, 'deny');

  // the third time it is shown anyway, so a stubborn model never loops forever
  const p3 = askPlan('g3');
  assert.ok(events.some(([k, d]) => k === 'approval:request' && d.id === 'g3'));
  core.respondApproval({ id: 'g3', decision: 'deny' });
  await p3;

  // a written plan in this turn: the panel opens at once
  core.turnNo = 4;
  core.turnText = 'แผนของผมครับ\n```jarvis-steps\n{"title":"แผนแอปรายจ่าย","steps":[{"title":"ทำหน้าแรก","detail":"มีปุ่มเพิ่มรายจ่ายและดูยอดรวมของเดือนนี้"},{"title":"ทำกราฟ","detail":"กราฟแท่งรายเดือน"}]}\n```\nเห็นด้วยไหมครับ';
  const p4 = askPlan('g4');
  const shown = events.filter(([k]) => k === 'approval:request').at(-1)[1];
  assert.strictEqual(shown.id, 'g4');
  assert.strictEqual(shown.context, undefined);
  core.respondApproval({ id: 'g4', decision: 'deny' });
  await p4;

  // a question that does not mention a plan is never held back
  core.turnNo = 5;
  core.turnText = '';
  const p5 = ask(core, 'g5');
  assert.ok(events.some(([k, d]) => k === 'approval:request' && d.id === 'g5'));
  core.respondApproval({ id: 'g5', decision: 'deny' });
  await p5;
});

test('isNewSystemRequest: a wish to build a whole new system, not an edit', () => {
  const { isNewSystemRequest } = require('../lib/jarvis-core');
  for (const t of ['ผมอยากทำแอปรายรับรายจ่าย', 'ช่วยสร้างระบบจองคิวร้านตัดผมให้หน่อย', 'ต้องการพัฒนาเว็บไซต์ขายของออนไลน์', 'อยากทำแอพจดโน้ต']) assert.strictEqual(isNewSystemRequest(t), true, t);
  for (const t of ['แก้ระบบล็อกอินให้หน่อย', 'อยากเพิ่มปุ่มในแอปนี้', 'ทำแอปให้ปุ่มสีแดงขึ้น แก้ไฟล์ app.js', 'สวัสดี', '/code-review', 'ระบบทำงานยังไง', 'ทำระบบ']) assert.strictEqual(isNewSystemRequest(t), false, t);
});

test('core: a new-system request turns planning mode on by itself, once per conversation', () => {
  const { core, events } = makeCore();
  const sent = [];
  core.ensureSession = () => ({ busy: false });
  core._startTurn = (content) => { sent.push(content.at(-1).text); return 't'; };
  core.send({ text: 'ผมอยากทำแอปรายรับรายจ่าย' });
  assert.strictEqual(core.planningMode, true);
  assert.match(sent[0], /^\[JARVIS: เปิดโหมดวางแผนพัฒนาระบบ/);
  assert.match(sent[0], /ผมอยากทำแอปรายรับรายจ่าย$/);
  assert.ok(events.some(([k, d]) => k === 'notice' && /เปิดโหมดวางแผนให้อัตโนมัติ/.test(d.text)));
  // turned off by the user: the next request does not turn it back on
  core.setPlanningMode(false);
  core.send({ text: 'ผมอยากทำระบบจองคิว' });
  assert.strictEqual(core.planningMode, false);
  // a new conversation may start it again
  core.newSession(true);
  core.send({ text: 'ผมอยากทำระบบจองคิว' });
  assert.strictEqual(core.planningMode, true);
});

test('buildContext / blockToText', () => {
  const { buildContext, blockToText } = require('../lib/approval-question');
  assert.strictEqual(blockToText('steps', { steps: [{ title: 'ก' }] }), '1. ก');
  assert.strictEqual(blockToText('result', { type: 'text', title: 'ชื่อ', markdown: 'เนื้อหา' }), 'ชื่อ\nเนื้อหา');
  assert.strictEqual(blockToText('result', { type: 'weather' }), null); // not a plan: not remembered
  assert.strictEqual(blockToText('bom', { items: [] }), null);
  assert.strictEqual(buildContext('', ''), '');
  assert.strictEqual(buildContext('', '1. ก'), '1. ก');
  assert.strictEqual(buildContext('ข้อความ', ''), 'ข้อความ');
});

test('prompt: JARVIS is told to ask with recommended options in the popup', () => {
  const { buildSystemPrompt } = require('../lib/prompt');
  const p = buildSystemPrompt();
  assert.match(p, /AskUserQuestion เสมอ/);
  assert.match(p, /\(แนะนำ\)/);
  assert.match(p, /ห้ามถามยืนยันสิ่งที่ผู้ใช้ยังไม่เห็น/); // the popup covers the chat: the plan comes before the question
  assert.match(p, /multiSelect เป็น true/); // several answers → check boxes, one answer → round buttons
});
