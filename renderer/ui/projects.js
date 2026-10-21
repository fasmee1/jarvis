// PROJECTS section: background tasks, one per folder (lib/projects.js in main).
// The top half is pure (model + text) so node --test can cover it; ProjectsPanel
// draws it into the #pj popup (project list on the left, the selected project's
// conversation on the right, like the main chat) and the HUD chip.

export const STATUS_LABEL = {
  idle: 'ว่าง',
  running: 'กำลังทำ',
  'awaiting-approval': 'รออนุมัติ',
  done: 'เสร็จ',
  error: 'ผิดพลาด',
  stopped: 'หยุดแล้ว',
};
export const BUSY = new Set(['running', 'awaiting-approval']);
const MAX_LOG = 300;
const MAX_DIFF_LINES = 40;
const MAX_TOOL_TEXT = 3000;

/** Card progress line from a project's `progress` / `filesChanged`; '' when there is nothing to say. */
export function progressText(p) {
  const parts = [];
  const g = p.progress;
  if (g && g.total) parts.push(`${g.done}/${g.total} ขั้นตอน`);
  if (p.filesChanged) parts.push(`แก้ ${p.filesChanged} ไฟล์`);
  return parts.join(' · ');
}

/** 0–100 for the progress bar. */
export function progressPercent(p) {
  const g = p.progress;
  return g && g.total ? Math.round((g.done / g.total) * 100) : 0;
}

export function createModel() {
  return { projects: new Map() }; // projectId -> {info, log: [entry]}
}

/** A 'project:status' payload. Returns the project, or null when it was removed. */
export function applyStatus(model, p) {
  if (p.status === 'removed') {
    model.projects.delete(p.projectId);
    return null;
  }
  const cur = model.projects.get(p.projectId) || { info: null, log: [] };
  const { announce, ...info } = p;
  // a stopped task gets no result event: close its log here
  if (p.status === 'stopped' && cur.info && BUSY.has(cur.info.status)) cur.log.push({ kind: 'err', text: 'หยุดงานแล้ว' });
  cur.info = info;
  model.projects.set(p.projectId, cur);
  return cur;
}

/**
 * One log entry for a background event ({projectId, channel, payload}); null = not shown.
 * kinds: sep · user · text · tool ({id, name, text, diff?, input?, status, result?}) · info · ok · err
 */
export function eventLine(channel, p) {
  switch (channel) {
    case 'turn:start': return { kind: 'sep', text: 'งานใหม่' };
    case 'user:message': return { kind: 'user', text: p.text }; // sent by the project manager when the task starts (the CLI doesn't echo it)
    case 'chat:item':
      if (p.type === 'text') return { kind: 'text', text: p.text };
      if (p.type === 'block' || p.type === 'code') return { kind: 'info', text: `[แสดงผล ${p.kind || p.lang || p.type}]` };
      return null;
    case 'activity':
      if (p.kind === 'tool-use') {
        if (p.parent || p.name === 'TodoWrite') return null; // a subagent's own calls would drown the log; the plan is drawn as progress
        const d = p.preview && Array.isArray(p.preview.diff) ? p.preview.diff.slice(0, MAX_DIFF_LINES) : null;
        const line = { kind: 'tool', id: p.id, name: p.name || 'tool', text: p.summary || p.name, status: 'running' };
        if (d && d.length) line.diff = d;
        else if (p.input !== undefined) {
          try { line.input = JSON.stringify(p.input, null, 2).slice(0, 1500); } catch { /* not printable */ }
        }
        return line;
      }
      if (p.kind === 'tool-result' && p.isError) {
        const why = String(p.text || '').trim().split('\n')[0].slice(0, 160);
        return { kind: 'err', text: `${p.name || 'เครื่องมือ'} ไม่สำเร็จ${why ? ': ' + why : ''}` };
      }
      return null;
    case 'todos': return null; // drawn as the progress list
    case 'notice': return { kind: p.level === 'error' ? 'err' : 'info', text: p.text };
    case 'error': return { kind: 'err', text: p.message || p.code };
    case 'turn:result': return { kind: p.isError ? 'err' : 'ok', text: p.isError ? `จบด้วยข้อผิดพลาด ${p.subtype || ''}`.trim() : 'จบงาน' };
    default: return null;
  }
}

