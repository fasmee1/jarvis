// Permission popup page. Shows the oldest open request in full (sent by main) and
// sends the answer back. Only genuine clicks count — no keyboard shortcuts, no synthetic events.

import { buildQuestionForm } from './question-form.js';

const api = window.approval;
const $ = (id) => document.getElementById(id);

let req = null;
let timer = null;
let armTimer = null;
let armed = false;
let form = null; // the check-box form of a question (or null)
const ARM_MS = 700; // a popup appears under the cursor: a stray click must not approve a request nobody read

/** "ส่งคำตอบ" needs the popup armed and every question answered. */
function syncAnswer() {
  $('send-answer').disabled = !armed || !(form && form.complete());
}

/** Allow buttons stay disabled for a moment after a new request appears. */
function arm() {
  clearTimeout(armTimer);
  armed = false;
  $('allow').disabled = true;
  $('always').disabled = true;
  $('safe').disabled = true;
  syncAnswer();
  armTimer = setTimeout(() => { armed = true; $('allow').disabled = false; $('always').disabled = false; $('safe').disabled = false; syncAnswer(); }, ARM_MS);
}

/** Picks the accent and icon: edit, shell, read, web or other. */
function toolKind(tool) {
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return 'edit';
  if (/^(Bash|PowerShell)$/.test(tool)) return 'shell';
  if (/^(Read|Glob|Grep)$/.test(tool)) return 'read';
  if (/^Web/.test(tool)) return 'web';
  return 'other';
}

function show(id, text) {
  $(id).hidden = !text;
  if (text) $(id).textContent = text;
}

