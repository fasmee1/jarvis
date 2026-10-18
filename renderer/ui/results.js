// Result Viewer renderers, one per payload type (search · news · youtube · images ·
// web · weather · table · chart · text · map) plus skeleton / empty states.
// Add a type: write render<Type>(root, data, ctx) and register it in RENDERERS.
//
// Safety: everything from the model or the web is written with textContent;
// links and images must be http(s); YouTube ids must look like ids. Raw HTML is
// never injected. Live web pages are the Web Viewer's job (ui/web-viewer.js).
//
// Each renderer returns a controller:
//   { items: [{ el, open(), read: string }], external?(): url, video?, dispose?(), onShow?(), onHide?() }

import { vicon } from './stage-viewer.js';
import { safeUrl, domainOf, youtubeId, relTime } from './result-utils.js';

export { safeUrl, domainOf, youtubeId, relTime };

const NS = 'http://www.w3.org/2000/svg';

// ---------- small helpers ----------
export function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null && text !== '') e.textContent = String(text);
  return e;
}

function img(url, cls, alt = '') {
  const u = safeUrl(url);
  if (!u) return null;
  const i = document.createElement('img');
  i.className = cls;
  i.alt = alt;
  i.loading = 'lazy';
  i.decoding = 'async';
  i.referrerPolicy = 'no-referrer';
  i.src = u;
  i.addEventListener('error', () => i.classList.add('broken'));
  return i;
}