function findTool(log, id) {
  for (let i = log.length - 1; i >= 0; i--) if (log[i].kind === 'tool' && log[i].id === id) return log[i];
  return null;
}

/**
 * A 'project:event' payload applied to the project's log.
 * @returns {{proj:object, op:'add'|'merge'|'update'|null, entry:object|null}|null}  null = unknown project.
 *   add: a new entry · merge: text appended to the last entry · update: a tool finished
 */
export function applyEventChange(model, e) {
  const proj = model.projects.get(e.projectId);
  if (!proj) return null;
  const p = e.payload || {};
  if (e.channel === 'activity' && p.kind === 'tool-result' && p.id) {
    const t = findTool(proj.log, p.id);
    if (t) {
      t.status = p.isError ? 'err' : 'ok';
      t.rejected = !!p.isError && (p.decision === 'reject' || /denied|ปฏิเสธ/i.test(p.text || ''));
      if (p.text) t.result = String(p.text).slice(0, MAX_TOOL_TEXT);
      return { proj, op: 'update', entry: t };
    }
  }
  const line = eventLine(e.channel, p);
  if (!line || !line.text) return { proj, op: null, entry: null };
  const last = proj.log[proj.log.length - 1];
  let change;
  if (line.kind === 'text' && last && last.kind === 'text') {
    last.text += line.text;
    change = { proj, op: 'merge', entry: last };
  } else {
    const entry = { ...line };
    proj.log.push(entry);
    change = { proj, op: 'add', entry };
  }
  if (proj.log.length > MAX_LOG) proj.log.splice(0, proj.log.length - MAX_LOG);
  return change;
}

/** Same as applyEventChange, returning the project, or null when the event changed nothing. */
export function applyEvent(model, e) {
  const r = applyEventChange(model, e);
  return r && r.op ? r.proj : null;
}

/** HUD chip text, '' when there is nothing to show. */
export function chipText(model) {
  const list = [...model.projects.values()].map((x) => x.info);
  if (!list.length) return '';
  const running = list.filter((x) => BUSY.has(x.status)).length;
  const waiting = list.filter((x) => x.status === 'awaiting-approval').length;
  const failed = list.filter((x) => x.status === 'error').length;
  const parts = [running ? `งานเบื้องหลัง ${running}` : `โปรเจกต์ ${list.length}`];
  if (waiting) parts.push(`รออนุมัติ ${waiting}`);
  if (failed) parts.push(`ผิดพลาด ${failed}`);
  return parts.join(' · ');
}

const HOME_ORDER = { 'awaiting-approval': 0, running: 1, error: 2 };

