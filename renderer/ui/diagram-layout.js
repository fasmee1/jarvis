// Layered layout for flowcharts, DFDs and ER diagrams. Pure (no DOM) so node --test can cover it.
// layoutGraph() puts nodes in layers (longest path), orders each layer to cut crossings, then
// assigns coordinates. borderPoint() finds where a line toward another node leaves a box or diamond.

const GAP_LAYER = 70;
const GAP_NODE = 40;
const PAD = 24;

/**
 * @param {{id:string,w:number,h:number}[]} nodes
 * @param {{from:string,to:string}[]} edges
 * @param {'TB'|'LR'} direction
 * @returns {{pos:Map<string,{x:number,y:number}>, width:number, height:number, layers:string[][]}}
 */
export function layoutGraph(nodes, edges, direction = 'TB') {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const links = [];
  for (const e of edges) {
    const key = `${e.from}\u0000${e.to}`;
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to) || seen.has(key)) continue;
    seen.add(key);
    links.push([e.from, e.to]);
  }

  // Cycles: ignore back edges (found by DFS) for layering only; they are still drawn later.
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, b] of links) out.get(a).push(b);
  const state = new Map();
  const dag = [];
  const dfs = (id) => {
    state.set(id, 1);
    for (const to of out.get(id)) {
      if (state.get(to) === 1) continue; // back edge
      dag.push([id, to]);
      if (!state.has(to)) dfs(to);
    }
    state.set(id, 2);
  };
  for (const n of nodes) if (!state.has(n.id)) dfs(n.id);

  // Longest-path layering.
  const preds = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, b] of dag) preds.get(b).push(a);
  const layerOf = new Map();
  const depth = (id) => {
    if (layerOf.has(id)) return layerOf.get(id);
    layerOf.set(id, 0);
    const d = preds.get(id).reduce((m, p) => Math.max(m, depth(p) + 1), 0);
    layerOf.set(id, d);
    return d;
  };
  for (const n of nodes) depth(n.id);

  const count = nodes.length ? Math.max(...layerOf.values()) + 1 : 0;
  const layers = Array.from({ length: count }, () => []);
  for (const n of nodes) layers[layerOf.get(n.id)].push(n.id);

  // Barycenter ordering: a few down/up sweeps.
  const nbrs = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, b] of dag) { nbrs.get(a).push(b); nbrs.get(b).push(a); }
  const index = new Map();
  const reindex = () => layers.forEach((l) => l.forEach((id, i) => index.set(id, i)));
  reindex();
  const sweep = (order) => {
    for (const li of order) {
      const l = layers[li];
      const score = new Map(l.map((id) => {
        const ns = nbrs.get(id).filter((x) => layerOf.get(x) !== li);
        const adj = ns.filter((x) => Math.abs(layerOf.get(x) - li) === 1);
        const use = adj.length ? adj : ns;
        return [id, use.length ? use.reduce((s, x) => s + index.get(x), 0) / use.length : index.get(id)];
      }));
      l.sort((a, b) => score.get(a) - score.get(b) || index.get(a) - index.get(b));
      l.forEach((id, i) => index.set(id, i));
    }
  };
  const down = layers.map((_, i) => i);
  for (let r = 0; r < 3; r++) { sweep(down); sweep([...down].reverse()); }

  // Coordinates. Along the layer axis: layers one after another. Across: centred per layer.
  const tb = direction !== 'LR';
  const across = (n) => (tb ? n.w : n.h);
  const along = (n) => (tb ? n.h : n.w);
  const spans = layers.map((l) => l.reduce((s, id) => s + across(byId.get(id)), 0) + Math.max(0, l.length - 1) * GAP_NODE);
  const widest = Math.max(0, ...spans);
  const pos = new Map();
  let cursor = PAD;
  layers.forEach((l, li) => {
    const thick = Math.max(0, ...l.map((id) => along(byId.get(id))));
    let c = PAD + (widest - spans[li]) / 2;
    for (const id of l) {
      const n = byId.get(id);
      const a = cursor + (thick - along(n)) / 2;
      pos.set(id, tb ? { x: c, y: a } : { x: a, y: c });
      c += across(n) + GAP_NODE;
    }
    cursor += thick + GAP_LAYER;
  });
  const total = count ? cursor - GAP_LAYER + PAD : 2 * PAD;
  const side = widest + 2 * PAD;
  return { pos, width: tb ? side : total, height: tb ? total : side, layers };
}

/** Point where the line from the centre of `node` toward `target` (a point) leaves the node's outline. */
export function borderPoint(node, p, target, diamond = false) {
  const cx = p.x + node.w / 2;
  const cy = p.y + node.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const hw = node.w / 2;
  const hh = node.h / 2;
  const t = diamond
    ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
    : Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Rough box size for a label (Thai glyphs are narrow but tall; 8px per char is close enough). */
export function textSize(label, { min = 90, max = 220, pad = 28, line = 18 } = {}) {
  const words = String(label || '').split('\n');
  const longest = Math.max(1, ...words.map((w) => [...w].length));
  const w = Math.min(max, Math.max(min, longest * 8 + pad));
  const lines = words.reduce((s, w2) => s + Math.max(1, Math.ceil(([...w2].length * 8) / (w - pad))), 0);
  return { w, h: Math.max(40, lines * line + 20), lines };
}

/** Split a label into lines that fit `width` px (same 8px-per-char estimate as textSize). */
export function wrapLabel(label, width) {
  const per = Math.max(4, Math.floor(width / 8));
  const out = [];
  for (const raw of String(label || '').split('\n')) {
    const chars = [...raw];
    if (!chars.length) { out.push(''); continue; }
    for (let i = 0; i < chars.length; i += per) out.push(chars.slice(i, i + per).join(''));
  }
  return out;
}
