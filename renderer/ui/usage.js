// Real Claude Code usage on DIAGNOSTICS: the 5-hour and weekly limit windows
// (% used + reset time, from Anthropic) and token counts from the transcripts.

const $ = (id) => document.getElementById(id);

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const DATE = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const TIME = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** 15820658 → "15.82M", 128697 → "128.7k" */
export function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString();
}

/** ms until reset → "อีก 2 ชม. 5 นาที" / "อีก 3 วัน 4 ชม." */
export function until(ms) {
  if (ms <= 0) return 'รีเซ็ตแล้ว';
  const m = Math.ceil(ms / 60000);
  const d = Math.floor(m / 1440);
  const hr = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d) return `อีก ${d} วัน ${hr} ชม.`;
  if (hr) return `อีก ${hr} ชม. ${min} นาที`;
  return `อีก ${min} นาที`;
}

const level = (u) => (u >= 0.9 ? 'full' : u >= 0.7 ? 'warn' : '');

function renderLimit(box, name, win, now) {
  box.replaceChildren();
  const row = h('div', 'row1');
  row.append(h('span', 'name', name));
  const pct = h('span', 'pct', '—');
  row.append(pct);
  const bar = h('div', 'bar');
  const fill = h('i');
  bar.append(fill);
  const reset = h('div', 'reset');
  box.append(row, bar, reset);
  if (!win) {
    reset.textContent = 'ยังไม่มีข้อมูล — คุยกับ JARVIS 1 ครั้ง หรือกด "อัปเดตเปอร์เซ็นต์ตอนนี้"';
    return;
  }
  if (win.expired) {
    pct.textContent = '—';
    reset.append('รีเซ็ตไปแล้วเมื่อ ', h('b', '', DATE.format(new Date(win.resetsAt))), ' — จะเห็นตัวเลขใหม่หลังคุยรอบถัดไป');
    return;
  }
  const u = Math.max(0, win.utilization);
  pct.textContent = `${Math.round(u * 100)}%`;
  pct.className = `pct ${level(u)}`;
  fill.className = level(u);
  fill.style.setProperty('--p', Math.min(1, u).toFixed(3));
  reset.append('รีเซ็ต ', h('b', '', DATE.format(new Date(win.resetsAt))), ` · ${until(win.resetsAt - now)}`);
}

function renderTable(table, tokens) {
  table.replaceChildren();
  if (!tokens) {
    table.append(h('caption', 'dim', 'กำลังนับ token…'));
    return;
  }
  const cols = [
    ['today', 'วันนี้'],
    ['fiveHour', 'รอบ 5 ชม. นี้'],
    ['week', 'สัปดาห์นี้ (จ.–อา.)'],
    ['sevenDay', 'รอบลิมิตรายสัปดาห์'],
  ].filter(([k]) => tokens[k]);
  const head = h('thead');
  const hr = h('tr');
  hr.append(h('th', '', 'token'));
  for (const [, label] of cols) hr.append(h('th', '', label));
  head.append(hr);
  const body = h('tbody');
  const rows = [
    ['input', 'input'],
    ['output', 'output'],
    ['cacheWrite', 'cache write'],
    ['cacheRead', 'cache read'],
    ['total', 'รวม'],
    ['requests', 'จำนวนคำขอ'],
  ];
  for (const [k, label] of rows) {
    const tr = h('tr', k === 'total' ? 'total' : '');
    tr.append(h('td', '', label));
    for (const [c] of cols) tr.append(h('td', '', k === 'requests' ? tokens[c][k].toLocaleString() : fmtTokens(tokens[c][k])));
    body.append(tr);
  }
  const tr = h('tr');
  tr.append(h('td', '', 'แยกตามโมเดล'));
  for (const [c] of cols) {
    const by = Object.entries(tokens[c].byModel || {}).sort((a, b) => b[1] - a[1]);
    tr.append(h('td', 'models', by.length ? by.map(([m, n]) => `${m} ${fmtTokens(n)}`).join(' · ') : '—'));
  }
  body.append(tr);
  table.append(head, body);
}

export class UsagePanel {
  /** @param {{api: object, onSnapshot?: (snap: object) => void, notice: (t: string, l?: string) => void}} o */
  constructor(o) {
    this.o = o;
    this.snap = null;
    $('usage-ping').addEventListener('click', () => this.ping());
    o.api.on('usage', (s) => this.set(s));
    // countdowns tick even when nothing new arrives
    setInterval(() => { if (this.snap && !$('usage-panel').closest('[hidden]')) this.render(); }, 30000);
  }

  async load() {
    const s = await this.o.api.invoke('usage:get').catch(() => null);
    if (s) this.set(s);
  }

  set(s) {
    this.snap = s;
    this.render();
    if (this.o.onSnapshot) this.o.onSnapshot(s);
  }

  render() {
    const s = this.snap || {};
    const now = Date.now();
    const l = s.limits;
    renderLimit($('usage-5h'), 'ลิมิตรอบ 5 ชั่วโมง', l && l.fiveHour, now);
    renderLimit($('usage-7d'), 'ลิมิตรายสัปดาห์', l && l.sevenDay, now);
    renderTable($('usage-table'), s.tokens);
    const parts = [];
    if (l && l.capturedAt) parts.push(`ลิมิต ${TIME.format(new Date(l.capturedAt))}`);
    if (s.scannedAt) parts.push(`token ${TIME.format(new Date(s.scannedAt))}`);
    $('usage-updated').textContent = parts.length ? `อัปเดต: ${parts.join(' · ')}` : '';
    if (s.error) $('usage-updated').textContent += ` · ${s.error}`;
  }

  async ping() {
    const b = $('usage-ping');
    b.disabled = true;
    b.textContent = 'กำลังถาม Claude Code…';
    const r = await this.o.api.invoke('usage:ping').catch((err) => ({ ok: false, error: err.message }));
    b.disabled = false;
    b.textContent = '↻ อัปเดตเปอร์เซ็นต์ตอนนี้';
    if (r.snapshot) this.set(r.snapshot);
    if (!r.ok) this.o.notice(r.error || 'อัปเดตไม่สำเร็จ', 'warn');
  }
}
