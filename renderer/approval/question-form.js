// Question panel body, like Claude.ai's: one question at a time (tabs when there are several),
// options as rows with a check box (several answers) or a round button (one answer), and a row to
// type your own answer. Built with DOM APIs and textContent only (the text comes from the model).
import { initialState, toggle, choose, isComplete, collect, isRecommended } from './question-logic.js';

function node(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {{question:string, header:string, multiSelect:boolean, options:{label:string, description:string}[]}[]} questions
 * @param {() => void} onChange called after every tick / keystroke
 * @returns {{el:HTMLElement, complete:() => boolean, answers:() => object[]}}
 */
export function buildQuestionForm(questions, onChange = () => {}) {
  const state = initialState(questions);
  const root = node('div', 'qf');
  const tabs = node('div', 'qf-tabs');
  tabs.setAttribute('role', 'tablist');
  const pages = [];
  let active = 0;

  const refresh = () => {
    pages.forEach((p, i) => {
      p.box.hidden = i !== active;
      p.tab.classList.toggle('on', i === active);
      p.tab.setAttribute('aria-selected', String(i === active));
      p.tab.classList.toggle('done', state[i].picked.size > 0 || state[i].text.trim().length > 0);
    });
  };
  const nextOpen = (from) => {
    for (let i = from + 1; i < questions.length; i++) if (!(state[i].picked.size || state[i].text.trim())) return i;
    return -1;
  };

  questions.forEach((q, qi) => {
    const tab = node('button', 'qf-tab', q.header || `ข้อ ${qi + 1}`);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => { active = qi; refresh(); });
    tabs.append(tab);

    const box = node('fieldset', 'qf-q');
    box.append(node('legend', 'qf-text', q.question));
    box.append(node('div', 'qf-hint', q.multiSelect ? 'เลือกได้หลายข้อ' : 'เลือกได้ข้อเดียว'));

    const rows = [];
    q.options.forEach((o) => {
      const row = node('label', 'qf-opt');
      // several answers allowed: square check boxes · only one allowed: round buttons (radio)
      const cb = document.createElement('input');
      cb.type = q.multiSelect ? 'checkbox' : 'radio';
      if (!q.multiSelect) cb.name = `q${qi}`;
      cb.checked = state[qi].picked.has(o.label);
      const body = node('span', 'qf-body');
      // the recommended option shows a small "แนะนำ" tag instead of the words in brackets (the answer keeps the full label)
      const rec = isRecommended(o);
      const title = node('span', 'qf-label', rec ? o.label.replace(/\s*[(（]\s*(?:แนะนำ|recommended)\s*[)）]\s*/i, ' ').trim() : o.label);
      if (rec) title.append(node('span', 'qf-pill', 'แนะนำ'));
      body.append(title);
      if (o.description) body.append(node('span', 'qf-desc', o.description));
      row.append(cb, body);
      cb.addEventListener('change', () => {
        if (q.multiSelect) toggle(state, qi, q, o.label);
        else choose(state, qi, o.label);
        rows.forEach((r) => { r.cb.checked = state[qi].picked.has(r.label); });
        // a one-answer question moves on to the next unanswered one by itself
        if (!q.multiSelect) {
          const n = nextOpen(qi);
          if (n >= 0) active = n;
        }
        refresh();
        onChange();
      });
      rows.push({ cb, label: o.label });
      box.append(row);
    });

    const other = node('label', 'qf-opt qf-other');
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 1000;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'อื่น ๆ — พิมพ์ตอบเองหรือเพิ่มเติม';
    input.addEventListener('input', () => { state[qi].text = input.value; refresh(); onChange(); });
    other.append(input);
    box.append(other);
    pages.push({ tab, box });
  });

  if (questions.length > 1) root.append(tabs);
  pages.forEach((p) => root.append(p.box));
  refresh();
  return { el: root, complete: () => isComplete(state), answers: () => collect(state, questions) };
}
