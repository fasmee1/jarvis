// Permission popup page. Shows the oldest open request in full (sent by main) and
// sends the answer back. Only genuine clicks count — no keyboard shortcuts, no synthetic events.

const api = window.approval;
const $ = (id) => document.getElementById(id);

let req = null;
let timer = null;
let armTimer = null;
const ARM_MS = 700; // a popup appears under the cursor: a stray click must not approve a request nobody read

/** Allow buttons stay disabled for a moment after a new request appears. */
function arm() {
  clearTimeout(armTimer);
  $('allow').disabled = true;
  $('always').disabled = true;
  armTimer = setTimeout(() => { $('allow').disabled = false; $('always').disabled = false; }, ARM_MS);
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
  if (isNew) arm();

  $('ap').dataset.kind = toolKind(r.tool);
  $('tool').textContent = r.tool;
  show('queue', r.queue > 0 ? `+${r.queue} รออยู่` : '');
  $('summary').textContent = r.summary;
  show('reason', r.reason ? `ตัวกันพลาด: ${r.reason}` : '');

  // the file, when the request has one (Edit / Write / Read / NotebookEdit): folder dimmed, name bold
  $('file-sec').hidden = !r.file;
  if (r.file) {
    const cut = Math.max(r.file.lastIndexOf('\\'), r.file.lastIndexOf('/')) + 1;
    $('file-dir').textContent = r.file.slice(0, cut);
    $('file-name').textContent = r.file.slice(cut);
    $('file-new').hidden = !r.isNew;
  }

  // the raw command / URL / input, in full
  $('detail-sec').hidden = !r.detail;
  if (r.detail) {
    $('detail-h').textContent = r.detailKind === 'command' ? 'คำสั่งที่จะรัน' : r.detailKind === 'url' ? 'ที่อยู่ที่จะเปิด' : 'ข้อมูลที่ส่งให้เครื่องมือ';
    $('detail').textContent = r.detail + (r.detailCut ? '\n… (ตัดส่วนที่ยาวเกิน)' : '');
  }

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
  $('deny-wrap').hidden = true;
  $('deny-reason').value = '';

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
  api.invoke('approval-win:respond', { id: req.id, decision, reason }).catch(() => {});
}

$('allow').onclick = (e) => answer('once', e);
$('always').onclick = (e) => answer('always', e);
$('deny').onclick = (e) => answer('deny', e);
$('deny-why').onclick = (e) => {
  if (!e.isTrusted) return;
  $('deny-wrap').hidden = false;
  $('deny-reason').focus();
};
$('deny-send').onclick = (e) => answer('deny-reason', e);

api.on('approval-win:data', render);