/** Site icon (falls back to the first letter). */
function favicon(url, name) {
  const wrap = h('span', 'rv-fav');
  const d = domainOf(url);
  wrap.textContent = (name || d || '?').trim().charAt(0).toUpperCase();
  if (d) {
    // loads detached (not lazy: detached lazy images never load); swapped in on success
    const i = new Image();
    i.className = 'rv-fav-img';
    i.alt = '';
    i.referrerPolicy = 'no-referrer';
    i.addEventListener('load', () => { if (i.naturalWidth > 1) wrap.replaceChildren(i); }, { once: true });
    i.src = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(d)}.ico`;
  }
  return wrap;
}

const badge = (n) => h('span', 'rv-num', String(n));

function clickable(el, fn) {
  el.tabIndex = 0;
  el.setAttribute('role', 'link');
  el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } });
}

// ---------- search ----------
function renderSearch(root, data, ctx) {
  const items = [];
  const list = (data.items || []).map((it, i) => ({ ...it, url: safeUrl(it.url), n: i + 1 })).filter((it) => it.title || it.url);
  if (data.summary && data.summary.text) {
    const box = h('div', 'rv-summary sv-item');
    box.append(h('div', 'rv-label', 'สรุปโดย AI'));
    const p = h('p', 'rv-summary-text');
    // "[1]" "[2]" become chips that open that result
    for (const part of String(data.summary.text).split(/(\[\d{1,2}\])/)) {
      const m = /^\[(\d{1,2})\]$/.exec(part);
      if (m && list[Number(m[1]) - 1]) {
        const it = list[Number(m[1]) - 1];
        const chip = h('button', 'rv-ref', m[1]);
        chip.type = 'button';
        chip.title = it.title || it.url || '';
        chip.addEventListener('click', (e) => { e.stopPropagation(); if (it.url) ctx.openWeb(it.url, it.title); });
        p.append(chip);
      } else if (part) p.append(document.createTextNode(part));
    }
    box.append(p);
    root.append(box);
  }
  const ol = h('div', 'rv-list');
  for (const it of list) {
    const card = h('div', 'rv-card sr sv-item');
    const top = h('div', 'sr-top');
    const site = it.site || domainOf(it.url);
    top.append(badge(it.n), favicon(it.url, site), h('span', 'sr-site', site));
    card.append(top, h('div', 'sr-title', it.title || it.url), h('div', 'sr-snip', it.snippet || it.summary || ''), h('div', 'sr-url', it.url || ''));
    const open = () => (it.url ? ctx.openWeb(it.url, it.title) : null);
    clickable(card, open);
    ol.append(card);
    items.push({ el: card, open, url: it.url, read: [it.title, it.snippet].filter(Boolean).join(' · ') });
  }
  root.append(ol);
  return { items };
}

// ---------- news ----------
function renderNews(root, data, ctx) {
  const items = [];
  const grid = h('div', 'nw-grid');
  (data.items || []).forEach((it, i) => {
    const url = safeUrl(it.url);
    const source = it.source || it.site || domainOf(url) || 'ไม่ทราบแหล่งที่มา';
    const card = h('div', `rv-card nw sv-item${i === 0 ? ' featured' : ''}`);
    const thumb = h('div', 'nw-thumb');
    const pic = img(it.image, 'nw-img', '');
    const ph = () => h('span', 'nw-ph', source.charAt(0).toUpperCase());
    if (pic) {
      pic.addEventListener('error', () => pic.replaceWith(ph())); // broken image → the source's initial
      thumb.append(pic);
    } else thumb.append(ph());
    thumb.append(badge(i + 1));
    const meta = h('div', 'nw-meta');
    meta.append(favicon(url, source), h('span', 'nw-src', source), h('span', 'nw-dot', '·'), h('span', 'nw-time', relTime(it.publishedAt) || 'ไม่ระบุเวลา'));
    card.append(thumb, meta, h('div', 'nw-title', it.title || ''), h('div', 'nw-sum', it.summary || it.snippet || ''));
    const open = () => (url ? ctx.openWeb(url, it.title) : null);
    clickable(card, open);
    grid.append(card);
    items.push({ el: card, open, url, read: `${it.title || ''} จาก ${source}${it.summary ? ' · ' + it.summary : ''}` });
  });
  root.append(grid);
  return { items };
}

// ---------- youtube ----------
const YT_ORIGIN = 'https://www.youtube-nocookie.com';

/** Minimal IFrame Player API over postMessage (the CSP doesn't allow YouTube's script). */
export class YtPlayer {
  constructor(host, id, { onState, onError } = {}) {
    this.host = host;
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.state = -1;
    this.time = 0;
    this.vol = 100;
    this.duckedFrom = null;
    this._msg = (e) => this._onMessage(e);
    addEventListener('message', this._msg);
    this.load(id);
  }

  load(id) {
    this.id = id;
    clearInterval(this._listen);
    if (this.frame) this.frame.remove();
    const f = document.createElement('iframe');
    f.className = 'yt-frame';
    f.src = `${YT_ORIGIN}/embed/${id}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1`;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.title = 'YouTube';
    this.frame = f;
    this.ready = false;
    // the player only talks back after it hears "listening"
    f.addEventListener('load', () => {
      let n = 0;
      clearInterval(this._listen);
      this._listen = setInterval(() => {
        if (this.ready || ++n > 40) return clearInterval(this._listen);
        this._post({ event: 'listening', id: 1, channel: 'widget' });
      }, 250);
    });
    this.host.append(f);
  }

  _post(o) {
    try { this.frame.contentWindow.postMessage(JSON.stringify(o), YT_ORIGIN); } catch { /* frame gone */ }
  }

  cmd(func, args = []) {
    this._post({ event: 'command', func, args, id: 1, channel: 'widget' });
  }

  _onMessage(e) {
    if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== YT_ORIGIN) return;
    let d;
    try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (d.event === 'onReady' || d.event === 'initialDelivery') this.ready = true;
    const info = d.info && typeof d.info === 'object' ? d.info : null;
    if (d.event === 'onError') return this.onError(Number(d.info));
    if (d.event === 'onStateChange' && typeof d.info === 'number') this._setState(d.info);
    if (info) {
      if (typeof info.playerState === 'number') this._setState(info.playerState);
      if (typeof info.currentTime === 'number') this.time = info.currentTime;
      if (typeof info.volume === 'number' && this.duckedFrom == null) this.vol = info.volume;
    }
  }

  _setState(s) {
    if (s === this.state) return;
    this.state = s;
    this.onState(s === 1 ? 'playing' : s === 0 ? 'ended' : s === 2 ? 'paused' : 'other');
  }

  play() { this.cmd('playVideo'); }
  pause() { this.cmd('pauseVideo'); }
  seek(delta) { this.cmd('seekTo', [Math.max(0, this.time + delta), true]); this.time = Math.max(0, this.time + delta); }
  volume(delta) {
    this.vol = Math.max(0, Math.min(100, this.vol + delta));
    if (this.duckedFrom != null) this.duckedFrom = this.vol;
    else this.cmd('setVolume', [this.vol]);
    this.cmd('unMute');
  }

  /** Lower the video while JARVIS listens or talks (restores the user's volume after). */
  duck(on) {
    if (on && this.duckedFrom == null) {
      this.duckedFrom = this.vol;
      this.cmd('setVolume', [Math.round(this.vol * 0.2)]);
    } else if (!on && this.duckedFrom != null) {
      this.cmd('setVolume', [this.duckedFrom]);
      this.vol = this.duckedFrom;
      this.duckedFrom = null;
    }
  }

  get playing() {
    return this.state === 1;
  }

  dispose() {
    clearInterval(this._listen);
    removeEventListener('message', this._msg);
    if (this.frame) { this.cmd('stopVideo'); this.frame.src = 'about:blank'; this.frame.remove(); }
    this.frame = null;
  }
}

function renderYoutube(root, data, ctx) {
  const vids = (data.items || []).map((it) => ({ ...it, id: youtubeId(it) })).filter((it) => it.id);
  if (!vids.length) return renderEmpty(root, 'ไม่พบวิดีโอที่เล่นได้', ctx.retry);
  const wrap = h('div', 'yt');
  const main = h('div', 'yt-main');
  const stage = h('div', 'yt-stage');
  const info = h('div', 'yt-info');
  const side = h('div', 'yt-side');
  main.append(stage, info);
  wrap.append(main, side);
  root.append(wrap);
  let current = vids[0];
  let player = null;
  const items = [];

  const fallback = (v) => {
    // embedding disabled by the owner (or blocked): thumbnail + open in YouTube
    if (player) { player.dispose(); player = null; }
    ctx.onVideo('none');
    stage.replaceChildren();
    const fb = h('div', 'yt-fallback');
    const t = img(`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, 'yt-thumb', v.title || '');
    if (t) fb.append(t);
    const btn = h('button', 'rv-btn primary', 'เปิดใน YouTube');
    btn.type = 'button';
    btn.addEventListener('click', (e) => { e.stopPropagation(); ctx.openExternal(`https://www.youtube.com/watch?v=${v.id}`); });
    fb.append(h('div', 'yt-fb-msg', 'เจ้าของคลิปไม่อนุญาตให้เล่นนอก YouTube'), btn);
    stage.append(fb);
  };

  const show = (v) => {
    current = v;
    info.replaceChildren(h('div', 'yt-title', v.title || ''), h('div', 'yt-sub', [v.channel, v.views, relTime(v.publishedAt)].filter(Boolean).join(' · ')));
    if (!player) {
      stage.replaceChildren();
      player = new YtPlayer(stage, v.id, {
        onState: (s) => ctx.onVideo(s),
        onError: (code) => { if ([2, 5, 100, 101, 150, 153].includes(code)) fallback(v); },
      });
      ctl.video = player;
    } else player.load(v.id);
    for (const it of items) it.el.classList.toggle('on', it.v === v);
  };

  side.append(h('div', 'rv-label', 'Up next'));
  vids.forEach((v, i) => {
    const row = h('div', 'yt-next sv-item');
    const th = h('div', 'yt-next-th');
    const t = img(`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, 'yt-next-img', '');
    if (t) th.append(t);
    th.append(badge(i + 1));
    if (v.duration) th.append(h('span', 'yt-dur', v.duration));
    const txt = h('div', 'yt-next-txt');
    txt.append(h('div', 'yt-next-title', v.title || ''), h('div', 'yt-next-sub', [v.channel, v.views].filter(Boolean).join(' · ')));
    row.append(th, txt);
    const open = () => show(v);
    clickable(row, open);
    side.append(row);
    items.push({ el: row, v, open, url: `https://www.youtube.com/watch?v=${v.id}`, read: `${v.title || ''}${v.channel ? ' ช่อง ' + v.channel : ''}` });
  });
  const ctl = {
    items,
    video: null,
    external: () => `https://www.youtube.com/watch?v=${current.id}`,
    onHide: () => { if (player) player.pause(); },
    dispose: () => { if (player) player.dispose(); player = null; ctx.onVideo('none'); },
  };
  show(current);
  return ctl;
}