/** Cards for the home HUD: approvals first, then running, failed, the rest; newest first within each. */
export function homeCards(model, max = 3) {
  const list = [...model.projects.values()].map((x) => x.info).filter(Boolean);
  const rank = (p) => HOME_ORDER[p.status] ?? 3;
  list.sort((a, b) => rank(a) - rank(b) || (b.startedAt || 0) - (a.startedAt || 0));
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

/** The project to show when the popup opens: one waiting for an answer, then a running one, then the newest. */
export function pickProject(model) {
  const list = [...model.projects.values()].map((x) => x.info).filter(Boolean);
  list.sort((a, b) => (HOME_ORDER[a.status] ?? 3) - (HOME_ORDER[b.status] ?? 3) || (b.startedAt || 0) - (a.startedAt || 0));
  return list.length ? list[0].projectId : null;
}

/** Folders offered for a new task: picked ones and the folder list, minus the HUD's own folder; existing projects first. */
export function folderChoices(options, projects, chosen = []) {
  const out = [];
  const seen = new Set();
  const add = (p, label) => {
    const k = String(p).toLowerCase();
    if (!p || seen.has(k)) return;
    seen.add(k);
    out.push({ path: p, label });
  };
  for (const x of projects) add(x.cwd, `${x.name} · โปรเจกต์เดิม`);
  for (const p of chosen) add(p, p);
  for (const o of options) if (!o.current) add(o.path, o.path);
  return out;
}

/** 65 s → "1:05", 3725 s → "1:02:05" */
export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ---------------- DOM ----------------

export class ProjectsPanel {
  /**
   * The popup (#pj) is a surface of the shared large viewer, like the conversation.
   * @param {{api: any, el: Function, notice: Function, viewer: any, canKey?: () => boolean, isHomeVisible?: () => boolean, onPromoted?: Function, slash?: any}} o
   *   slash: the "/" menu of the message box (#proj-input), if any (to repaint its highlight after code changes the text)
   */
  constructor({ api, el, notice, viewer, canKey = () => true, isHomeVisible = () => false, onPromoted = () => {}, slash = null }) {
    this.onPromoted = onPromoted;
    this.slash = slash;
    this.api = api;
    this.el = el;
    this.notice = notice;
    this.viewer = viewer;
    this.canKey = canKey;
    this.isHomeVisible = isHomeVisible;
    this.home = document.getElementById('proj-home');
    this.model = createModel();
    this.chosen = [];
    this.sel = undefined; // undefined: pick on open · null: the new-task form · a projectId
    this.drafts = new Map(); // projectId -> text typed in its message box, not sent yet
    this.nodes = new WeakMap(); // log entry -> its DOM node
    this.inDom = []; // log entries drawn in #proj-chat, in order
    this.$ = (id) => document.getElementById(id);
    this.root = this.$('pj');
    this.list = this.$('proj-list');
    this.chat = this.$('proj-chat');
    this.input = this.$('proj-input');
    this.chip = this.$('proj-chip');
    const inner = this.root.querySelector('.cv-inner');
    viewer.registerSurface('projects', {
      root: this.root,
      fill: this.root.querySelector('.sv-fill'),
      frame: this.root.querySelector('.sv-frame'),
      inner,
      head: this.$('pj-head'),
      bodies: inner.querySelector('.cv-pane'),
      foot: inner.querySelector('.cv-foot'),
    }, {
      beforeShow: () => this._layoutBadge(),
      focus: () => this._focus(),
      shown: () => this._layoutBadge(),
    });
    viewer.onChange((ev) => { if (ev === 'layout') this._layoutBadge(); });
    addEventListener('resize', () => { if (this.isFront) this._layoutBadge(); });
    this.$('pj-close').addEventListener('click', () => this.close());
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isFront && this.canKey()) { e.preventDefault(); this.close(); }
    }, true);
    this.chip.addEventListener('click', () => this.open());
    this.$('proj-new-btn').addEventListener('click', () => this.select(null));
    this.$('proj-choose').addEventListener('click', () => this.choose());
    this.$('proj-start').addEventListener('click', () => this.startNew());
    this.$('proj-task').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); this.startNew(); }
    });
    // the message box of the selected project
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
    });
    this.input.addEventListener('input', () => {
      this._autosize();
      if (this.sel) this.drafts.set(this.sel, this.input.value);
    });
    this.$('proj-send').addEventListener('click', () => this.send());
    this.$('proj-stop').addEventListener('click', () => this.sel && this._call('project:stop', this.sel));
    api.on('project:status', (p) => this._onStatus(p));
    api.on('project:event', (e) => this._onEvent(e));
    this.timer = setInterval(() => this._tick(), 1000);
    this.refresh();
  }

  async refresh() {
    const r = await this.api.invoke('project:list').catch(() => null);
    if (!r || !r.ok) return;
    for (const p of r.projects) applyStatus(this.model, p);
    this.render();
  }

  /** Requested open (it may sit behind the viewer for a moment). */
  get isOpen() {
    return this.viewer.surfaceOpen('projects');
  }

  /** Open and in front of the viewer (what the user sees, or is about to). */
  get isFront() {
    return this.isOpen && this.viewer._target() === 'projects';
  }

  /** `id`: a project to show. */
  open(id) {
    if (id) this.sel = id;
    if (this.isFront) {
      if (id) this.select(id);
      return;
    }
    this.viewer.showSurface('projects');
    this.load();
  }

  close() {
    if (this.isOpen) this.viewer.hideSurface('projects');
  }

  /** Keep the content clear of the reactor badge in the bottom-left corner. */
  _layoutBadge() {
    const b = this.viewer.badge ? this.viewer.badge('projects') : null;
    const inner = this.root.querySelector('.cv-inner');
    const r = inner.getBoundingClientRect();
    if (!b || !r.width) return;
    inner.style.setProperty('--cv-badge', `${Math.max(24, Math.ceil(r.bottom - (b.cy - b.r)) + 8)}px`);
  }

  _focus() {
    (this.sel ? this.input : this.$('proj-task')).focus({ preventScroll: true });
  }

  /** Called when the popup opens: folder list + current state. */
  async load() {
    await this.refresh();
    await this._fillFolders();
    if (this.sel === undefined || (this.sel && !this.model.projects.has(this.sel))) this.sel = pickProject(this.model);
    this.select(this.sel, { focus: false });
  }

  async _fillFolders(select) {
    const opts = await this.api.invoke('folder:options').catch(() => []);
    const items = folderChoices(opts || [], [...this.model.projects.values()].map((x) => x.info), this.chosen);
    const sel = this.$('proj-dir');
    const keep = select || sel.value;
    sel.replaceChildren(...items.map((x) => this.el('option', { value: x.path, text: x.label })));
    if (!items.length) sel.append(this.el('option', { value: '', text: '— กด "เลือกโฟลเดอร์" ก่อน' }));
    if (keep && items.some((x) => x.path === keep)) sel.value = keep;
  }

  async choose() {
    const r = await this.api.invoke('project:choose').catch(() => null);
    if (!r || !r.ok) return;
    if (!this.chosen.includes(r.path)) this.chosen.unshift(r.path);
    await this._fillFolders(r.path);
  }

  async startNew() {
    const dir = this.$('proj-dir').value;
    const text = this.$('proj-task').value.trim();
    if (!dir) return this._msg('เลือกโฟลเดอร์ก่อน');
    if (!text) return this._msg('พิมพ์งานที่จะให้ทำก่อน');
    this._msg('กำลังเริ่ม…');
    const picked = document.querySelector('input[name="proj-approval"]:checked');
    const r = await this.start(dir, text, this.$('proj-iso').checked, picked && picked.value === 'auto' ? 'auto' : 'ask');
    if (r.ok) {
      this.$('proj-task').value = '';
      this._msg('');
      await this.refresh();
      this.select(r.projectId);
    } else this._msg(r.error || 'เริ่มงานไม่ได้');
  }

  _msg(text) {
    this.$('proj-msg').textContent = text;
  }

  start(dir, text, isolate = false, approval = 'ask') {
    return this.api.invoke('project:start', { dir, text, isolate, approval }).catch((err) => ({ ok: false, error: err.message }));
  }

  /** Send what is typed to the selected project: it starts now, or waits in the project's queue. */
  async send() {
    const id = this.sel;
    const p = id && this.model.projects.get(id);
    const text = this.input.value.trim();
    if (!p || !text || this.sending) return;
    this.sending = true;
    const r = await this.start(p.info.cwd, text);
    this.sending = false;
    if (r.ok) {
      if (this.sel === id) {
        this.input.value = '';
        this._autosize();
        this.input.dispatchEvent(new Event('input')); // lets the "/" menu and its highlight follow
      }
      this.drafts.delete(id);
      if (r.queued) this.notice(`เข้าคิวแล้ว (งานที่ ${r.queued}) — จะทำต่อเมื่องานปัจจุบันเสร็จ`, 'info');
    } else this.notice(r.error || 'เริ่มงานไม่ได้', 'warn');
    if (this.sel === id) this.input.focus();
  }

  /** Continue this project's conversation in the HUD's own chat. */
  async promote(projectId) {
    const r = await this.api.invoke('project:promote', { projectId }).catch((err) => ({ ok: false, error: err.message }));
    if (!r.ok) return this.notice(r.error || 'ย้ายไปแชทหลักไม่ได้', 'warn');
    this.drafts.delete(projectId);
    this.close();
    this.onPromoted(r.messages, r.title);
  }

  async _call(channel, projectId, extra = {}) {
    const r = await this.api.invoke(channel, { projectId, ...extra }).catch((err) => ({ ok: false, error: err.message }));
    if (!r.ok) this.notice(r.error || 'ทำไม่ได้', 'warn');
  }

  // ---------- events ----------

  _onStatus(p) {
    const had = this.model.projects.get(p.projectId);
    const before = had ? had.log.length : 0;
    applyStatus(this.model, p);
    if (p.announce) this.notice(p.announce, p.status === 'error' ? 'error' : 'info');
    if (p.status === 'removed' && this.sel === p.projectId) {
      this.drafts.delete(p.projectId);
      this.sel = pickProject(this.model);
      return this.select(this.sel, { focus: false });
    }
    this.render();
    if (this.sel === p.projectId) {
      const now = this.model.projects.get(p.projectId);
      if (now && now.log.length !== before) this._syncChat(now);
    }
  }

  _onEvent(e) {
    const ch = applyEventChange(this.model, e);
    if (ch && ch.op && this.sel === e.projectId && this.isOpen) this._syncChat(ch.proj, ch.entry);
  }

  // ---------- selection ----------

  /** Show a project's conversation (id) or the new-task form (null). */
  select(id, { focus = true } = {}) {
    if (this.sel) this.drafts.set(this.sel, this.input.value);
    this.sel = id && this.model.projects.has(id) ? id : null;
    this.input.value = (this.sel && this.drafts.get(this.sel)) || '';
    this.input.dispatchEvent(new Event('input'));
    this._buildChat();
    this.render();
    if (focus && this.isOpen) this._focus();
  }

  render() {
    const text = chipText(this.model);
    this.chip.hidden = !text;
    this.$('proj-chip-text').textContent = text;
    const list = [...this.model.projects.values()];
    this.chip.classList.toggle('att', list.some((x) => x.info.status === 'awaiting-approval'));
    this.chip.classList.toggle('err', list.some((x) => x.info.status === 'error'));
    this.chip.classList.toggle('busy', list.some((x) => BUSY.has(x.info.status)));
    this._renderHome();
    this._renderSide(list);
    this._renderView();
  }

  // ---------- left: project list ----------

  _renderSide(list) {
    const el = this.el;
    if (!list.length) {
      this.list.replaceChildren(el('div', { class: 'pj-empty', text: 'ยังไม่มีงานเบื้องหลัง กด ＋ งานใหม่ เพื่อเริ่ม ระหว่างนั้นคุยกับ JARVIS ในหน้าหลักได้ตามปกติ' }));
      return;
    }
    list.sort((a, b) => (HOME_ORDER[a.info.status] ?? 3) - (HOME_ORDER[b.info.status] ?? 3) || (b.info.startedAt || 0) - (a.info.startedAt || 0));
    this.list.replaceChildren(...list.map((x) => this._item(x.info)));
  }

  _item(p) {
    const el = this.el;
    const busy = BUSY.has(p.status);
    const sub = p.status === 'awaiting-approval' ? 'รอคุณกดอนุญาตบนจอ'
      : p.status === 'error' && p.error ? p.error
      : busy && p.progress && p.progress.current ? p.progress.current
      : p.task || p.lastText || '—';
    const meta = [];
    if (p.queue && p.queue.length) meta.push(`คิว ${p.queue.length}`);
    const prog = progressText(p);
    const item = el('button', {
      class: `pj-item ${p.status}${p.projectId === this.sel ? ' on' : ''}`, type: 'button', role: 'option', 'data-id': p.projectId,
      'aria-selected': String(p.projectId === this.sel), title: `${p.name} — ${p.cwd}`, onclick: () => this.select(p.projectId),
    },
    el('span', { class: 'pj-it-head' },
      el('span', { class: 'pj-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'pj-it-name', text: p.name }),
      el('span', { class: 'pj-it-time mono dim', 'data-time': '' })),
    el('span', { class: 'pj-it-sub', text: sub }),
    el('span', { class: 'pj-it-meta mono dim', text: [STATUS_LABEL[p.status] || p.status, prog, ...meta].filter(Boolean).join(' · ') }));
    if (busy || (p.progress && p.progress.total)) {
      const fill = el('span', { class: 'pj-mini-fill' });
      fill.style.width = `${progressPercent(p)}%`; // CSSOM, not a style attribute (CSP: style-src 'self')
      item.append(el('span', { class: 'pj-mini' }, fill));
    }
    this._time(item, p);
    return item;
  }

  // ---------- right: header, progress, queue, message box ----------

  _renderView() {
    const showNew = !this.sel;
    this.$('proj-new').hidden = !showNew;
    this.$('proj-view').hidden = showNew;
    this.$('proj-new-btn').classList.toggle('on', showNew);
    if (showNew) return;
    const proj = this.model.projects.get(this.sel);
    if (!proj) return this.select(null, { focus: false });
    const p = proj.info;
    const el = this.el;
    const busy = BUSY.has(p.status);

    const bar = this.$('proj-bar');
    const btn = (cls, text, title, onclick) => el('button', { class: `cv-ctl ${cls}`, type: 'button', text, title, onclick });
    bar.replaceChildren(
      el('div', { class: 'pj-bar-id' },
        el('span', { class: `proj-badge ${p.status}`, text: STATUS_LABEL[p.status] || p.status }),
        el('b', { class: 'pj-bar-name', text: p.name }),
        el('span', { class: 'proj-branch mono', text: p.approval === 'auto' ? 'ไม่ถามสิทธิ์' : 'ถามทุกครั้ง', title: p.approval === 'auto' ? 'อนุญาตการเขียนโค้ด/รันคำสั่งอัตโนมัติ (เรื่องอันตรายยังถามเสมอ)' : 'ถามก่อนทุกครั้งที่ AI เขียนโค้ดหรือรันคำสั่ง' }),
        p.branch ? el('span', { class: 'proj-branch mono', text: `⎇ ${p.branch}`, title: `สำเนาแยกของ ${p.origin} — แก้ในสาขานี้ รวมกลับเองด้วย git merge` }) : null,
        el('span', { class: 'proj-cwd mono dim', text: p.cwd, title: p.cwd }),
        el('span', { class: 'proj-time mono dim', 'data-time': '' })),
      el('div', { class: 'pj-bar-act' },
        !busy && p.resumable ? btn('', '⇱ ทำต่อในแชทหลัก', 'ย้ายบทสนทนาของโปรเจกต์นี้ไปคุยต่อในหน้าหลัก', () => this.promote(p.projectId)) : null,
        !busy ? btn('', '✕ ปิดโปรเจกต์', 'ปิดโปรเจกต์นี้ (บทสนทนาของ Claude ยังอยู่ในประวัติของโฟลเดอร์)', () => this._call('project:remove', p.projectId)) : null));
    this._time(bar, p);

    // progress: bar + plan + the waiting-for-approval line
    const prog = this.$('proj-prog');
    const text = progressText(p);
    const todos = p.todos || [];
    prog.hidden = !(busy || text || todos.length || p.status === 'awaiting-approval');
    if (!prog.hidden) {
      const fill = el('span', { class: 'proj-bar-fill' });
      fill.style.width = `${progressPercent(p)}%`;
      const now = busy && p.progress && p.progress.current ? `กำลังทำ: ${p.progress.current}` : '';
      const kids = [];
      if (p.status === 'awaiting-approval') kids.push(el('div', { class: 'cv-perm' }, el('span', { class: 'cv-perm-k', text: 'รออนุมัติ' }), el('span', { class: 'cv-perm-s', text: 'รอคุณกดอนุญาตบนจอ — หน้าต่างขออนุญาตเปิดอยู่' })));
      if (busy || text) {
        kids.push(el('div', { class: 'proj-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(progressPercent(p)) }, fill));
        kids.push(el('div', { class: 'proj-prog mono dim', text: [text, now].filter(Boolean).join(' · ') || 'กำลังทำงาน…' }));
      }
      if (todos.length) {
        const open = this.todosOpen !== false;
        const d = el('details', { class: 'pj-todos' }, el('summary', { text: `รายการงานของ Claude (${todos.filter((t) => t.status === 'completed').length}/${todos.length})` }),
          el('ul', { class: 'proj-todos' }, ...todos.map((t) => el('li', { class: `td ${t.status}`, text: t.status === 'in_progress' ? t.activeForm : t.content }))));
        if (open) d.open = true;
        d.addEventListener('toggle', () => { this.todosOpen = d.open; });
        kids.push(d);
      }
      prog.replaceChildren(...kids);
    }

    // queue chips above the message box
    const q = this.$('proj-queue');
    const queue = p.queue || [];
    q.hidden = !queue.length;
    q.replaceChildren(...(queue.length ? [el('span', { class: 'pq-title mono dim', text: `คิวรอ ${queue.length}` })] : []),
      ...queue.map((t, i) => el('span', { class: 'pq-chip', title: t },
        el('span', { class: 'pq-text', text: `${i + 1}. ${t}` }),
        el('button', { class: 'pq-x', type: 'button', text: '✕', title: 'เอางานนี้ออกจากคิว', 'aria-label': `เอางานที่ ${i + 1} ออกจากคิว`, onclick: () => this._call('project:dequeue', p.projectId, { index: i }) }))));

    this.input.placeholder = busy ? 'งานกำลังรันอยู่ — พิมพ์งานถัดไปแล้วกด Enter เพื่อเข้าคิว' : 'พิมพ์ข้อความ หรือ /คำสั่ง แล้วกด Enter (Shift+Enter ขึ้นบรรทัดใหม่)';
    this.$('proj-stop').hidden = !busy;
  }

  _autosize() {
    const i = this.input;
    i.style.height = 'auto';
    i.style.height = `${Math.min(Math.max(i.scrollHeight, 32), 160)}px`;
    i.style.overflowY = i.scrollHeight > 160 ? 'auto' : 'hidden';
  }

  // ---------- right: the conversation ----------

  _buildChat() {
    this.chat.replaceChildren();
    this.inDom = [];
    const proj = this.sel && this.model.projects.get(this.sel);
    if (!proj) return;
    if (!proj.log.length) this._emptyChat(proj);
    this._syncChat(proj, null, { stick: true });
  }

  _emptyChat(proj) {
    this.chat.append(this.el('div', { class: 'msg system pj-nolog', text: proj.info.status === 'idle' ? 'ยังไม่มีบทสนทนา — พิมพ์งานด้านล่างเพื่อเริ่ม' : 'บันทึกเริ่มเมื่อเปิดแอปรอบนี้ — บทสนทนาเดิมของ Claude ยังอยู่ พิมพ์ต่อได้เลย' }));
  }

  /** Bring #proj-chat up to date with the project's log; `touched` = an entry that changed in place. */
  _syncChat(proj, touched = null, { stick = false } = {}) {
    const c = this.chat;
    const atBottom = stick || c.scrollHeight - c.scrollTop - c.clientHeight < 80;
    const known = new Set(this.inDom);
    const fresh = [];
    for (let i = proj.log.length - 1; i >= 0 && !known.has(proj.log[i]); i--) fresh.push(proj.log[i]);
    if (fresh.length) c.querySelector('.pj-nolog')?.remove();
    for (const entry of fresh.reverse()) {
      this.nodes.set(entry, this._node(entry));
      c.append(this.nodes.get(entry));
      this.inDom.push(entry);
    }
    if (touched && known.has(touched)) this._paint(touched);
    while (this.inDom.length && this.inDom[0] !== proj.log[0]) { // the log keeps its newest lines only
      const old = this.inDom.shift();
      const n = this.nodes.get(old);
      if (n) n.remove();
    }
    if (atBottom) c.scrollTop = c.scrollHeight;
  }

  _node(entry) {
    const el = this.el;
    switch (entry.kind) {
      case 'sep': return el('div', { class: 'cv-new-mark', text: entry.text });
      case 'user': return el('div', { class: 'msg user', text: entry.text });
      case 'text': return el('div', { class: 'msg assistant', text: entry.text });
      case 'tool': {
        const st = el('span', { class: 'cv-tool-st' });
        const d = el('details', { class: 'cv-tool' },
          el('summary', {}, el('span', { class: 'cv-tool-n', text: entry.name }), el('span', { class: 'cv-tool-s', text: entry.text || '' }), st));
        if (entry.diff) {
          const box = el('div', { class: 'diff mono' });
          for (const l of entry.diff) {
            const cls = l.op === '+' ? 'add' : l.op === '-' ? 'del' : l.op === '@' || l.op === '!' ? 'hdr' : '';
            box.append(el('div', { class: cls, text: `${l.op === '@' || l.op === '!' ? '' : l.op} ${l.line}` }));
          }
          d.append(box);
        } else if (entry.input) d.append(el('pre', { class: 'cv-tool-io mono', text: entry.input }));
        d._st = st;
        this.nodes.set(entry, d);
        this._paint(entry);
        return d;
      }
      case 'err': return el('div', { class: 'msg system pj-err', text: entry.text });
      case 'ok': return el('div', { class: 'msg system pj-ok', text: entry.text });
      default: return el('div', { class: 'msg system', text: entry.text });
    }
  }

  /** Redraw the parts of an entry's node that change after it was created. */
  _paint(entry) {
    const n = this.nodes.get(entry);
    if (!n) return;
    if (entry.kind === 'text') n.textContent = entry.text;
    else if (entry.kind === 'tool') {
      n.classList.remove('running', 'ok', 'err');
      n.classList.add(entry.status);
      n._st.textContent = entry.status === 'running' ? '● กำลังทำงาน' : entry.status === 'err' ? (entry.rejected ? '✕ ถูกปฏิเสธ' : '✕ ผิดพลาด') : '✓ เสร็จ';
      if (entry.result && !n._result) {
        n._result = this.el('pre', { class: 'cv-tool-io mono', text: entry.result });
        n.append(this.el('div', { class: 'cv-tool-lbl', text: 'ผลลัพธ์' }), n._result);
      }
    }
  }

  // ---------- HUD: mini cards under the reactor ----------

  /** Mini cards under the reactor on the home HUD; click → PROJECTS with that project open. */
  _renderHome() {
    if (!this.home) return;
    const { shown, more } = homeCards(this.model);
    const el = this.el;
    const open = (id) => this.open(id);
    if (!shown.length) {
      this.home.replaceChildren(el('button', { class: 'ph-card ph-empty', type: 'button', title: 'เปิดหน้าต่าง PROJECTS เพื่อสั่งงานเบื้องหลัง', onclick: () => open() },
        el('span', { class: 'ph-head' }, el('span', { class: 'proj-badge', text: 'ว่าง' }), el('span', { class: 'ph-name', text: 'งานเบื้องหลัง' })),
        el('span', { class: 'ph-task', text: 'ยังไม่มีงาน · กดเพื่อสั่งงานใหม่' })));
      return;
    }
    const cards = shown.map((p) => {
      const card = el('button', { class: `ph-card ${p.status}`, type: 'button', 'data-id': p.projectId, title: `${p.name} — ${p.cwd}\nคลิกเพื่อดูในหน้าต่าง PROJECTS`, onclick: () => open(p.projectId) },
        el('span', { class: 'ph-head' },
          el('span', { class: `proj-badge ${p.status}`, text: STATUS_LABEL[p.status] || p.status }),
          el('span', { class: 'ph-name', text: p.name }),
          el('span', { class: 'ph-time mono dim', 'data-time': '' })),
        el('span', { class: 'ph-task', text: p.status === 'awaiting-approval' ? 'รอคุณกดอนุญาต' : p.status === 'error' && p.error ? p.error : p.task || '—' }));
      this._time(card, p);
      return card;
    });
    if (more) cards.push(el('button', { class: 'ph-more mono', type: 'button', text: `+${more}`, title: `อีก ${more} โปรเจกต์ — เปิดหน้าต่าง PROJECTS`, onclick: () => open() }));
    this.home.replaceChildren(...cards);
  }

  _time(card, p) {
    const t = card.querySelector('[data-time]');
    if (!t || !p.startedAt) return;
    const end = BUSY.has(p.status) ? Date.now() : p.endedAt || Date.now();
    t.textContent = fmtElapsed(end - p.startedAt);
  }

  _tick() {
    const open = this.isOpen;
    const home = this.isHomeVisible();
    if (!open && !home) return;
    for (const x of this.model.projects.values()) {
      if (!BUSY.has(x.info.status)) continue;
      const id = x.info.projectId;
      const at = (box) => box && box.querySelector(`[data-id="${id}"]`);
      const spots = [];
      if (open) {
        spots.push(at(this.list));
        if (this.sel === id) spots.push(this.$('proj-bar'));
      }
      if (home) spots.push(at(this.home));
      for (const s of spots) if (s) this._time(s, x.info);
    }
  }
}
