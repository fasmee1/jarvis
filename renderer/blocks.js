// Render jarvis-* blocks with DOM APIs only (textContent — never innerHTML of
// model output), both inline in chat and in the HUD display tabs.

import { layoutGraph, borderPoint, textSize, wrapLabel } from './ui/diagram-layout.js';

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

// ---- software planning diagrams: flowchart / DFD and ER ----

let arrowSeq = 0;

function arrowDefs(root) {
  const id = `dg-arrow-${++arrowSeq}`;
  root.dataset.arrow = id;
  const defs = svg('defs');
  const m = svg('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '8', markerHeight: '8', orient: 'auto-start-reverse' });
  m.append(svg('path', { d: 'M0,0 L10,5 L0,10 z', class: 'dg-arrow' }));
  defs.append(m);
  root.append(defs);
}

function multiline(g, lines, cx, cy, extra = {}) {
  const lh = 16;
  const top = cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((ln, i) => g.append(svg('text', { x: cx, y: top + i * lh + 4, 'text-anchor': 'middle', ...extra }, ln)));
}

function edgeLine(root, a, b, label) {
  root.append(svg('line', { class: 'edge', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'marker-end': `url(#${root.dataset.arrow})` }));
  if (label) root.append(svg('text', { class: 'edge-label', x: (a.x + b.x) / 2 + 4, y: (a.y + b.y) / 2 - 4 }, label));
}

function shell(data, root, width, height) {
  root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.style.maxWidth = `${Math.max(width, 320)}px`;
  const wrap = el('div');
  if (data.title) wrap.append(el('div', { class: 'accent', text: data.title }));
  wrap.append(root);
  return wrap;
}

export function renderFlow(data) {
  const dfd = data.type === 'dfd';
  const shapeOf = (n) => n.shape || (dfd ? 'process' : 'process');
  const sized = data.nodes.map((n) => {
    const shape = shapeOf(n);
    const s = textSize(n.label, shape === 'decision' ? { min: 120, pad: 56, max: 200 } : {});
    return { id: n.id, label: n.label, shape, w: shape === 'decision' ? s.w + 30 : s.w, h: shape === 'decision' ? Math.max(70, s.h + 30) : s.h };
  });
  const byId = new Map(sized.map((n) => [n.id, n]));
  const edges = (data.edges || []).filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  const { pos, width, height } = layoutGraph(sized, edges, data.direction === 'LR' ? 'LR' : 'TB');
  const root = svg('svg', { class: 'diagram flow' });
  arrowDefs(root);
  const center = (n) => ({ x: pos.get(n.id).x + n.w / 2, y: pos.get(n.id).y + n.h / 2 });
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const pa = borderPoint(a, pos.get(a.id), center(b), a.shape === 'decision');
    const pb = borderPoint(b, pos.get(b.id), center(a), b.shape === 'decision');
    edgeLine(root, pa, pb, e.label);
  }
  for (const n of sized) {
    const { x, y } = pos.get(n.id);
    const g = svg('g', { class: `node shape-${n.shape}` });
    const cx = x + n.w / 2;
    const cy = y + n.h / 2;
    if (n.shape === 'decision') {
      g.append(svg('polygon', { points: `${cx},${y} ${x + n.w},${cy} ${cx},${y + n.h} ${x},${cy}` }));
    } else if (n.shape === 'io') {
      const k = 14;
      g.append(svg('polygon', { points: `${x + k},${y} ${x + n.w},${y} ${x + n.w - k},${y + n.h} ${x},${y + n.h}` }));
    } else if (n.shape === 'store') {
      g.append(svg('rect', { x, y, width: n.w, height: n.h, rx: 0, class: 'store-fill' }));
      g.append(svg('line', { x1: x + 10, y1: y, x2: x + 10, y2: y + n.h }));
    } else {
      const rx = n.shape === 'start' || n.shape === 'end' ? n.h / 2 : dfd && n.shape === 'process' ? 18 : 6;
      g.append(svg('rect', { x, y, width: n.w, height: n.h, rx, class: n.shape === 'external' ? 'external' : '' }));
    }
    multiline(g, wrapLabel(n.label, n.w - 28), cx + (n.shape === 'store' ? 6 : 0), cy);
    root.append(g);
  }
  return shell(data, root, width, height);
}

const CARD_TEXT = { '1': '1', '0..1': '0..1', N: 'N', '0..N': '0..N' };