// ---------- images ----------
function renderImages(root, data, ctx) {
  const items = [];
  const grid = h('div', 'im-grid');
  const list = (data.items || []).map((it) => ({ ...it, src: safeUrl(it.image || it.url) })).filter((it) => it.src);
  list.forEach((it, i) => {
    const cell = h('figure', 'im-cell sv-item');
    const pic = img(it.src, 'im-img', it.title || '');
    pic.addEventListener('error', () => cell.remove());
    cell.append(pic, badge(i + 1));
    const open = () => lightbox(root, it, ctx);
    clickable(cell, open);
    grid.append(cell);
    items.push({ el: cell, open, url: safeUrl(it.url) || it.src, read: it.title || `รูปที่ ${i + 1}` });
  });
  root.append(grid);
  return { items, escape: () => { const lb = root.querySelector('.lb'); if (lb) { lb.remove(); return true; } return false; } };
}

function lightbox(root, it, ctx) {
  root.querySelector('.lb')?.remove();
  const lb = h('div', 'lb');
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-label', it.title || 'รูปภาพ');
  const pic = img(it.src, 'lb-img', it.title || '');
  const cap = h('div', 'lb-cap');
  cap.append(h('span', 'lb-title', it.title || ''));
  const src = safeUrl(it.url);
  if (src) {
    const b = h('button', 'rv-btn', `ที่มา: ${domainOf(src)}`);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); ctx.openExternal(src); });
    cap.append(b);
  }
  lb.append(pic, cap);
  lb.addEventListener('click', (e) => { if (e.target === lb || e.target === pic) lb.remove(); });
  root.append(lb);
}

