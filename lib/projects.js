'use strict';
// Several projects at once: one JarvisCore per folder. The primary core is the
// conversation on the HUD; every other core runs one background task at a time
// in its own folder with its own Claude process, permission broker (pipe + token)
// and audit log. Runs without Electron and talks to the UI only through `ui()`.
//
// Events of a background core never reach the HUD's own channels (they would land
// in the main chat): they are wrapped as 'project:event'. Approval requests keep
// their channels (with projectId) so they can be answered; speech is dropped and a
// short `announce` line is put on the final 'project:status' for the voice queue.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { inside, attachProblem } = require('./permissions/safe');
const { createWorktree, removeWorktreeIfClean, worktreeRoot, BRANCH_RE } = require('./worktree');

const MAX_PROJECTS = 16; // background cores kept (finished ones too), until removed
const PASS_THROUGH = new Set(['approval:request', 'approval:close']);
const SPEECH = /^tts:/;
const BUSY_STATES = new Set(['running', 'awaiting-approval']);

const MAX_QUEUE = 10;
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const MAX_TODOS = 50;
const MAX_FILES = 500;
const TODO_STATES = new Set(['pending', 'in_progress', 'completed']);

/** TodoWrite input → the few fields the UI draws. */
function cleanTodos(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_TODOS).filter((t) => t && typeof t === 'object').map((t) => ({
    content: String(t.content || t.activeForm || '').slice(0, 200),
    activeForm: String(t.activeForm || t.content || '').slice(0, 200),
    status: TODO_STATES.has(t.status) ? t.status : 'pending',
  }));
}

const projectIdFor = (dir) => 'p-' + crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 10);

class ProjectManager {
  /**
   * @param {object} o
   * @param {import('./jarvis-core').JarvisCore} o.main  the HUD's core (id 'main')
   * @param {(opts:{id:string, name:string, ui:Function}) => import('./jarvis-core').JarvisCore} o.createCore
   * @param {(channel:string, payload:object) => void} o.ui
   * @param {{get:() => object}} o.settings
   * @param {string} [o.home]  home folder for the attach rules (system folders, AppData, …)
   */
  constructor({ main, createCore, ui, settings, home = os.homedir(), stateFile = null, worktree = null }) {
    this.worktree = worktree || { create: createWorktree, removeIfClean: removeWorktreeIfClean }; // git worktrees (lib/worktree.js)
    this.main = main;
    this.createCore = createCore;
    this.ui = ui;
    this.settings = settings;
    this.home = home;
    this.stateFile = stateFile; // where projects survive an app restart (null = not persisted)
    this.saveTimer = null;
    this.projects = new Map(); // id -> entry
    this.starting = new Set(); // folders whose core is being created
    main.dirGuard = (dir) => this._mainDirProblem(dir);
  }

  // ---------- keeping projects across restarts ----------

