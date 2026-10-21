// History panel inside the conversation popup: past conversations of the
// current project (Claude Code's own transcripts), a read-only preview, and
// "ทำต่อจากบทสนทนานี้" which continues one with --resume.

import { linkParts } from './result-utils.js';

const $ = (id) => document.getElementById(id);

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

const DAY = new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' });
const FULL = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function dayLabel(d) {
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'วันนี้';
  if (d.toDateString() === y.toDateString()) return 'เมื่อวาน';
  return DAY.format(d);
}

export class HistoryPanel {
  /**
   * @param {{api: object, onResumed: (messages: object[], item: object) => void, notice: (text: string, level?: string) => void}} o
   */
  constructor(o) {
    this.o = o;
    this.root = $('cv-hist');
    this.body = $('cv-hist-body');
    this.btn = $('btn-history');
    this.search = $('cv-hist-search');
    this.items = [];
    this.current = null;
    this.viewing = null;
    this.btn.addEventListener('click', () => this.toggle());
    $('cv-hist-close').addEventListener('click', () => this.close());
    $('cv-hist-back').addEventListener('click', () => this.showList());
    $('cv-hist-resume').addEventListener('click', () => this.resume());
    this.search.addEventListener('input', () => this.renderList());
  }

  get isOpen() {
    return !this.root.hidden;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  async open() {
    this.root.hidden = false;
    this.btn.classList.add('on');
    this.btn.setAttribute('aria-pressed', 'true');
    this.showList();
    this.body.replaceChildren(el('div', { class: 'cv-hist-empty', text: 'กำลังโหลด…' }));
    const r = await this.o.api.invoke('history:list').catch((err) => ({ ok: false, error: err.message }));
    if (!this.isOpen) return;
    if (!r.ok) {
      this.body.replaceChildren(el('div', { class: 'cv-hist-empty', text: r.error || 'โหลดประวัติไม่ได้' }));
      return;
    }
    this.items = r.sessions;
    this.current = r.current;
    this.cwd = r.cwd;
    this.renderList();
    this.search.focus();
  }

  /** @returns {boolean} true when it was open (Esc closes this before the popup) */
  close() {
    if (!this.isOpen) return false;
    this.root.hidden = true;
    this.btn.classList.remove('on');
    this.btn.setAttribute('aria-pressed', 'false');
    this.viewing = null;
    return true;
  }

  /** Esc: back from a preview to the list, else close. */
  escape() {
    if (!this.isOpen) return false;
    if (this.viewing) this.showList();
    else this.close();
    return true;
  }

  showList() {
    this.viewing = null;
    $('cv-hist-back').hidden = true;
    $('cv-hist-resume').hidden = true;
    this.search.hidden = false;
    $('cv-hist-title').textContent = 'ประวัติการสนทนา';
    this.renderList();
  }

  renderList() {
    if (this.viewing) return;
    const q = this.search.value.trim().toLowerCase();
    const list = q ? this.items.filter((s) => s.title.toLowerCase().includes(q)) : this.items;
    this.body.replaceChildren();
    if (!this.cwd) return this.body.append(el('div', { class: 'cv-hist-empty', text: 'ยังไม่ได้เลือกโฟลเดอร์โปรเจกต์' }));
    if (!list.length) return this.body.append(el('div', { class: 'cv-hist-empty', text: q ? 'ไม่พบบทสนทนาที่ตรงกับคำค้น' : 'ยังไม่มีประวัติการสนทนาในโปรเจกต์นี้' }));
    let lastDay = '';
    for (const s of list) {
      const d = new Date(s.updatedAt);
      const day = dayLabel(d);
      if (day !== lastDay) {
        this.body.append(el('div', { class: 'cv-hist-day', text: day }));
        lastDay = day;
      }
      const item = el('button', { class: 'cv-hist-item', type: 'button', title: s.title, onclick: () => this.preview(s) },
        el('span', { class: 't', text: s.title }),
        el('span', { class: 'd', text: TIME.format(d) }));
      if (s.id === this.current) item.append(el('span', { class: 'now', text: '● บทสนทนาที่ใช้อยู่ตอนนี้' }));
      this.body.append(item);
    }
  }

  async preview(s) {
    this.viewing = s;
    $('cv-hist-back').hidden = false;
    this.search.hidden = true;
    $('cv-hist-title').textContent = s.title;
    $('cv-hist-resume').hidden = s.id === this.current;
    this.body.replaceChildren(el('div', { class: 'cv-hist-empty', text: 'กำลังโหลด…' }));
    const r = await this.o.api.invoke('history:read', s.id).catch((err) => ({ ok: false, error: err.message }));
    if (this.viewing !== s) return;
    this.body.replaceChildren();
    if (!r.ok) return this.body.append(el('div', { class: 'cv-hist-empty', text: r.error }));
    if (s.startedAt) this.body.append(el('div', { class: 'cv-hist-day', text: `เริ่มเมื่อ ${FULL.format(new Date(s.startedAt))} · ${r.messages.length} ข้อความ` }));
    // URLs become a.cv-link; app.js opens them in the browser
    for (const m of r.messages) {
      this.body.append(el('div', { class: `msg ${m.role}` }, ...linkParts(m.text).map((p) => (p.url
        ? el('a', { class: 'cv-link', href: p.url, title: p.url, text: p.text })
        : document.createTextNode(p.text)))));
    }
    $('cv-hist-back').focus();
  }

  async resume() {
    const s = this.viewing;
    if (!s) return;
    const r = await this.o.api.invoke('history:resume', s.id).catch((err) => ({ ok: false, error: err.message }));
    if (!r.ok) return this.o.notice(r.error, 'warn');
    this.close();
    this.o.onResumed(r.messages, s);
  }
}