// ---------- weather ----------
function renderWeather(root, data) {
  const c = data.current || {};
  const wrap = h('div', 'wx');
  const now = h('div', 'wx-now sv-item');
  const t = h('div', 'wx-temp');
  t.append(h('span', '', c.temp != null ? Math.round(c.temp) : '—'), h('span', 'wx-u', '°C'));
  const side = h('div', 'wx-side');
  side.append(h('div', 'wx-loc', data.location || ''), h('div', 'wx-cond', c.condition || ''));
  const facts = h('div', 'wx-facts');
  const fact = (k, v) => { if (v == null || v === '') return; const f = h('span', 'wx-fact'); f.append(h('span', 'wx-k', k), h('span', 'wx-v', v)); facts.append(f); };
  fact('รู้สึกเหมือน', c.feelsLike != null ? `${Math.round(c.feelsLike)}°` : null);
  fact('ความชื้น', c.humidity != null ? `${Math.round(c.humidity)}%` : null);
  fact('ลม', c.wind);
  fact('สูง/ต่ำ', c.high != null && c.low != null ? `${Math.round(c.high)}° / ${Math.round(c.low)}°` : null);
  side.append(facts);
  now.append(t, side);
  wrap.append(now);
  if (data.hourly && data.hourly.length) {
    const strip = h('div', 'wx-hours sv-item');
    for (const hr of data.hourly) {
      const col = h('div', 'wx-hour');
      col.append(h('span', 'wx-h-t', hr.time || ''), h('span', 'wx-h-temp', hr.temp != null ? `${Math.round(hr.temp)}°` : '—'), h('span', 'wx-h-c', hr.condition || ''), h('span', 'wx-h-r', hr.rain != null ? `☂ ${Math.round(hr.rain)}%` : ''));
      strip.append(col);
    }
    wrap.append(strip);
  }
  root.append(wrap);
  return { items: [], read: `${data.location || ''} ${c.temp != null ? Math.round(c.temp) + ' องศา' : ''} ${c.condition || ''}` };
}