  /**
   * Bring back the projects of the last run as idle entries: no Claude process is started
   * until the project gets a task, which then continues its conversation (--resume).
   * A task that was running when the app closed shows as stopped.
   */
  restore() {
    if (!this.stateFile) return 0;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return 0; // first run, or unreadable: start empty
    }
    if (!saved || !Array.isArray(saved.projects)) return 0;
    let n = 0;
    for (const s of saved.projects) {
      if (this.projects.size >= MAX_PROJECTS) break;
      if (!s || typeof s.cwd !== 'string' || !path.isAbsolute(s.cwd)) continue;
      const cwd = path.resolve(s.cwd);
      const id = projectIdFor(cwd);
      if (this.projects.has(id) || this._bgDirProblem(cwd, null)) continue;
      const wasBusy = BUSY_STATES.has(s.status);
      const dropped = wasBusy && Array.isArray(s.queue) ? s.queue.length : 0;
      this.projects.set(id, {
        id,
        name: String(s.name || path.basename(cwd) || cwd).slice(0, 100),
        cwd,
        status: wasBusy ? 'stopped' : ['done', 'error', 'stopped'].includes(s.status) ? s.status : 'idle',
        task: String(s.task || '').slice(0, 300),
        startedAt: Number.isFinite(s.startedAt) ? s.startedAt : null,
        endedAt: Number.isFinite(s.endedAt) ? s.endedAt : null,
        lastText: String(s.lastText || '').slice(-300),
        error: wasBusy ? `แอปปิดระหว่างทำงาน${dropped ? ` (คิวที่ค้าง ${dropped} งานถูกล้าง)` : ''}` : s.error ? String(s.error).slice(0, 500) : null,
        core: null,
        sessionId: typeof s.sessionId === 'string' && SESSION_ID.test(s.sessionId) ? s.sessionId : null,
        // a worktree copy: all three must look right, or it is treated as a plain folder (and never cleaned up)
        ...(typeof s.origin === 'string' && path.isAbsolute(s.origin) && BRANCH_RE.test(s.branch || '') && /^[0-9a-f]{40,64}$/.test(s.baseSha || '') && inside(cwd, worktreeRoot(s.origin))
          ? { origin: path.resolve(s.origin), branch: s.branch, baseSha: s.baseSha }
          : { origin: null, branch: null, baseSha: null }),
        approval: s.approval === 'auto' ? 'auto' : 'ask',
        queue: [],
        todos: cleanTodos(s.todos),
        files: new Set(),
        pendingFiles: new Map(),
      });
      n++;
    }
    return n;
  }

  _snapshot() {
    return {
      version: 1,
      projects: [...this.projects.values()].map((e) => ({
        name: e.name, cwd: e.cwd, status: e.status, task: e.task, startedAt: e.startedAt, endedAt: e.endedAt,
        lastText: e.lastText, error: e.error, sessionId: e.sessionId, queue: e.queue.length ? e.queue : undefined, todos: e.todos,
        origin: e.origin, branch: e.branch, baseSha: e.baseSha, approval: e.approval,
      })),
    };
  }

  /** Debounced: status changes come in bursts. */
  _save() {
    if (!this.stateFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this._flush(), 400);
    this.saveTimer.unref();
  }

  _flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.stateFile) return;
    try {
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._snapshot()));
      fs.renameSync(tmp, this.stateFile); // atomic: a crash can't leave truncated JSON
    } catch { /* best effort: the projects just don't come back next time */ }
  }

  // ---------- queries ----------

  get(id) {
    if (id === 'main') return this.main;
    const e = this.projects.get(id);
    return e ? e.core : null;
  }

  list() {
    return [...this.projects.values()].map((e) => this._public(e));
  }

  _public(e) {
    return {
      projectId: e.id,
      name: e.name,
      cwd: e.cwd,
      status: e.status,
      task: e.task,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      lastText: e.lastText,
      error: e.error,
      pendingApprovals: e.core ? e.core.pending.size : 0,
      todos: e.todos,
      progress: {
        done: e.todos.filter((t) => t.status === 'completed').length,
        total: e.todos.length,
        current: (e.todos.find((t) => t.status === 'in_progress') || {}).activeForm || '',
      },
      filesChanged: e.files.size,
      queue: e.queue.map((t) => t.slice(0, 200)),
      branch: e.branch,
      origin: e.origin,
      approval: e.approval === 'auto' ? 'auto' : 'ask',
      resumable: !!e.sessionId,
    };
  }

  _byDir(dir) {
    const key = path.resolve(dir).toLowerCase();
    return [...this.projects.values()].find((e) => e.cwd.toLowerCase() === key) || null;
  }

  _running() {
    return [...this.projects.values()].filter((e) => BUSY_STATES.has(e.status)).length;
  }

  // ---------- folder ownership ----------

  /** Folders overlap when one is the other or contains it: Claude in one could edit the other. */
  _overlaps(a, b) {
    return !!a && !!b && (inside(a, b) || inside(b, a));
  }

  /** The HUD wants to switch to `dir`: refuse a folder a background task is working in; drop idle ones. */
  _mainDirProblem(dir) {
    for (const e of [...this.projects.values()]) {
      if (!this._overlaps(dir, e.cwd)) continue;
      if (BUSY_STATES.has(e.status) || this.starting.has(e.cwd.toLowerCase())) return `โปรเจกต์ ${e.name} กำลังทำงานเบื้องหลังในโฟลเดอร์นี้ รอให้เสร็จหรือสั่งหยุดก่อน`;
      this.remove(e.id);
    }
    return null;
  }

  /** Why a background task can't run in `dir` (null = fine). */
  _bgDirProblem(dir, self) {
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      return 'ไม่พบโฟลเดอร์';
    }
    if (!st.isDirectory()) return 'ไม่ใช่โฟลเดอร์';
    const why = attachProblem(dir, true, this.home);
    if (why) return `ใช้โฟลเดอร์นี้ไม่ได้ (${why})`;
    if (this._overlaps(dir, this.main.cwd)) return 'โฟลเดอร์นี้ใช้ในบทสนทนาหลักอยู่ เลือกโฟลเดอร์อื่นสำหรับงานเบื้องหลัง';
    for (const e of this.projects.values()) {
      if (e !== self && this._overlaps(dir, e.cwd)) return `โฟลเดอร์นี้ซ้อนกับโปรเจกต์ ${e.name}`;
    }
    return null;
  }

  // ---------- tasks ----------

  /**
   * Run `text` as a background task in `dir`. One core per folder, one task at a time per core:
   * while a task runs, further tasks for the same folder wait in its queue and follow one by one.
   * @returns {Promise<{ok:true, projectId:string, turnId:number|null, queued?:number}>}  throws Error with .code otherwise
   */
  async start({ dir, text, isolate = false, approval }) {
    const task = String(text || '').trim();
    if (!task) throw Object.assign(new Error('ยังไม่ได้บอกงานที่จะให้ทำ'), { code: 'EMPTY' });
    let abs = path.resolve(String(dir || ''));
    let e = this._byDir(abs);
    // 'ask' = every permission request asks the user; 'auto' = no asking (guard requests still ask). Unset keeps the project's choice.
    const policy = approval === 'auto' || approval === 'ask' ? approval : null;
    if (policy && e) this._setApproval(e, policy);
    // isolate: the task works in its own git worktree of `abs` (a follow-up in an existing project just continues there)
    const fresh = isolate && !e;
    if (fresh) {
      const bad = this._repoProblem(abs);
      if (bad) throw Object.assign(new Error(bad), { code: 'FOLDER' });
    } else {
      const why = this._bgDirProblem(abs, e);
      if (why) throw Object.assign(new Error(why), { code: 'FOLDER' });
    }
    if (e && BUSY_STATES.has(e.status)) return this._enqueue(e, task);
    if (e && e.core && e.core.session && e.core.session.busy) {
      throw Object.assign(new Error(`โปรเจกต์ ${e.name} ยังทำงานก่อนหน้าไม่เสร็จ`), { code: 'BUSY' });
    }
    if (this.starting.has(abs.toLowerCase())) throw Object.assign(new Error('กำลังเปิดโปรเจกต์นี้อยู่'), { code: 'BUSY' });
    const max = this.settings.get().maxBackgroundProjects;
    if (this._running() >= max) throw Object.assign(new Error(`งานเบื้องหลังรันพร้อมกันได้ไม่เกิน ${max} งาน`), { code: 'LIMIT' });
    if (!e && this.projects.size >= MAX_PROJECTS) throw Object.assign(new Error('มีโปรเจกต์เบื้องหลังมากเกินไป ลบโปรเจกต์ที่เสร็จแล้วก่อน'), { code: 'LIMIT' });
    let meta = null;
    if (fresh) {
      this.starting.add(abs.toLowerCase()); // held while git works: the same repo can't be isolated twice at once
      try {
        const made = await this.worktree.create(abs);
        meta = { origin: abs, branch: made.branch, baseSha: made.baseSha, name: `${path.basename(abs)} · ${made.branch.slice(7)}` };
        abs = made.path;
        const why = this._bgDirProblem(abs, null);
        if (why) throw Object.assign(new Error(why), { code: 'FOLDER' });
      } catch (err) {
        if (meta) this._dropWorktree({ ...meta, path: abs });
        throw err;
      } finally {
        this.starting.delete(path.resolve(String(dir)).toLowerCase());
      }
    }
    if (!e || !e.core) {
      // a new project, or one restored after a restart (no process yet): open its core, continuing its conversation
      this.starting.add(abs.toLowerCase());
      try {
        e = await this._open(abs, e, { ...meta, ...(policy ? { approval: policy } : {}) });
      } catch (err) {
        if (meta) this._dropWorktree({ ...meta, path: abs });
        throw err;
      } finally {
        this.starting.delete(abs.toLowerCase());
      }
    }
    return this._begin(e, task);
  }

  _setApproval(e, policy) {
    e.approval = policy;
    if (e.core) e.core.approvalPolicy = policy;
    this._status(e);
  }

  /** Why `dir` can't be copied into a worktree (null = fine). The repo itself may be the HUD's folder: that is the point. */
  _repoProblem(dir) {
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      return 'ไม่พบโฟลเดอร์';
    }
    if (!st.isDirectory()) return 'ไม่ใช่โฟลเดอร์';
    const why = attachProblem(dir, true, this.home);
    return why ? `ใช้โฟลเดอร์นี้ไม่ได้ (${why})` : null;
  }

  /** Remove an unused worktree in the background and tell the user what became of it. */
  _dropWorktree(w, entry = null) {
    this.worktree.removeIfClean({ origin: w.origin, path: w.path, branch: w.branch, baseSha: w.baseSha }).then((r) => {
      if (r.removed) return;
      const name = entry ? entry.name : w.branch;
      this.ui('project:status', {
        projectId: entry ? entry.id : projectIdFor(w.path), status: 'removed', name,
        announce: `เก็บสำเนา ${name} ไว้ที่ ${w.path} (สาขา ${w.branch}) เพราะ${r.reason || 'ลบไม่ได้'}`,
      });
    }).catch(() => { /* nothing more to do */ });
  }

  _enqueue(e, task) {
    if (e.queue.length >= MAX_QUEUE) throw Object.assign(new Error(`คิวของโปรเจกต์ ${e.name} เต็มแล้ว (${MAX_QUEUE} งาน)`), { code: 'LIMIT' });
    e.queue.push(task);
    this._status(e);
    return { ok: true, projectId: e.id, turnId: null, queued: e.queue.length };
  }

  /** Remove the `index`-th waiting task. */
  dequeue(id, index) {
    const e = this.projects.get(id);
    if (!e) return { ok: false, error: 'ไม่พบโปรเจกต์' };
    if (!Number.isInteger(index) || index < 0 || index >= e.queue.length) return { ok: false, error: 'ไม่พบงานในคิว' };
    e.queue.splice(index, 1);
    this._status(e);
    return { ok: true };
  }

  /** The core is idle: send `task` and track it. */
  _begin(e, task) {
    Object.assign(e, { status: 'running', task: task.slice(0, 300), startedAt: Date.now(), endedAt: null, lastText: '', error: null, stopping: false, resultError: false, todos: [], files: new Set(), pendingFiles: new Map() });
    this._status(e);
    let turnId;
    try {
      turnId = e.core.send({ text: task, t0: Date.now() });
    } catch (err) {
      this._finish(e, 'error', err.message);
      throw err;
    }
    this.ui('project:event', { projectId: e.id, channel: 'user:message', payload: { projectId: e.id, text: task.slice(0, 2000) } });
    // handled locally (e.g. "เปลี่ยนโมเดลเป็น …"): no Claude turn
    if (turnId === null) this._finish(e, 'done');
    return { ok: true, projectId: e.id, turnId };
  }

  /** A task ended well: start the next waiting one (the core may need a moment to be idle). */
  _runNext(e, tries = 0) {
    if (this.projects.get(e.id) !== e || BUSY_STATES.has(e.status) || !e.queue.length) return;
    if (e.core.session && e.core.session.busy && tries < 40) {
      setTimeout(() => this._runNext(e, tries + 1), 50).unref();
      return;
    }
    try {
      this._begin(e, e.queue.shift());
    } catch { /* _begin already reported the error on the project */ }
  }

  async _open(dir, existing = null, meta = null) {
    const id = projectIdFor(dir);
    const e = existing || { id, name: path.basename(dir) || dir, cwd: dir, status: 'idle', task: '', startedAt: null, endedAt: null, lastText: '', error: null, core: null, sessionId: null, origin: null, branch: null, baseSha: null, queue: [], todos: [], files: new Set(), pendingFiles: new Map(), ...meta };
    const core = this.createCore({ id, name: e.name, ui: (ch, p) => this._onCoreUi(e, ch, p) });
    core.approvalPolicy = e.approval === 'auto' ? 'auto' : 'ask';
    try {
      await core.init();
      core.setCwd(dir, { silent: true });
      if (e.sessionId) core.resumeSession(e.sessionId);
    } catch (err) {
      core.cleanup();
      throw Object.assign(err, { code: err.code || 'OPEN_FAILED' });
    }
    core.folderChosen = true; // picked explicitly for this task (git /commands don't ask again)
    e.core = core;
    this.projects.set(id, e);
    return e;
  }

  stop(id) {
    const e = this.projects.get(id);
    if (!e) return { ok: false, error: 'ไม่พบโปรเจกต์' };
    if (BUSY_STATES.has(e.status)) e.stopping = true;
    e.queue = []; // stopping means stopping: nothing waiting starts afterwards
    if (e.core) e.core.stop();
    if (BUSY_STATES.has(e.status)) this._finish(e, 'stopped');
    return { ok: true };
  }

  /** Stop if needed and close the project's core (its process tree is killed with taskkill /T). */
  remove(id, { keepWorktree = false } = {}) {
    const e = this.projects.get(id);
    if (!e) return { ok: false, error: 'ไม่พบโปรเจกต์' };
    this.projects.delete(id);
    if (e.core) e.core.cleanup();
    this.ui('project:status', { ...this._public(e), status: 'removed' });
    this._save();
    // its private copy goes too when nothing was done in it; otherwise it stays and the user is told where
    if (e.branch && !keepWorktree) this._dropWorktree({ origin: e.origin, path: e.cwd, branch: e.branch, baseSha: e.baseSha }, e);
    return { ok: true };
  }

  /**
   * Move an idle project's conversation to the HUD: the HUD's folder becomes the project's folder
   * and the Claude session continues there. The project leaves the background list (its worktree stays).
   * @returns {{ok:true, cwd:string, sessionId:string}|{ok:false, error:string}}
   */
  promote(id) {
    const e = this.projects.get(id);
    if (!e) return { ok: false, error: 'ไม่พบโปรเจกต์' };
    if (BUSY_STATES.has(e.status) || this.starting.has(e.cwd.toLowerCase())) return { ok: false, error: 'โปรเจกต์ยังทำงานอยู่ รอให้เสร็จหรือสั่งหยุดก่อน' };
    if (!e.sessionId) return { ok: false, error: 'โปรเจกต์นี้ยังไม่มีบทสนทนาให้ทำต่อ' };
    if (this.main.session && this.main.session.busy) return { ok: false, error: 'บทสนทนาหลักยังตอบไม่เสร็จ รอก่อนหรือกดหยุด' };
    if (!fs.existsSync(e.cwd)) return { ok: false, error: 'ไม่พบโฟลเดอร์ของโปรเจกต์' };
    const { cwd, sessionId } = e;
    this.remove(id, { keepWorktree: true }); // frees the folder (the HUD refuses a folder a project holds)
    try {
      this.main.setCwd(cwd);
      this.main.folderChosen = true;
      this.main.resumeSession(sessionId);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: true, cwd, sessionId };
  }

  respondApproval(projectId, r) {
    const core = this.get(projectId);
    if (!core) return { ok: false, errors: ['ไม่พบโปรเจกต์ของคำขอนี้'] };
    return core.respondApproval({ ...r, projectId });
  }

  dropAllApprovals(message) {
    this.main._dropPendingApprovals(message);
    for (const e of this.projects.values()) if (e.core) e.core._dropPendingApprovals(message);
  }

  onSettingsChanged(keys) {
    this.main.onSettingsChanged(keys);
    for (const e of this.projects.values()) if (e.core) e.core.onSettingsChanged(keys);
  }

  /** App exit: every core closes its CLI process tree and local runs. */
  disposeAll() {
    this._flush(); // while the entries (and the sessions to resume) still exist
    for (const e of this.projects.values()) if (e.core) e.core.cleanup();
    this.projects.clear();
    this.main.cleanup();
  }

  // ---------- events of background cores ----------

  _onCoreUi(e, channel, payload) {
    this._track(e, channel, payload);
    if (SPEECH.test(channel)) return; // one voice at a time: the HUD speaks, background tasks report via status
    if (PASS_THROUGH.has(channel)) {
      this.ui(channel, channel === 'approval:request' ? { ...payload, projectName: e.name } : payload);
      return;
    }
    this.ui('project:event', { projectId: e.id, channel, payload });
  }

  _track(e, channel, p) {
    if (channel === 'session' && p.kind === 'init' && p.sessionId && SESSION_ID.test(p.sessionId) && p.sessionId !== e.sessionId) {
      e.sessionId = p.sessionId; // what a restart resumes
      this._save();
    }
    if (!BUSY_STATES.has(e.status)) return;
    if (channel === 'chat:item' && p.type === 'text') e.lastText = (e.lastText + p.text).slice(-300);
    else if (channel === 'turn:result') {
      e.resultError = !!p.isError;
      if (p.resultText) e.lastText = p.resultText.slice(-300);
    } else if (channel === 'error') e.error = String(p.message || p.code || 'ผิดพลาด');
    else if (channel === 'todos') {
      e.todos = cleanTodos(p.todos);
      this._status(e);
    } else if (channel === 'activity' && !p.parent) {
      // a file counts as changed once its tool call succeeded (a denied edit does not)
      if (p.kind === 'tool-use' && FILE_TOOLS.has(p.name)) {
        const file = p.input && (p.input.file_path || p.input.notebook_path);
        if (file) e.pendingFiles.set(p.id, String(file));
      } else if (p.kind === 'tool-result' && e.pendingFiles.has(p.id)) {
        const file = e.pendingFiles.get(p.id);
        e.pendingFiles.delete(p.id);
        if (!p.isError && e.files.size < MAX_FILES && !e.files.has(file)) {
          e.files.add(file);
          this._status(e);
        }
      }
    } else if (channel === 'state') {
      if (p.state === 'AWAITING_APPROVAL') {
        if (e.status !== 'awaiting-approval') { e.status = 'awaiting-approval'; this._status(e); }
      } else if (p.state === 'STANDBY' || p.state === 'ERROR') {
        if (e.stopping || p.cancelled) this._finish(e, 'stopped');
        else if (p.state === 'ERROR' || e.resultError) this._finish(e, 'error', e.error || e.lastText || 'ผิดพลาด');
        else this._finish(e, 'done');
      } else if (e.status === 'awaiting-approval') {
        e.status = 'running';
        this._status(e);
      }
    }
  }

  _finish(e, status, error) {
    if (!BUSY_STATES.has(e.status)) return;
    e.status = status;
    e.endedAt = Date.now();
    if (error) e.error = String(error).slice(0, 500);
    const what = { done: 'เสร็จแล้ว', error: 'มีข้อผิดพลาด', stopped: 'หยุดแล้ว' }[status];
    const waiting = e.queue.length;
    let note = '';
    if (waiting && status === 'done') note = ` ต่อด้วยงานถัดไป เหลือในคิว ${waiting - 1} งาน`;
    else if (waiting) {
      note = ` ล้างคิว ${waiting} งาน`; // a failed or stopped task doesn't hand over to the next one
      e.queue = [];
    }
    this._status(e, `งานเบื้องหลังในโปรเจกต์ ${e.name} ${what}${note}`);
    if (status === 'done' && e.queue.length) setImmediate(() => this._runNext(e));
  }

  _status(e, announce) {
    this._save();
    this.ui('project:status', { ...this._public(e), ...(announce ? { announce } : {}) });
  }
}

module.exports = { ProjectManager, projectIdFor };
