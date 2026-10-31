'use strict';
// The question panel's DOM code (renderer/approval/question-form.js) on a tiny fake document:
// tabs, round buttons vs check boxes, moving on after a one-answer question, the text row, the answers.
const test = require('node:test');
const assert = require('node:assert');

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.attrs = {};
    this.className = '';
    this.hidden = false;
    this.checked = false;
    this.value = '';
    this._text = '';
    const self = this;
    this.classList = {
      toggle(c, on) {
        const set = new Set(self.className.split(' ').filter(Boolean));
        if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c);
        self.className = [...set].join(' ');
      },
      add(c) { this.toggle(c, true); },
      contains(c) { return self.className.split(' ').includes(c); },
    };
  }
  set textContent(t) { this._text = String(t); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  append(...kids) { this.children.push(...kids); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  fire(ev) { for (const fn of this.listeners[ev] || []) fn({ target: this }); }
  find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.find(pred, out)); return out; }
}

const load = async () => {
  global.document = { createElement: (t) => new El(t) };
  return import('../renderer/approval/question-form.js');
};

const QS = [
  { question: 'สัมภาษณ์แบบไหน', header: 'ความลึก', multiSelect: false, options: [{ label: 'ละเอียด (แนะนำ)', description: 'ครบทุกหัวข้อ' }, { label: 'ย่อ', description: '' }] },
  { question: 'แพลตฟอร์มไหน', header: 'แพลตฟอร์ม', multiSelect: true, options: [{ label: 'เว็บ' }, { label: 'มือถือ' }, { label: 'คอมพิวเตอร์' }] },
];

test('panel: one-answer questions use round buttons, several-answer ones use check boxes', async () => {
  const { buildQuestionForm } = await load();
  const f = buildQuestionForm(QS);
  const inputs = f.el.find((e) => e.tagName === 'INPUT');
  const kinds = inputs.map((i) => i.type);
  assert.deepStrictEqual(kinds, ['radio', 'radio', 'text', 'checkbox', 'checkbox', 'checkbox', 'text']);
  assert.strictEqual(inputs[0].name, 'q0');
  assert.strictEqual(inputs[0].checked, true); // the recommended one is ticked from the start
  assert.strictEqual(inputs[1].checked, false);
});

test('panel: the recommended option shows a small tag, but the answer keeps the full label', async () => {
  const { buildQuestionForm } = await load();
  const f = buildQuestionForm([QS[0]]);
  const labels = f.el.find((e) => e.className.split(' ').includes('qf-label'));
  assert.strictEqual(labels[0]._text, 'ละเอียด'); // the words in brackets are not repeated next to the tag
  assert.strictEqual(labels[0].children.length, 1);
  assert.strictEqual(labels[0].children[0].textContent, 'แนะนำ');
  assert.strictEqual(labels[1].children.length, 0); // no tag on the others
  assert.deepStrictEqual(f.answers(), [{ picked: ['ละเอียด (แนะนำ)'], text: '' }]);
});

test('panel: tabs only with several questions; one page shows at a time', async () => {
  const { buildQuestionForm } = await load();
  const f = buildQuestionForm(QS);
  const tabs = f.el.find((e) => e.className.split(' ').includes('qf-tabs'));
  assert.strictEqual(tabs.length, 1);
  const pages = f.el.find((e) => e.tagName === 'FIELDSET');
  assert.deepStrictEqual(pages.map((p) => p.hidden), [false, true]);
  const tabBtns = f.el.find((e) => e.className.split(' ').includes('qf-tab'));
  assert.deepStrictEqual(tabBtns.map((t) => t.textContent), ['ความลึก', 'แพลตฟอร์ม']);
  tabBtns[1].fire('click');
  assert.deepStrictEqual(pages.map((p) => p.hidden), [true, false]);

  const single = buildQuestionForm([QS[0]]);
  assert.strictEqual(single.el.children.some((c) => c.className.split(' ').includes('qf-tabs')), false);
});

test('panel: choosing moves on to the next open question, ticking several works, text alone answers', async () => {
  const { buildQuestionForm } = await load();
  let changes = 0;
  const f = buildQuestionForm(QS, () => { changes++; });
  const inputs = f.el.find((e) => e.tagName === 'INPUT');
  const pages = f.el.find((e) => e.tagName === 'FIELDSET');
  assert.strictEqual(f.complete(), false); // question 2 is still empty

  inputs[1].checked = true; inputs[1].fire('change'); // round button: "ย่อ" replaces the recommended one
  assert.strictEqual(inputs[0].checked, false);
  assert.deepStrictEqual(pages.map((p) => p.hidden), [true, false]); // moved on to question 2

  inputs[3].checked = true; inputs[3].fire('change'); // check boxes: two ticked
  inputs[5].checked = true; inputs[5].fire('change');
  assert.strictEqual(f.complete(), true);
  assert.deepStrictEqual(f.answers(), [{ picked: ['ย่อ'], text: '' }, { picked: ['เว็บ', 'คอมพิวเตอร์'], text: '' }]);

  inputs[3].checked = false; inputs[3].fire('change'); // untick one
  assert.deepStrictEqual(f.answers()[1].picked, ['คอมพิวเตอร์']);
  inputs[5].checked = false; inputs[5].fire('change');
  assert.strictEqual(f.complete(), false);
  const typed = inputs[6]; // the text row of question 2
  typed.value = 'ทุกอย่างเลย'; typed.fire('input');
  assert.strictEqual(f.complete(), true);
  assert.deepStrictEqual(f.answers()[1], { picked: [], text: 'ทุกอย่างเลย' });
  assert.ok(changes >= 5);
});

test('panel: the text of a question comes from textContent only (no markup is built from it)', async () => {
  const { buildQuestionForm } = await load();
  const f = buildQuestionForm([{ question: '<img src=x onerror=alert(1)>', header: '', multiSelect: false, options: [{ label: '<b>x</b>', description: '' }] }]);
  const all = f.el.find(() => true);
  assert.ok(all.every((e) => !('innerHTML' in e)));
  assert.match(f.el.textContent, /<img src=x onerror=alert\(1\)>/); // shown as text
});