// ---------- table ----------
function renderTable(root, data) {
  const wrap = h('div', 'tb-wrap sv-item');
  const t = h('table', 'tb');
  if (data.columns && data.columns.length) {
    const tr = h('tr');
    for (const c of data.columns) tr.append(h('th', '', c));
    const thead = h('thead');
    thead.append(tr);
    t.append(thead);
  }
  const tbody = h('tbody');
  for (const row of data.rows || []) {
    const tr = h('tr');
    for (const v of row) {
      const td = h('td', typeof v === 'number' ? 'num' : '', v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
      tr.append(td);
    }
    tbody.append(tr);
  }
  t.append(tbody);
  wrap.append(t);
  root.append(wrap);
  return { items: [] };
}

// ---------- chart (thin lines: cyan for the main series, grey for others) ----------
function renderChart(root, data) {
  const series = (data.series || []).filter((s) => s.values && s.values.length);
  if (!series.length) return renderEmpty(root, 'ไม่มีข้อมูลสำหรับกราฟ');
  const W = 960;
  const H = 360;
  const P = { l: 56, r: 16, t: 16, b: 36 };
  const all = series.flatMap((s) => s.values);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) { lo -= 1; hi += 1; }
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i) => P.l + (n === 1 ? 0 : (i / (n - 1)) * (W - P.l - P.r));
  const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', `0 0 ${W} ${H}`);
  s.setAttribute('class', 'ch');
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', data.title || 'กราฟ');
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    s.append(e);
    return e;
  };
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    add('line', { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), class: 'ch-grid' });
    add('text', { x: P.l - 8, y: y(v) + 4, class: 'ch-y' }, `${+v.toPrecision(4)}${data.unit ? '' : ''}`);
  }
  const labels = data.labels || [];
  const every = Math.max(1, Math.ceil(labels.length / 8));
  labels.forEach((l, i) => { if (i % every === 0 && i < n) add('text', { x: x(i), y: H - 12, class: 'ch-x' }, l); });
  series.slice().reverse().forEach((sr, ri) => {
    const main = ri === series.length - 1;
    add('polyline', { points: sr.values.map((v, i) => `${x(i)},${y(v)}`).join(' '), class: main ? 'ch-line main' : 'ch-line' });
  });
  const wrap = h('div', 'ch-wrap sv-item');
  if (data.unit) wrap.append(h('div', 'ch-unit', data.unit));
  wrap.append(s);
  if (series.length > 1 || series[0].name) {
    const lg = h('div', 'ch-legend');
    series.forEach((sr, i) => { const it = h('span', `ch-lg${i === 0 ? ' main' : ''}`); it.append(h('i'), h('span', '', sr.name || `ชุดที่ ${i + 1}`)); lg.append(it); });
    wrap.append(lg);
  }
  root.append(wrap);
  return { items: [] };
}

// ---------- text (small, safe markdown → DOM) ----------
function inline(parent, text, ctx) {
  // **bold**, *italic*, `code`, [label](http…)
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    if (t.startsWith('**')) parent.append(h('strong', '', t.slice(2, -2)));
    else if (t.startsWith('`')) parent.append(h('code', '', t.slice(1, -1)));
    else if (t.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
      const u = safeUrl(mm[2]);
      if (u) {
        const a = h('a', 'md-a', mm[1]);
        a.href = '#';
        a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); ctx.openWeb(u, mm[1]); });
        parent.append(a);
      } else parent.append(document.createTextNode(mm[1]));
    } else parent.append(h('em', '', t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

export function renderMarkdown(root, md, ctx) {
  const art = h('article', 'md sv-item');
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) { const p = h('p'); inline(p, para.join(' '), ctx); art.append(p); para = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush(); list = null;
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      art.append(h('pre', 'md-pre', code.join('\n')));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flush(); list = null;
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const t = h('table', 'tb');
      const tr = h('tr');
      for (const c of cells(line)) tr.append(h('th', '', c));
      const thead = h('thead');
      thead.append(tr);
      t.append(thead);
      const tb = h('tbody');
      i += 1;
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) {
        const r = h('tr');
        for (const c of cells(lines[++i])) { const td = h('td'); inline(td, c, ctx); r.append(td); }
        tb.append(r);
      }
      t.append(tb);
      const w = h('div', 'tb-wrap');
      w.append(t);
      art.append(w);
      continue;
    }
    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    const q = /^>\s?(.*)$/.exec(line);
    if (hd) { flush(); list = null; const e = h(`h${Math.min(4, hd[1].length + 1)}`); inline(e, hd[2], ctx); art.append(e); } else if (li) {
      flush();
      const ordered = /^\s*\d/.test(line);
      if (!list || list.ordered !== ordered) { list = h(ordered ? 'ol' : 'ul'); list.ordered = ordered; art.append(list); }
      const e = h('li');
      inline(e, li[1], ctx);
      list.append(e);
    } else if (q) { flush(); list = null; const e = h('blockquote'); inline(e, q[1], ctx); art.append(e); } else if (!line.trim()) { flush(); list = null; } else para.push(line.trim());
  }
  flush();
  root.append(art);
}

function renderText(root, data, ctx) {
  renderMarkdown(root, data.markdown || (data.items || []).map((i) => i.summary || i.snippet || '').join('\n\n'), ctx);
  return { items: [] };
}