function render(r) {
  const isNew = !r || !req || req.id !== r.id;
  req = r;
  clearInterval(timer);
  $('ap').hidden = !r;
  if (!r) return;
  // a question from JARVIS: check boxes to choose from, sent with "ส่งคำตอบ"
  const asking = !!r.questions;
  if (isNew) {
    form = asking ? buildQuestionForm(r.questions, syncAnswer) : null;
    $('question').replaceChildren(...(form ? [form.el] : []));
    arm();
  }
  $('question').hidden = !asking;
  $('send-answer').hidden = !asking;
  $('allow').hidden = asking;
  $('deny-why').hidden = asking;
  $('title-k').textContent = asking ? 'JARVIS ขอถามคุณ' : 'ขออนุญาตใช้เครื่องมือ';
  $('tool').hidden = asking;

  $('ap').dataset.kind = asking ? 'read' : toolKind(r.tool);
  $('tool').textContent = r.tool;
  show('queue', r.queue > 0 ? `+${r.queue} รออยู่` : '');
  $('summary').textContent = asking ? '' : r.summary;
  show('reason', r.reason ? `ตัวกันพลาด: ${r.reason}` : '');

  // the file, when the request has one (Edit / Write / Read / NotebookEdit): folder dimmed, name bold
  $('file-sec').hidden = !r.file;
  if (r.file) {
    const cut = Math.max(r.file.lastIndexOf('\\'), r.file.lastIndexOf('/')) + 1;
    $('file-dir').textContent = r.file.slice(0, cut);
    $('file-name').textContent = r.file.slice(cut);
    $('file-new').hidden = !r.isNew;
  }

  // the raw command / URL / input, in full; for a plan, the plan text
  const text = r.plan || r.detail;
  $('detail-sec').hidden = !text;
  if (text) {
    $('detail-h').textContent = r.plan ? 'แผนงานที่เสนอ' : r.detailKind === 'command' ? 'คำสั่งที่จะรัน' : r.detailKind === 'url' ? 'ที่อยู่ที่จะเปิด' : 'ข้อมูลที่ส่งให้เครื่องมือ';
    $('detail').textContent = text + (r.planCut || r.detailCut ? '\n… (ตัดส่วนที่ยาวเกิน)' : '');
  }
  // a plan is approved to start the work, or sent back with notes (it has no "always")
  $('allow').textContent = r.plan ? 'อนุมัติแผน — เริ่มลงมือ' : 'อนุญาต';
  $('deny').textContent = asking ? 'ข้ามคำถามนี้' : r.plan ? 'ไม่อนุมัติ' : 'ปฏิเสธ';
  $('deny-why').textContent = r.plan ? 'ขอแก้แผน…' : 'ปฏิเสธพร้อมเหตุผล…';
  $('deny-reason').placeholder = r.plan ? 'บอกว่าอยากให้แก้แผนตรงไหน (Claude จะเห็นข้อความนี้และเสนอแผนใหม่)' : 'บอกเหตุผลที่ปฏิเสธ (Claude จะเห็นข้อความนี้)';
  $('deny-send').textContent = r.plan ? 'ส่งข้อแก้และขอแผนใหม่' : 'ส่งเหตุผลและปฏิเสธ';

  const diff = $('diff');
  $('diff-sec').hidden = !r.diff.length;
  diff.replaceChildren(...r.diff.map((d) => {
    const row = document.createElement('div');
    const hdr = d.op === '@' || d.op === '!';
    row.className = d.op === '+' ? 'add' : d.op === '-' ? 'del' : hdr ? 'hdr' : '';
    if (!hdr) row.dataset.op = d.op === '+' || d.op === '-' ? d.op : ' ';
    row.textContent = d.line;
    return row;
  }));
  const added = r.diff.filter((d) => d.op === '+').length;
  const removed = r.diff.filter((d) => d.op === '-').length;
  show('stat-add', added ? `+${added}` : '');
  show('stat-del', removed ? `−${removed}` : '');
  if (r.diffCut) {
    const row = document.createElement('div');
    row.className = 'hdr';
    row.textContent = '… (แสดงเฉพาะส่วนแรก — ดูทั้งหมดใน JARVIS)';
    diff.append(row);
  }

  show('rule', r.rule ? `"อนุญาตเสมอ" จะเพิ่ม rule: ${r.rule} ลง .claude/settings.local.json` : '');
  $('always').hidden = !r.rule;
  // several waiting and some are low risk: one click clears those (the rest still ask)
  $('safe').hidden = !(r.queue > 0 && r.safeCount > 0);
  $('safe').textContent = `อนุมัติที่เสี่ยงต่ำทั้งหมด (${r.safeCount})`;
  $('deny-wrap').hidden = true;
  $('deny-reason').value = '';

  // a question waits for the user: no countdown, no auto-deny
  document.querySelector('.timer-row').hidden = asking; // no clock and no bar for a question
  document.querySelector('.body').scrollTo(0, 0);
  if (!r.timeoutSec) return;
  const end = r.createdAt + r.timeoutSec * 1000;
  const total = r.timeoutSec * 1000;
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    $('timer').textContent = `ปฏิเสธอัตโนมัติใน ${Math.ceil(left / 1000)} วิ`;
    $('bar-fill').style.transform = `scaleX(${total > 0 ? left / total : 0})`;
  };
  tick();
  timer = setInterval(tick, 500);
  document.querySelector('.body').scrollTo(0, 0);
}

function answer(decision, ev) {
  if (!ev || !ev.isTrusted || !req) return;
  if ((decision === 'once' || decision === 'always') && $('allow').disabled) return;
  const reason = decision === 'deny-reason' ? $('deny-reason').value.trim() : '';
  const msg = { id: req.id, projectId: req.projectId || 'main', decision, reason };
  if (req.questions && decision === 'once') {
    if (!armed || !form || !form.complete()) return;
    msg.answers = form.answers();
  }
  api.invoke('approval-win:respond', msg).catch(() => {});
}

$('send-answer').onclick = (e) => answer('once', e);
$('allow').onclick = (e) => answer('once', e);
$('always').onclick = (e) => answer('always', e);
$('deny').onclick = (e) => answer('deny', e);
$('safe').onclick = (e) => {
  if (!e.isTrusted || $('safe').disabled) return;
  api.invoke('approval-win:approve-safe').catch(() => {});
};
$('deny-why').onclick = (e) => {
  if (!e.isTrusted) return;
  $('deny-wrap').hidden = false;
  $('deny-reason').focus();
};
$('deny-send').onclick = (e) => answer('deny-reason', e);

api.on('approval-win:data', render);
