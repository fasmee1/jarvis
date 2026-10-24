// One collapsible tool-call row ("Read อ่านไฟล์ … ✓ เสร็จ"), shared by the live
// conversation and the history preview so both look the same.

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}

export function diffDetails(preview) {
  const box = el('div', { class: 'diff mono' });
  for (const d of preview.diff.slice(0, 400)) {
    const cls = d.op === '+' ? 'add' : d.op === '-' ? 'del' : d.op === '@' || d.op === '!' ? 'hdr' : '';
    box.append(el('div', { class: cls, text: `${d.op === '@' || d.op === '!' ? '' : d.op} ${d.line}` }));
  }
  return el('details', { open: '' }, el('summary', { text: `diff ${preview.file || ''}${preview.isNew ? ' (ไฟล์ใหม่)' : ''}` }), box);
}

/** @returns {{d: HTMLElement, status: HTMLElement}} a row in the "running" state */
export function buildToolRow(a) {
  const status = el('span', { class: 'cv-tool-st', text: '● กำลังทำงาน' });
  const d = el('details', { class: `cv-tool running${a.parent ? ' sub' : ''}` },
    el('summary', {}, el('span', { class: 'cv-tool-n', text: a.name }), el('span', { class: 'cv-tool-s', text: a.summary || '' }), status));
  if (a.preview && a.preview.diff) d.append(diffDetails(a.preview));
  else d.append(el('pre', { class: 'cv-tool-io mono', text: JSON.stringify(a.input, null, 2) }));
  return { d, status };
}

/** a: {isError, decision?, text} — the tool's result. */
export function finishRow(r, a) {
  r.d.classList.remove('running');
  r.d.classList.add(a.isError ? 'err' : 'ok');
  r.status.textContent = a.isError ? (a.decision === 'reject' || /denied|ปฏิเสธ/i.test(a.text) ? '✕ ถูกปฏิเสธ' : '✕ ผิดพลาด') : '✓ เสร็จ';
  if (a.text) r.d.append(el('div', { class: 'cv-tool-lbl', text: 'ผลลัพธ์' }), el('pre', { class: 'cv-tool-io mono', text: a.text.slice(0, 3000) }));
}

/** A finished row from history. A call with no recorded result (the session was cut off) shows no status. */
export function historyToolRow(part) {
  const r = buildToolRow(part);
  if (part.result) finishRow(r, { isError: part.result.isError, text: part.result.text || '' });
  else {
    r.d.classList.remove('running');
    r.status.textContent = '';
  }
  return r.d;
}

/** An old screen result in the history: a card that opens the original result again. */
export function historyResultRow(part, open) {
  const d = part.data || {};
  return el('div', { class: 'cv-result' },
    el('span', { class: 'cv-result-t', text: `ผลลัพธ์: ${d.title || d.type || 'ผลลัพธ์'}` }),
    el('button', { class: 'cv-result-open', type: 'button', text: 'เปิดดู', onclick: () => open(d) }));
}