// ---------- map ----------
function renderMap(root, data, ctx) {
  const { lat, lon } = data;
  if (typeof lat !== 'number' || typeof lon !== 'number') return renderEmpty(root, 'ไม่มีพิกัดสำหรับแผนที่');
  const z = data.zoom || 14;
  const d = 0.02 * Math.pow(2, 14 - z);
  const bbox = [lon - d, lat - d / 2, lon + d, lat + d / 2].map((v) => v.toFixed(5)).join(',');
  const f = document.createElement('iframe');
  f.className = 'mp-frame sv-item';
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  f.referrerPolicy = 'no-referrer';
  f.title = data.location || 'แผนที่';
  f.src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(5)},${lon.toFixed(5)}`;
  root.append(f);
  if (data.location) root.append(h('div', 'mp-cap', data.location));
  const ext = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=${z}/${lat.toFixed(5)}/${lon.toFixed(5)}`;
  return { items: [], external: () => ext, dispose: () => { f.src = 'about:blank'; } };
}

// ---------- states ----------
export function renderSkeleton(root, kind = 'search') {
  const sk = h('div', `sk sk-${kind}`);
  sk.setAttribute('aria-busy', 'true');
  sk.append(h('div', 'sk-status', 'กำลังค้นหา…'));
  const n = kind === 'news' ? 6 : 5;
  for (let i = 0; i < n; i++) {
    const row = h('div', 'sk-row');
    row.append(h('i', 'sk-bar w30'), h('i', 'sk-bar w80'), h('i', 'sk-bar w60'));
    sk.append(row);
  }
  root.append(sk);
  return { items: [] };
}

export function renderEmpty(root, msg = 'ไม่พบผลลัพธ์', retry, openExternal) {
  const box = h('div', 'rv-empty');
  box.append(h('div', 'rv-empty-msg', msg));
  const row = h('div', 'rv-empty-row');
  if (retry) {
    const b = h('button', 'rv-btn', 'ลองอีกครั้ง');
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); retry(); });
    row.append(b);
  }
  if (openExternal) {
    const b = h('button', 'rv-btn', 'เปิดในเบราว์เซอร์');
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); openExternal(); });
    row.append(b);
  }
  box.append(row);
  root.append(box);
  return { items: [] };
}

// ---------- registry ----------
const RENDERERS = {
  search: renderSearch,
  news: renderNews,
  youtube: renderYoutube,
  images: renderImages,
  weather: renderWeather,
  table: renderTable,
  chart: renderChart,
  text: renderText,
  map: renderMap,
};

export const TYPE_META = {
  search: { icon: 'search', label: 'ผลการค้นหา' },
  news: { icon: 'news', label: 'ข่าว' },
  youtube: { icon: 'youtube', label: 'YouTube' },
  web: { icon: 'web', label: 'เว็บ' },
  images: { icon: 'images', label: 'รูปภาพ' },
  weather: { icon: 'weather', label: 'สภาพอากาศ' },
  table: { icon: 'table', label: 'ตาราง' },
  chart: { icon: 'chart', label: 'กราฟ' },
  text: { icon: 'text', label: 'คำตอบ' },
  map: { icon: 'map', label: 'แผนที่' },
};

/** Has this payload anything to show? */
export function isEmptyResult(data) {
  switch (data.type) {
    case 'web': return !safeUrl(data.url || (data.items && data.items[0] && data.items[0].url));
    case 'weather': return !data.current;
    case 'table': return !(data.rows && data.rows.length);
    case 'chart': return !(data.series && data.series.length);
    case 'text': return !(data.markdown || (data.items && data.items.length));
    case 'map': return typeof data.lat !== 'number';
    default: return !(data.items && data.items.length);
  }
}

/**
 * Render a payload into `root` (a viewer tab body).
 * ctx: { openWeb(url, title), openExternal(url), speak(text), retry(), onVideo(state), reveal(el) }
 */
export function renderResult(root, data, ctx) {
  if (isEmptyResult(data)) return renderEmpty(root, 'ไม่พบผลลัพธ์', ctx.retry);
  const fn = RENDERERS[data.type] || renderText;
  try {
    return fn(root, data, ctx) || { items: [] };
  } catch (err) {
    root.replaceChildren();
    return renderEmpty(root, `แสดงผลไม่สำเร็จ (${err.message})`, ctx.retry);
  }
}
