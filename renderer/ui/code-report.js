// Text for the local coding commands: what goes on screen (markdown for the
// Result Viewer's text tab) and the one line JARVIS says. Pure, unit-tested in
// test/coding-voice.test.js.

const LABEL = { test: 'เทสต์', check: 'เช็ก' };

const secs = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} นาที ${s % 60} วินาที` : `${s} วินาที`;
};
// output must not close our ``` fence early
const fence = (s) => String(s || '').replace(/```/g, '`​``');
const cell = (s) => String(s).replace(/\|/g, '\\|');

/**
 * @param {{ok:boolean, kind:'test'|'check', command:string, exitCode:number|null, durationMs:number,
 *          counts:{passed:number,failed:number}|null, error:string, tail:string, cancelled:boolean, timedOut:boolean}} r
 * @returns {{title:string, markdown:string, speak:string, line:string, ok:boolean}}
 */
export function checkReport(r) {
  const label = LABEL[r.kind] || r.kind;
  const c = r.counts;
  let speak;
  let status;
  if (r.cancelled) {
    status = 'หยุดกลางคัน';
    speak = `หยุดรัน${label}แล้วครับ`;
  } else if (r.timedOut) {
    status = 'หมดเวลา';
    speak = `รัน${label}นานเกินไป จึงหยุดให้แล้วครับ`;
  } else if (r.ok) {
    status = 'ผ่าน';
    speak = c && c.passed ? `${label}ผ่านทั้งหมด ${c.passed} ข้อครับ` : `${label}ผ่านครับ`;
  } else {
    status = 'ไม่ผ่าน';
    speak = c && c.failed
      ? `${label}ไม่ผ่าน ${c.failed} ข้อ จาก ${c.passed + c.failed} ข้อ ดูรายละเอียดบนจอครับ`
      : `${label}ไม่ผ่าน ดูรายละเอียดบนจอครับ`;
  }
  const icon = r.ok ? '✅' : r.cancelled ? '⏹' : '❌';
  const md = [
    `## ${icon} ${r.command} — ${status}`,
    '',
    `- เวลา: ${secs(r.durationMs)}${r.exitCode != null ? ` · exit code ${r.exitCode}` : ''}`,
  ];
  if (c) md.push(`- ผ่าน ${c.passed} · ไม่ผ่าน ${c.failed}`);
  if (!r.ok && r.error) md.push(`- จุดที่ผิดจุดแรก: \`${r.error.replace(/`/g, "'")}\``);
  if (!r.ok && !r.cancelled) md.push('- พูดว่า "แก้ให้ผ่าน" ได้เลย JARVIS เห็นผลรันนี้แล้ว');
  md.push('', '### Output (ท้ายสุด)', '```', fence(String(r.tail || '(ไม่มี output)').split('\n').slice(-150).join('\n')), '```');
  return {
    title: `${r.command} — ${status}`,
    markdown: md.join('\n'),
    speak,
    line: `${icon} ${r.command}: ${status}${c ? ` (ผ่าน ${c.passed} · ไม่ผ่าน ${c.failed})` : ''} · ${secs(r.durationMs)}`,
    ok: r.ok,
  };
}

/**
 * @param {{scope:'turn'|'uncommitted', files:{file:string,add:number|null,del:number|null}[], created:string[],
 *          patch:string, truncated:boolean, add:number, del:number}} d
 */
export function diffReport(d) {
  const title = d.scope === 'turn' ? 'การแก้ของงานล่าสุด' : 'การแก้ที่ยังไม่ commit';
  const n = d.files.length;
  const k = d.created.length;
  if (!n && !k) {
    return { title, markdown: `## ${title}\n\nไม่มีไฟล์ที่เปลี่ยน`, speak: 'ยังไม่มีการแก้ไฟล์ครับ', empty: true };
  }
  const parts = [];
  if (n) parts.push(`แก้ ${n} ไฟล์ เพิ่ม ${d.add} บรรทัด ลบ ${d.del} บรรทัด`);
  if (k) parts.push(`สร้างไฟล์ใหม่ ${k} ไฟล์`);
  const md = [`## ${title}`, '', parts.join(' · ')];
  if (n) {
    md.push('', '| ไฟล์ | + | − |', '|---|---|---|');
    for (const f of d.files) md.push(`| ${cell(f.file)} | ${f.add ?? 'bin'} | ${f.del ?? 'bin'} |`);
  }
  if (k) {
    md.push('', '### ไฟล์ใหม่ (ยังไม่อยู่ใน git)');
    for (const f of d.created.slice(0, 100)) md.push(`- \`${f.replace(/`/g, "'")}\``);
    if (k > 100) md.push(`- …และอีก ${k - 100} ไฟล์`);
  }
  if (d.patch) md.push('', '### Diff', '```', fence(d.patch.replace(/\n$/, '')), '```');
  if (d.truncated) md.push('', '_diff ยาวเกิน จึงตัดท้ายออก_');
  return { title, markdown: md.join('\n'), speak: `${parts.join(' ')} ดูบนจอครับ`, empty: false };
}

/** Lines for the undo confirmation card. */
export function undoLines(p) {
  const lines = [];
  if (p.restore.length) lines.push(`คืนค่า ${p.restore.length} ไฟล์: ${p.restore.slice(0, 12).join(', ')}${p.restore.length > 12 ? ' …' : ''}`);
  if (p.remove.length) lines.push(`ย้ายไฟล์ที่สร้างใหม่ ${p.remove.length} ไฟล์ไปถังขยะ: ${p.remove.slice(0, 12).join(', ')}${p.remove.length > 12 ? ' …' : ''}`);
  if (p.headMoved) lines.push('มีการ commit หลังจุดนั้น — commit ยังอยู่ แค่ไฟล์จะกลับไปเป็นแบบเดิม');
  return lines;
}
