// "สกิล" tab of the EDIT section: pick the skill JARVIS edits by, upload a SKILL.md, write /
// change / delete your own, reset a built-in, and write a note for this clip only.
// Styles are stored in the main process (lib/video/styles.js); this only shows them.

import { el } from '../blocks.js';

const $ = (id) => document.getElementById(id);

/** "30 วินาที" · "1 นาที 30 วินาที" · 0 → "ไม่จำกัดความยาว" */
export function fmtTarget(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return 'ไม่จำกัดความยาว';
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return `ไม่เกิน ${r} วินาที`;
  return `ไม่เกิน ${m} นาที${r ? ` ${r} วินาที` : ''}`;
}

const PACE_SHORT = { fast: 'จังหวะเร็ว', normal: 'จังหวะปานกลาง', slow: 'จังหวะช้า' };

export class StylePicker {
  /** api: window.jarvis · notice(text, level) */
  constructor({ api, notice }) {
    this.api = api;
    this.notice = notice;
    this.styles = [];
    this.paces = [];
    this.selected = null;
    this.editing = null; // id being edited, '' for a new one
    this._wire();
    this.load();
  }

  async load() {
    try {
      this._apply(await this.api.invoke('video:styles'));
    } catch (err) {
      this.notice(`โหลดสกิลไม่ได้: ${err.message}`, 'error');
    }
  }

  /** The chosen style and this clip's note, for the edit request. */
  choice() {
    const style = this.styles.find((s) => s.id === this.selected) || null;
    return { style, note: $('ve-note').value.trim() };
  }

  _apply(r) {
    this.styles = r.styles;
    this.paces = r.paces;
    if (!this.styles.some((s) => s.id === this.selected)) this.selected = r.last;
    this.render();
  }

  _wire() {
    $('ve-style-add').onclick = () => this.openEditor(null);
    $('ve-skill-import').onclick = (e) => e.isTrusted && this.importSkill();
    const dlg = $('ve-style-dialog');
    $('ve-sd-cancel').onclick = () => this.closeEditor();
    $('ve-sd-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveEditor();
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // close the dialog, not the EDIT section
        this.closeEditor();
      }
    });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) this.closeEditor(); });
    $('ve-sd-prompt').addEventListener('input', () => this._count());
  }

  async pick(id) {
    if (this.selected === id) return;
    this.selected = id;
    this.render();
    try {
      this._apply(await this.api.invoke('video:style-pick', id));
    } catch { /* remembered next time only */ }
  }

  render() {
    const box = $('ve-styles');
    box.replaceChildren(...this.styles.map((s) => this._card(s)));
    const cur = this.styles.find((s) => s.id === this.selected);
    $('ve-style-prompt').textContent = cur ? cur.prompt : '';
  }

  _card(s) {
    const on = s.id === this.selected;
    const actions = el('span', { class: 've-style-actions' },
      el('button', { class: 've-mini', type: 'button', text: 'แก้', title: 'แก้ชื่อ คำแนะนำ และจังหวะของสกิลนี้', onclick: (e) => { e.stopPropagation(); this.openEditor(s); } }),
      s.builtin && s.edited ? el('button', { class: 've-mini', type: 'button', text: 'คืนค่าเดิม', onclick: (e) => { e.stopPropagation(); this.reset(s); } }) : null,
      !s.builtin ? el('button', { class: 've-mini danger', type: 'button', text: 'ลบ', onclick: (e) => { e.stopPropagation(); this.remove(s); } }) : null);
    const card = el('div', { class: `ve-style${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), tabindex: '0', title: s.prompt },
      el('div', { class: 've-style-head' },
        el('span', { class: 've-style-name', text: s.name }),
        s.builtin ? el('span', { class: 've-style-tag', text: 'สำเร็จรูป' }) : el('span', { class: 've-style-tag', text: s.skill ? 'อัปโหลด' : 'เขียนเอง' }),
        s.builtin && s.edited ? el('span', { class: 've-style-tag', text: 'แก้แล้ว' }) : null),
      s.description ? el('div', { class: 've-style-desc', text: s.description }) : null,
      el('div', { class: 've-style-meta', text: `${PACE_SHORT[s.pace] || s.pace} · ${fmtTarget(s.targetSec)}` }),
      actions);
    card.addEventListener('click', () => this.pick(s.id));
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        this.pick(s.id);
      }
    });
    return card;
  }

  /** Upload a SKILL.md: the main process shows the file dialog and reads it. */
  async importSkill() {
    try {
      const r = await this.api.invoke('video:skill-import');
      if (r.cancelled) return;
      this.selected = r.saved;
      this._apply(r);
      const s = this.styles.find((x) => x.id === r.saved);
      this.notice(`เพิ่มสกิล "${s ? s.name : ''}" แล้ว และเลือกไว้ให้`, 'info', null, 3000);
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'error');
    }
  }

  async remove(s) {
    if (!confirm(`ลบสกิล "${s.name}"?`)) return;
    try {
      this._apply(await this.api.invoke('video:style-remove', s.id));
      this.notice(`ลบสกิล ${s.name} แล้ว`, 'info', null, 3000);
    } catch (err) {
      this.notice(err.message, 'error');
    }
  }

  async reset(s) {
    if (!confirm(`คืนสกิล "${s.name}" เป็นแบบเดิมของ JARVIS?`)) return;
    try {
      this._apply(await this.api.invoke('video:style-reset', s.id));
    } catch (err) {
      this.notice(err.message, 'error');
    }
  }

  // ---------- add / edit dialog ----------
  openEditor(s) {
    this.editing = s ? s.id : '';
    $('ve-sd-title').textContent = s ? `แก้สกิล: ${s.name}` : 'เขียนสกิลเอง';
    $('ve-sd-name').value = s ? s.name : '';
    $('ve-sd-prompt').value = s ? s.prompt : '';
    $('ve-sd-target').value = s ? String(s.targetSec) : '60';
    const sel = $('ve-sd-pace');
    sel.replaceChildren(...this.paces.map((p) => el('option', { value: p.id, text: p.label })));
    sel.value = s ? s.pace : 'normal';
    $('ve-sd-error').textContent = '';
    this._count();
    $('ve-style-dialog').hidden = false;
    $('ve-sd-name').focus();
  }

  closeEditor() {
    $('ve-style-dialog').hidden = true;
    this.editing = null;
  }

  _count() {
    $('ve-sd-count').textContent = `${$('ve-sd-prompt').value.length.toLocaleString()}/60,000`;
  }

  async saveEditor() {
    const payload = {
      name: $('ve-sd-name').value,
      prompt: $('ve-sd-prompt').value,
      pace: $('ve-sd-pace').value,
      targetSec: Number($('ve-sd-target').value || 0),
    };
    if (this.editing) payload.id = this.editing;
    try {
      const r = await this.api.invoke('video:style-save', payload);
      if (!this.editing) this.selected = r.saved; // a new style is picked right away
      this._apply(r);
      if (!this.editing) this.api.invoke('video:style-pick', r.saved).catch(() => {});
      this.closeEditor();
      this.notice('บันทึกสกิลแล้ว', 'info', null, 2500);
    } catch (err) {
      // IPC errors arrive as "Error invoking remote method '…': Error: <message>"
      $('ve-sd-error').textContent = String(err.message || err).replace(/^.*Error: /, '');
    }
  }
}
