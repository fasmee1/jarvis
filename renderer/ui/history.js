// History panel inside the conversation popup: past conversations of the
// current project (Claude Code's own transcripts), a read-only preview, and
// "ทำต่อจากบทสนทนานี้" which continues one with --resume.

import { linkParts } from './result-utils.js';
import { historyToolRow, historyResultRow } from './tool-row.js';

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
   * @param {{api: object, onResumed: (messages: object[], item: object) => void, openResult: (data: object) => void, notice: (text: string, level?: string) => void}} o
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
    $('cv-hist-delete').addEventListener('click', (e) => this.viewing && this.confirmDelete(e.currentTarget, this.viewing, 'ลบ'));
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
    $('cv-hist-delete').hidden = true;
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
      const row = el('div', { class: 'cv-hist-row' }, item);
      if (s.id === this.current) item.append(el('span', { class: 'now', text: '● บทสนทนาที่ใช้อยู่ตอนนี้' }));
      else {
        const del = el('button', { class: 'cv-hist-del', type: 'button', title: 'ลบบทสนทนานี้', 'aria-label': `ลบ ${s.title}`, text: '🗑' });
        del.addEventListener('click', () => this.confirmDelete(del, s, '🗑'));
        row.append(del);
      }
      this.body.append(row);
    }
  }

  /** Two clicks to delete: the first turns the button into "ยืนยันลบ", the second deletes. */
  confirmDelete(btn, s, idle) {
    if (btn.dataset.armed) {
      clearTimeout(btn._t);
      return this.remove(s);
    }
    btn.dataset.armed = '1';
    btn.textContent = 'ยืนยันลบ';
    btn.classList.add('armed');
    btn._t = setTimeout(() => {
      delete btn.dataset.armed;
      btn.textContent = idle;
      btn.classList.remove('armed');
    }, 3500);
  }

  async remove(s) {
    const r = await this.o.api.invoke('history:delete', s.id).catch((err) => ({ ok: false, error: err.message }));
    if (!r.ok) return this.o.notice(r.error || 'ลบไม่ได้', 'warn');
    this.items = this.items.filter((x) => x.id !== s.id);
    this.o.notice('ย้ายบทสนทนาไปที่ถังขยะแล้ว (กู้คืนจาก Recycle Bin ได้)', 'info');
    this.showList();
  }

  /** The delete button in the preview header; the conversation in use can't be deleted. */
  resetDeleteBtn(hidden) {
    const b = $('cv-hist-delete');
    clearTimeout(b._t);
    delete b.dataset.armed;
    b.classList.remove('armed');
    b.textContent = 'ลบ';
    b.hidden = hidden;
  }

  async preview(s) {
    this.viewing = s;
    $('cv-hist-back').hidden = false;
    this.search.hidden = true;
    $('cv-hist-title').textContent = s.title;
    $('cv-hist-resume').hidden = s.id === this.current;
    this.resetDeleteBtn(s.id === this.current);
    this.body.replaceChildren(el('div', { class: 'cv-hist-empty', text: 'กำลังโหลด…' }));
    const r = await this.o.api.invoke('history:read', s.id).catch((err) => ({ ok: false, error: err.message }));
    if (this.viewing !== s) return;
    this.body.replaceChildren();
    if (!r.ok) return this.body.append(el('div', { class: 'cv-hist-empty', text: r.error }));
    if (s.startedAt) this.body.append(el('div', { class: 'cv-hist-day', text: `เริ่มเมื่อ ${FULL.format(new Date(s.startedAt))} · ${r.messages.length} ข้อความ` }));
    // URLs become a.cv-link; app.js opens them in the browser
    const words = (text) => linkParts(text).map((p) => (p.url
      ? el('a', { class: 'cv-link', href: p.url, title: p.url, text: p.text })
      : document.createTextNode(p.text)));
    for (const m of r.messages) {
      // an assistant reply keeps its tool rows (read, edit, search …) between the words
      const kids = m.parts
        ? m.parts.map((p) => {
          if (p.type === 'tool') return historyToolRow(p);
          if (p.type === 'result') return historyResultRow(p, (d) => this.o.openResult(d));
          return el('div', {}, ...words(p.text));
        })
        : words(m.text);
      this.body.append(el('div', { class: `msg ${m.role}` }, ...kids));
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
