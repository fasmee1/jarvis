'use strict';
// Manual end-to-end try of planning mode against the REAL Claude Code CLI (uses your login and
// a little quota; model haiku, so the wording is weaker than on your own model). Not part of `npm test`.
//   node scripts/integration-planning.js
// Turn 1: the interview starts by asking, writes no files, writes no code.
// Turn 2: with the scope given, the diagram phase returns valid jarvis-flow / jarvis-er blocks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JarvisCore } = require('../lib/jarvis-core');
const { SettingsStore } = require('../lib/settings');

const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plan-'));
const proj = path.join(work, 'proj');
fs.mkdirSync(proj);
const settings = new SettingsStore(path.join(work, 'userdata'));
settings.update({ model: 'haiku', approvalTimeoutSec: 60, autoApproveSafe: false });

const events = [];
let resolveTurn = null;
const seenTools = [];
const picked = [];
let popups = 0; // question popups in the current turn; after 3 they are skipped so the try stays short
const ui = (ch, p) => {
  events.push([ch, p]);
  if (ch === 'approval:request') {
    seenTools.push(p.tool);
    if (p.questions && ++popups <= 3) {
      // a question popup: tick the first option that is not the recommended one, so the answer is recognisable
      const answers = p.questions.map((q) => {
        const other = q.options.find((o) => !/แนะนำ|recommended/i.test(o.label)) || q.options[0];
        picked.push(other.label);
        return { picked: [other.label], text: '' };
      });
      console.log('  [popup]', p.questions.map((q) => q.question).join(' / '), '→', answers.map((a) => a.picked[0]).join(', '));
      setTimeout(() => core.respondApproval({ id: p.id, decision: 'once', answers }), 50);
    } else {
      // every other approval is refused (this try must not touch files); the tool names are only recorded
      setTimeout(() => core.respondApproval({ id: p.id, decision: 'deny' }), 50);
    }
  }
  if (ch === 'turn:result' && resolveTurn) resolveTurn(p);
  if (ch === 'error') console.log('  [error]', p.code, p.message);
};
const core = new JarvisCore({ settings, tempDir: path.join(work, 'tmp'), ui, appRoot: root, logDir: work });

function turn(text) {
  events.length = 0;
  seenTools.length = 0;
  picked.length = 0;
  popups = 0;
  return new Promise((resolve) => {
    resolveTurn = resolve;
    core.send({ text, t0: Date.now() });
  });
}
// the app itself keeps .claude / .jarvis in the folder; anything else would be a file Claude wrote
const mine = () => fs.readdirSync(proj).filter((f) => f !== '.claude' && f !== '.jarvis');
const items = () => events.filter(([c]) => c === 'chat:item').map(([, p]) => p);
const spoken = () => events.filter(([c]) => c === 'tts:segment').map(([, p]) => p.text).join(' ');
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
};

const SCOPE = `สรุปขอบเขตที่คุยกันแล้ว (ถือว่าผมยืนยันแล้ว ไม่ต้องสัมภาษณ์เพิ่ม ข้ามขั้นเลือกเทคโนโลยีและห้ามบันทึกไฟล์ ไปวาดแผนผังเลย):
ระบบจองคิวร้านตัดผม ลูกค้าเลือกช่างและเวลาแล้วจอง ได้รับแจ้งเตือนก่อนถึงคิว เจ้าของร้านดูตารางและยกเลิกคิวได้ ช่างปิดเวลาที่ไม่ว่างได้
ให้วาด 2 แบบ: jarvis-flow แบบ flowchart ของการจองคิว และ jarvis-er ของตารางข้อมูล ตอบสั้น ๆ`;

(async () => {
  await core.init();
  core.setCwd(proj);
  core.setPlanningMode(true);

  let r = await turn('ผมอยากทำระบบจองคิวร้านตัดผม');
  const text1 = spoken();
  console.log('  พูด:', text1.slice(0, 400).replace(/\s+/g, ' '));
  check('turn 1 finished', !!r);
  check('turn 1 asks something', /[?？]|ไหม|หรือ|อะไร|ใคร|ยังไง|เท่าไร/.test(text1) || seenTools.includes('AskUserQuestion'), `tools: ${seenTools.join(',') || '-'}`);
  check('turn 1 stays brief (no long speech between popups)', [...text1].length / Math.max(1, popups) < 250, `${[...text1].length} chars over ${popups} popups`);
  check('turn 1 wrote no project file', mine().length === 0, mine().join(','));
  const got = picked.map((l) => l.replace(/\(.*?\)/g, '').trim()).filter(Boolean);
  check('the popup answer reached Claude', got.length > 0 && got.some((g) => text1.includes(g.slice(0, 6))), 'picked: ' + got.join(', '));
  check('every question was a popup (at least 2 in turn 1)', popups >= 2, popups + ' popups');
  // popups after the third are skipped on purpose (to keep the try short), so Claude may say the user skipped
  check('Claude did not say the user refused', popups > 3 || !/ปฏิเสธ|แต่คุณ.*ไม่/.test(text1));
  check('turn 1 did not edit or run anything', !seenTools.some((t) => ['Write', 'Edit', 'Bash'].includes(t)), seenTools.join(','));

  r = await turn(SCOPE);
  const blocks = items().filter((p) => p.type === 'block');
  const bad = items().filter((p) => p.type === 'block-error');
  console.log('  blocks:', blocks.map((b) => b.kind).join(', ') || '-', bad.length ? `· errors: ${bad.map((b) => b.kind + ':' + b.error).join(' | ')}` : '');
  const flow = blocks.find((b) => b.kind === 'flow');
  const er = blocks.find((b) => b.kind === 'er');
  check('no block-error', bad.length === 0, bad.map((b) => b.error).join(' | '));
  check('jarvis-flow block parsed', !!flow, flow ? `${flow.data.nodes.length} nodes` : '');
  check('jarvis-er block parsed', !!er, er ? `${er.data.entities.length} entities` : '');
  if (flow) {
    const ids = new Set(flow.data.nodes.map((n) => n.id));
    check('flow edges point at real nodes', (flow.data.edges || []).every((e) => ids.has(e.from) && ids.has(e.to)));
  }
  if (er) {
    const ids = new Set(er.data.entities.map((n) => n.id));
    check('er relations point at real entities', (er.data.relations || []).every((e) => ids.has(e.from) && ids.has(e.to)));
    check('er has a primary key somewhere', er.data.entities.some((e) => (e.fields || []).some((f) => f.key === 'pk')));
  }
  check('block JSON not spoken', !/"nodes"|"entities"/.test(spoken()));
  check('turn 2 wrote no project file', mine().length === 0, mine().join(','));

  fs.writeFileSync(path.join(os.tmpdir(), 'jarvis-plan-blocks.json'), JSON.stringify(blocks.map((b) => ({ kind: b.kind, data: b.data })), null, 1));
  core.dispose && core.dispose();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows may still hold the folder; it is in the temp dir */ }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
