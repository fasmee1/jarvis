// Render jarvis-* blocks with DOM APIs only (textContent — never innerHTML of
// model output), both inline in chat and in the HUD display tabs.

const SVGNS = 'http://www.w3.org/2000/svg';

export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

export function renderSteps(data) {
  const wrap = el('div');
  if (data.title) wrap.append(el('div', { class: 'accent', text: data.title }));
  const ol = el('ol', { class: 'steps-list' });
  data.steps.forEach((s, i) => {
    const li = el('li');
    if (s.done) li.classList.add('done');
    if (data.current === i + 1) li.classList.add('current');
    li.append(el('div', { text: s.title }));
    if (s.detail) li.append(el('div', { class: 'dim', text: s.detail }));
    if (s.warning) li.append(el('div', { class: 'warn', text: '⚠ ' + s.warning }));
    ol.append(li);
  });
  wrap.append(ol);
  return wrap;
}

export function renderBom(data) {
  const wrap = el('div');
  if (data.title) wrap.append(el('div', { class: 'accent', text: data.title }));
  const table = el('table', { class: 'bom' });
  const head = el('tr');
  for (const h of ['อุปกรณ์', 'จำนวน', 'สเปก', 'หมายเหตุ']) head.append(el('th', { text: h }));
  table.append(head);
  for (const it of data.items) {
    const tr = el('tr');
    tr.append(el('td', { text: it.name }), el('td', { text: String(it.qty) }), el('td', { text: it.spec || '' }), el('td', { text: it.note || '' }));
    table.append(tr);
  }
  wrap.append(table);
  return wrap;
}

export function renderDiagram(data) {
  const nodes = data.nodes;
  const edges = data.edges || [];
  const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(nodes.length))));
  const W = 200;
  const pos = new Map();
  let maxY = 0;
  nodes.forEach((n, i) => {
    const pins = n.pins || [];
    const h = 34 + Math.min(pins.length, 16) * 13;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 20 + col * (W + 90);
    const y = 20 + row * 200;
    pos.set(n.id, { x, y, w: W, h, pins });
    maxY = Math.max(maxY, y + h);
  });
  const width = 20 + cols * (W + 90);
  const root = svg('svg', { class: 'diagram', viewBox: `0 0 ${width} ${maxY + 30}` });
  const anchor = (ref) => {
    const [id, pin] = String(ref).split('.');
    const p = pos.get(id);
    if (!p) return null;
    const idx = pin ? p.pins.indexOf(pin) : -1;
    if (idx >= 0 && idx < 16) return { x: p.x + p.w, y: p.y + 34 + idx * 13 - 4, pin };
    return { x: p.x + p.w / 2, y: p.y + p.h / 2, pin };
  };
  for (const e of edges) {
    const a = anchor(e.from);
    const b = anchor(e.to);
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    const path = svg('path', { class: 'edge', d: `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}` });
    if (e.color && /^[#a-z0-9]{3,20}$/i.test(e.color)) path.setAttribute('style', `stroke:${e.color}`);
    root.append(path);
    if (e.label) root.append(svg('text', { class: 'edge-label', x: mx, y: (a.y + b.y) / 2 - 4, 'text-anchor': 'middle' }, e.label));
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const g = svg('g', { class: 'node' });
    g.append(svg('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 6 }));
    g.append(svg('text', { x: p.x + 8, y: p.y + 18 }, n.label + (n.kind ? `  [${n.kind}]` : '')));
    p.pins.slice(0, 16).forEach((pin, i) => g.append(svg('text', { class: 'pin', x: p.x + p.w - 6, y: p.y + 34 + i * 13, 'text-anchor': 'end' }, pin)));
    root.append(g);
  }
  const wrap = el('div');
  if (data.title) wrap.append(el('div', { class: 'accent', text: data.title }));
  wrap.append(root);
  return wrap;
}

export function renderCode(kind, code) {
  const label = kind === 'arduino' ? 'Arduino (.ino)' : kind === 'scad' ? 'OpenSCAD (.scad)' : kind || 'code';
  const pre = el('pre', { class: 'mono', text: code });
  const copy = el('button', {
    class: 'btn small',
    text: 'คัดลอก',
    onclick: () => navigator.clipboard.writeText(code).catch(() => {}),
  });
  return el('div', { class: 'code-block' }, el('div', { class: 'row' }, el('span', { class: 'accent', text: label }), copy), pre);
}

/** Compact card for the chat stream. */
export function blockCard(item) {
  const card = el('div', { class: 'block-card' });
  card.append(el('div', { class: 'block-kind', text: `▣ jarvis-${item.kind} — แสดงบนจอแล้ว` }));
  if (item.kind === 'steps') card.append(el('div', { class: 'dim', text: `${item.data.steps.length} ขั้นตอน${item.data.title ? ': ' + item.data.title : ''}` }));
  if (item.kind === 'bom') card.append(el('div', { class: 'dim', text: `${item.data.items.length} รายการ` }));
  if (item.kind === 'diagram') card.append(el('div', { class: 'dim', text: `${item.data.nodes.length} ชิ้นส่วน, ${(item.data.edges || []).length} สาย` }));
  if (item.code) card.append(el('div', { class: 'dim', text: `${item.code.split('\n').length} บรรทัด` }));
  return card;
}

export const TAB_FOR_KIND = { steps: 'steps', diagram: 'diagram', bom: 'bom', arduino: 'code', scad: 'code' };

export function renderForTab(item) {
  switch (item.kind) {
    case 'steps': return renderSteps(item.data);
    case 'bom': return renderBom(item.data);
    case 'diagram': return renderDiagram(item.data);
    case 'arduino':
    case 'scad': return renderCode(item.kind, item.code);
    default: return null;
  }
}
