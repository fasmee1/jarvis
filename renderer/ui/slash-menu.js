// "/" menu over the message input: lists Claude Code skills and commands, filters as you
// type, ↑/↓ to move, Enter or Tab to fill in "/name ", Esc to close.
import { el } from '../blocks.js';

const MAX_ITEMS = 50;
const SOURCE_LABEL = { project: 'โปรเจกต์', user: 'ส่วนตัว', plugin: 'ปลั๊กอิน', claude: 'Claude', jarvis: 'JARVIS' };

/** Ranks items for a query: name prefix, then part-after-":" prefix, then name contains, then description. */
export function filterCommands(items, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return items.slice(0, MAX_ITEMS);
  const scored = [];
  for (const it of items) {
    const n = it.name.toLowerCase();
    const tail = n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n;
    let s = -1;
    if (n.startsWith(q)) s = 0;
    else if (tail.startsWith(q)) s = 1;
    else if (n.includes(q)) s = 2;
    else if ((it.description || '').toLowerCase().includes(q)) s = 3;
    if (s >= 0) scored.push([s, it]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, MAX_ITEMS).map((x) => x[1]);
}

/** The "/query" being typed: input starts with "/" and the caret is still in the first word. */
export function slashQuery(value, caret) {
  const v = String(value || '');
  if (!v.startsWith('/')) return null;
  const head = v.slice(0, caret ?? v.length);
  if (/\s/.test(head)) return null;
  return head.slice(1);
}

export class SlashMenu {
  /**
   * Construct BEFORE the conversation popup: this listens on window (capture) and must see
   * Tab / Esc / Enter before the popup's own shortcuts do.
   * @param {{input: HTMLTextAreaElement, load: () => Promise<object[]>, onChange?: () => void}} o
   */
  constructor(o) {
    this.o = o;
    this.input = o.input;
    this.items = [];
    this.shown = [];
    this.active = 0;
    this.loadedAt = 0;
    this.box = el('div', { class: 'slash-menu', role: 'listbox', 'aria-label': 'คำสั่งและ skill' });
    this.box.id = o.id || 'slash-menu'; // one menu per input: ids must differ
    this.box.hidden = true;
    const composer = this.input.closest('.cv-composer') || this.input.parentElement;
    composer.before(this.box);
    this.input.setAttribute('aria-controls', this.box.id);
    this.input.setAttribute('aria-autocomplete', 'list');

    this._wireHighlight();
    this.input.addEventListener('input', () => { this.update(); this.paint(); });
    this.input.addEventListener('click', () => this.update());
    this.input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== this.input) this.close(); }, 120));
    addEventListener('keydown', (e) => this._key(e), true);
    // a click picks without taking focus away from the input
    this.box.addEventListener('mousedown', (e) => e.preventDefault());
    this.box.addEventListener('click', (e) => {
      const row = e.target.closest('.slash-item');
      if (row) this.pick(this.shown[Number(row.dataset.i)]);
    });
  }

  get open() {
    return !this.box.hidden;
  }

  // ---------- highlight of "/skill" in the input ----------
  // A textarea can't style part of its text, so a layer behind it repeats the text
  // (invisible) with the command wrapped in <mark>; the textarea itself is see-through.
  _wireHighlight() {
    const wrap = el('div', { class: 'slash-wrap' });
    this.input.before(wrap);
    this.back = el('div', { class: 'slash-back', 'aria-hidden': 'true' });
    wrap.append(this.back, this.input);
    this.input.addEventListener('scroll', () => { this.back.scrollTop = this.input.scrollTop; });
  }

  /** Redraw the highlight; call after changing the input's value from code. */
  async paint() {
    const v = this.input.value;
    const m = /^\/(\S+)/.exec(v);
    let hit = false;
    if (m) {
      await this._ensureLoaded();
      if (this.input.value !== v) return; // changed while loading; a newer paint follows
      const n = m[1].toLowerCase();
      hit = this.items.some((it) => it.name.toLowerCase() === n);
    }
    this.back.replaceChildren();
    if (hit) {
      const len = m[0].length;
      this.back.append(el('mark', { class: 'slash-mark' }, v.slice(0, len)), document.createTextNode(v.slice(len)));
    }
    this.back.append(document.createTextNode('​')); // keeps a trailing newline's height
    this.back.scrollTop = this.input.scrollTop;
  }

  async _ensureLoaded() {
    if (Date.now() - this.loadedAt < 5000) return;
    this.loadedAt = Date.now();
    try {
      this.items = (await this.o.load()) || [];
    } catch {
      this.items = [];
    }
  }

  async update() {
    const q = slashQuery(this.input.value, this.input.selectionStart);
    if (q == null) return this.close();
    await this._ensureLoaded();
    // the text may have changed while loading
    const q2 = slashQuery(this.input.value, this.input.selectionStart);
    if (q2 == null) return this.close();
    const prev = this.shown[this.active];
    this.shown = filterCommands(this.items, q2);
    const keep = prev ? this.shown.indexOf(prev) : -1;
    this.active = keep >= 0 ? keep : 0;
    this._render(q2);
  }

  _render(q) {
    this.box.replaceChildren();
    if (!this.shown.length) {
      this.box.append(el('div', { class: 'slash-empty' }, this.items.length ? `ไม่พบคำสั่งหรือ skill ที่ตรงกับ “${q}”` : 'ยังไม่พบ skill ของ Claude Code'));
    }
    this.shown.forEach((it, i) => {
      const row = el('div', { class: 'slash-item' + (i === this.active ? ' on' : ''), role: 'option', 'aria-selected': String(i === this.active) },
        el('span', { class: 'slash-name' }, '/' + it.name),
        el('span', { class: 'slash-src' }, SOURCE_LABEL[it.source] || it.source || ''),
        el('span', { class: 'slash-desc' }, it.description || ''));
      row.dataset.i = String(i);
      row.id = `${this.box.id}-opt-${i}`;
      this.box.append(row);
    });
    this.box.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    if (this.shown.length) this.input.setAttribute('aria-activedescendant', `${this.box.id}-opt-${this.active}`);
    this.box.querySelector('.slash-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  close() {
    if (this.box.hidden) return;
    this.box.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  _move(d) {
    if (!this.shown.length) return;
    this.active = (this.active + d + this.shown.length) % this.shown.length;
    this._render(slashQuery(this.input.value, this.input.selectionStart) || '');
  }

  /** Fills in "/name " (keeping anything typed after the first word). */
  pick(it) {
    if (!it) return;
    const v = this.input.value;
    const rest = v.replace(/^\/\S*\s?/, '');
    this.input.value = `/${it.name} ${rest}`;
    const at = it.name.length + 2;
    this.input.setSelectionRange(at, at);
    this.close();
    this.input.focus();
    this.paint();
    if (this.o.onChange) this.o.onChange();
  }

  _key(e) {
    if (!this.open || document.activeElement !== this.input || e.isComposing) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown') { stop(); this._move(1); }
    else if (e.key === 'ArrowUp') { stop(); this._move(-1); }
    else if (e.key === 'Escape') { stop(); this.close(); }
    else if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey)) {
      const it = this.shown[this.active];
      if (!it) { if (e.key === 'Tab') stop(); return this.close(); }
      // Enter on a name that is already typed in full sends it as usual
      if (e.key === 'Enter' && this.input.value.trim().toLowerCase() === '/' + it.name.toLowerCase()) return this.close();
      stop();
      this.pick(it);
    }
  }
}