export function renderEr(data) {
  const ROW = 18;
  const sized = data.entities.map((en) => {
    const fields = (en.fields || []).slice(0, 30);
    const longest = Math.max([...en.name].length, ...fields.map((f) => [...`${f.key ? f.key.toUpperCase() + ' ' : ''}${f.name}  ${f.type || ''}`].length));
    return { id: en.id, name: en.name, fields, w: Math.min(280, Math.max(140, longest * 8 + 32)), h: 34 + Math.max(1, fields.length) * ROW + 8 };
  });
  const byId = new Map(sized.map((n) => [n.id, n]));
  const rels = (data.relations || []).filter((r) => byId.has(r.from) && byId.has(r.to) && r.from !== r.to);
  const { pos, width, height } = layoutGraph(sized, rels, 'LR');
  const root = svg('svg', { class: 'diagram er' });
  const center = (n) => ({ x: pos.get(n.id).x + n.w / 2, y: pos.get(n.id).y + n.h / 2 });
  for (const r of rels) {
    const a = byId.get(r.from);
    const b = byId.get(r.to);
    const pa = borderPoint(a, pos.get(a.id), center(b));
    const pb = borderPoint(b, pos.get(b.id), center(a));
    root.append(svg('line', { class: 'edge', x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y }));
    const near = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    if (r.fromCard) { const c = near(pa, pb, 0.12); root.append(svg('text', { class: 'card', x: c.x, y: c.y - 5, 'text-anchor': 'middle' }, CARD_TEXT[r.fromCard])); }
    if (r.toCard) { const c = near(pa, pb, 0.88); root.append(svg('text', { class: 'card', x: c.x, y: c.y - 5, 'text-anchor': 'middle' }, CARD_TEXT[r.toCard])); }
    if (r.label) { const c = near(pa, pb, 0.5); root.append(svg('text', { class: 'edge-label', x: c.x, y: c.y - 5, 'text-anchor': 'middle' }, r.label)); }
  }
  for (const n of sized) {
    const { x, y } = pos.get(n.id);
    const g = svg('g', { class: 'node entity' });
    g.append(svg('rect', { x, y, width: n.w, height: n.h, rx: 6 }));
    g.append(svg('line', { x1: x, y1: y + 28, x2: x + n.w, y2: y + 28 }));
    g.append(svg('text', { class: 'entity-name', x: x + n.w / 2, y: y + 19, 'text-anchor': 'middle' }, n.name));
    n.fields.forEach((f, i) => {
      const ty = y + 28 + 8 + (i + 1) * ROW - 5;
      if (f.key) g.append(svg('text', { class: `pin key-${f.key}`, x: x + 8, y: ty }, f.key.toUpperCase()));
      g.append(svg('text', { class: 'field', x: x + (f.key ? 30 : 8), y: ty }, f.name));
      if (f.type) g.append(svg('text', { class: 'pin', x: x + n.w - 8, y: ty, 'text-anchor': 'end' }, f.type));
    });
    root.append(g);
  }
  return shell(data, root, width, height);
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
export function blockCard(item, onOpen) {
  const card = el('div', { class: 'block-card' });
  card.append(el('div', { class: 'block-kind', text: `▣ jarvis-${item.kind} — แสดงบนจอแล้ว${onOpen ? ' · กดเพื่อดูอีกครั้ง' : ''}` }));
  if (onOpen) {
    card.classList.add('clickable');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.onclick = onOpen;
    card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } };
  }
  if (item.kind === 'steps') card.append(el('div', { class: 'dim', text: `${item.data.steps.length} ขั้นตอน${item.data.title ? ': ' + item.data.title : ''}` }));
  if (item.kind === 'bom') card.append(el('div', { class: 'dim', text: `${item.data.items.length} รายการ` }));
  if (item.kind === 'diagram') card.append(el('div', { class: 'dim', text: `${item.data.nodes.length} ชิ้นส่วน, ${(item.data.edges || []).length} สาย` }));
  if (item.kind === 'flow') card.append(el('div', { class: 'dim', text: `${item.data.type === 'dfd' ? 'Data Flow Diagram' : 'Flowchart'} · ${item.data.nodes.length} กล่อง` }));
  if (item.kind === 'er') card.append(el('div', { class: 'dim', text: `ER Diagram · ${item.data.entities.length} ตาราง` }));
  if (item.code) card.append(el('div', { class: 'dim', text: `${item.code.split('\n').length} บรรทัด` }));
  return card;
}

export const TAB_FOR_KIND = { steps: 'steps', diagram: 'diagram', flow: 'diagram', er: 'diagram', bom: 'bom', arduino: 'code', scad: 'code' };

export function renderForTab(item) {
  switch (item.kind) {
    case 'steps': return renderSteps(item.data);
    case 'bom': return renderBom(item.data);
    case 'diagram': return renderDiagram(item.data);
    case 'flow': return renderFlow(item.data);
    case 'er': return renderEr(item.data);
    case 'arduino':
    case 'scad': return renderCode(item.kind, item.code);
    default: return null;
  }
}
