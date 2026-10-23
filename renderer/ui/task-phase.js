// Thai label for the task status pill while a tool runs: what it does, and on which file when there is one.
// Pure module (no DOM) so node --test can import it.

const VERBS = {
  Read: 'กำลังอ่าน',
  Write: 'กำลังเขียน',
  Edit: 'กำลังแก้',
  MultiEdit: 'กำลังแก้',
  NotebookEdit: 'กำลังแก้',
  Bash: 'กำลังรันคำสั่ง',
  PowerShell: 'กำลังรันคำสั่ง',
  Glob: 'กำลังค้นไฟล์',
  Grep: 'กำลังค้นข้อความ',
  WebSearch: 'กำลังค้นเว็บ',
  WebFetch: 'กำลังเปิดเว็บ',
  Task: 'กำลังส่งงานให้ subagent',
  Agent: 'กำลังส่งงานให้ subagent',
};

const MAX_TARGET = 40;

const base = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || '';

function targetOf(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.file_path) return base(input.file_path);
  if (input.notebook_path) return base(input.notebook_path);
  if (name === 'Glob' && input.pattern) return String(input.pattern);
  if (name === 'Grep' && input.pattern) return `"${input.pattern}"`;
  if (name === 'WebSearch' && input.query) return String(input.query);
  return '';
}

/** "กำลังอ่าน app.js" for Read on D:\x\app.js; "กำลังใช้ Foo" for tools without a verb. */
export function toolPhase(name, input) {
  const n = String(name || '');
  if (!n) return 'กำลังทำงาน';
  const verb = VERBS[n] || `กำลังใช้ ${n}`;
  const t = targetOf(n, input).replace(/\s+/g, ' ').trim();
  if (!t) return verb;
  return `${verb} ${t.length > MAX_TARGET ? `${t.slice(0, MAX_TARGET - 1)}…` : t}`;
}
