'use strict';
// Local coding helpers behind the voice commands "รันเทสต์", "รันเช็ก",
// "ดู diff ล่าสุด" and "ยกเลิกการแก้ล่าสุด". They run in the app, not through
// Claude, so they answer fast and use no quota.
//
// Undo works on git snapshots: before every Claude turn in a git project the
// working tree is saved with `git stash create` (a commit object only — the
// working tree, index and stash list are not touched). Undo puts the files
// changed since the newest snapshot that differs from now back to that
// snapshot, and moves files created since then to the Recycle Bin.
// Before undoing, the current state is saved the same way so it can be recovered.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const MAX_SNAPSHOTS = 20;
const MAX_UNTRACKED = 20000;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_LINES = 400;
const MAX_PATCH = 200 * 1024;
const NPM_DEFAULT_TEST = /no test specified/i;
// a fixed identity, so snapshots work in repos without user.name / user.email
const GIT_ID = ['-c', 'user.name=JARVIS', '-c', 'user.email=jarvis@localhost', '-c', 'core.quotepath=false'];

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/**
 * The commands "รันเทสต์" / "รันเช็ก" run in this folder (fixed strings, never user text).
 * @returns {{test: {command:string}|null, check: {command:string}|null}}
 */
function detectChecks(cwd) {
  const has = (f) => fs.existsSync(path.join(cwd, f));
  const out = { test: null, check: null };
  if (has('package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts || {}; } catch { /* broken package.json */ }
    if (scripts.test && !NPM_DEFAULT_TEST.test(scripts.test)) out.test = { command: 'npm test' };
    const chk = ['check', 'lint', 'typecheck', 'build'].find((k) => typeof scripts[k] === 'string');
    if (chk) out.check = { command: `npm run ${chk}` };
  }
  if (!out.test && (has('pytest.ini') || has('pyproject.toml') || has('setup.cfg') || has('tox.ini')) && (has('tests') || has('test'))) out.test = { command: 'python -m pytest -q' };
  if (has('Cargo.toml')) {
    out.test = out.test || { command: 'cargo test' };
    out.check = out.check || { command: 'cargo check' };
  }
  if (has('go.mod')) {
    out.test = out.test || { command: 'go test ./...' };
    out.check = out.check || { command: 'go vet ./...' };
  }
  if (has('platformio.ini')) out.check = out.check || { command: 'pio run' };
  return out;
}

/** Pass / fail counts from common test runners' output, or null. */
function summarizeOutput(text) {
  const t = String(text || '');
  let m;
  const pass = /^# pass (\d+)/m.exec(t);
  const fail = /^# fail (\d+)/m.exec(t);
  if (pass || fail) return { passed: pass ? Number(pass[1]) : 0, failed: fail ? Number(fail[1]) : 0 };
  if ((m = /Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:\d+ todo, )?(\d+) passed/.exec(t))) return { passed: Number(m[2]), failed: Number(m[1] || 0) };
  if ((m = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/.exec(t))) return { passed: Number(m[2]), failed: Number(m[1] || 0) }; // vitest
  const py = /=+ (.*\b(?:passed|failed)\b.*) in [\d.]+s/.exec(t); // pytest
  if (py) {
    const n = (w) => { const x = new RegExp(`(\\d+) ${w}`).exec(py[1]); return x ? Number(x[1]) : 0; };
    return { passed: n('passed'), failed: n('failed') + n('error') };
  }
  if ((m = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(t))) return { passed: Number(m[1]), failed: Number(m[2]) }; // cargo
  return null;
}

/** First line that looks like the reason something failed. */
function firstError(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^# (fail|pass|skip|todo|cancelled) \d+/.test(line)) continue;
    if (/^not ok\b|\berror\b|✖|✗|AssertionError|FAILED|panicked|Traceback|SyntaxError|cannot find|failed to/i.test(line)) return line.slice(0, 300);
  }
  return '';
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', [...GIT_ID, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout || 20000,
    maxBuffer: 64 * 1024 * 1024,
    input: opts.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const nul = (s) => String(s || '').split('\0').filter(Boolean);

class ProjectTools {
  /** @param {{trash?: (absPath:string) => Promise<void>|void}} o — moves a file to the Recycle Bin */
  constructor({ trash } = {}) {
    this.trash = trash || ((p) => fs.rmSync(p, { force: true }));
    this.snapshots = []; // [{cwd, ref, index, head, untracked:Set, at}]
    this.child = null;
    this.gitCache = new Map();
  }

  /** The project changed: snapshots of the old one no longer apply. */
  reset() {
    this.snapshots = [];
  }

  get running() {
    return !!this.child;
  }

  isGitRepo(cwd) {
    if (!cwd) return false;
    if (!this.gitCache.has(cwd)) {
      let ok = false;
      try { ok = git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { /* no git / not a repo */ }
      this.gitCache.set(cwd, ok);
    }
    return this.gitCache.get(cwd);
  }

  // ---------------- run tests / checks ----------------

  /**
   * Run the project's test or check command.
   * @returns {Promise<{ok:boolean, kind:string, command:string, exitCode:number|null, durationMs:number, counts:object|null, error:string, tail:string, cancelled:boolean, timedOut:boolean}>}
   */
  run(kind, cwd, { onOutput } = {}) {
    if (this.child) return Promise.reject(new Error('กำลังรันอยู่แล้ว รอให้เสร็จหรือสั่งหยุดก่อน'));
    const found = detectChecks(cwd)[kind];
    if (!found) {
      return Promise.reject(new Error(kind === 'test'
        ? 'ไม่พบคำสั่งเทสต์ในโปรเจกต์นี้ (เช่น scripts.test ใน package.json)'
        : 'ไม่พบคำสั่งตรวจในโปรเจกต์นี้ (เช่น scripts.check / lint / build ใน package.json)'));
    }
    const { command } = found;
    const t0 = Date.now();
    return new Promise((resolve) => {
      const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } });
      this.child = child;
      let buf = '';
      let timedOut = false;
      const take = (d) => {
        const s = d.toString('utf8').replace(ANSI, '');
        buf += s;
        if (buf.length > 512 * 1024) buf = buf.slice(-256 * 1024);
        if (onOutput) onOutput(s);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = setTimeout(() => { timedOut = true; this.cancel(); }, RUN_TIMEOUT_MS);
      const done = (exitCode, spawnError) => {
        if (this.child !== child) return;
        clearTimeout(timer);
        this.child = null;
        const cancelled = !!child.jarvisCancelled;
        const tail = buf.split('\n').slice(-TAIL_LINES).join('\n').trim();
        const counts = summarizeOutput(buf);
        resolve({
          ok: !spawnError && !cancelled && exitCode === 0 && !(counts && counts.failed),
          kind,
          command,
          exitCode,
          durationMs: Date.now() - t0,
          counts,
          error: spawnError ? spawnError.message : exitCode === 0 ? '' : firstError(buf),
          tail,
          cancelled: cancelled && !timedOut,
          timedOut,
        });
      };
      child.on('error', (err) => done(null, err));
      child.on('close', (code) => done(code, null));
    });
  }

  /** Stop a running test/check (the whole process tree). */
  cancel() {
    const c = this.child;
    if (!c) return false;
    c.jarvisCancelled = true;
    if (process.platform === 'win32' && c.pid) {
      try { execFileSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already gone */ }
    } else {
      try { c.kill('SIGTERM'); } catch { /* already gone */ }
    }
    return true;
  }

  // ---------------- snapshots ----------------

  /** Save the working tree before a Claude turn. Returns false when it can't (not a repo, no commits, git error). */
  snapshot(cwd) {
    if (!this.isGitRepo(cwd)) return false;
    try {
      const head = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).trim();
      if (!head) return false;
      const stash = git(cwd, ['stash', 'create', 'jarvis snapshot']).trim();
      const ref = stash || head;
      const index = stash ? `${stash}^2` : head; // a stash commit's 2nd parent is the index
      const untracked = nul(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
      if (untracked.length > MAX_UNTRACKED) return false;
      const tree = git(cwd, ['rev-parse', `${ref}^{tree}`]).trim();
      const last = this.snapshots[this.snapshots.length - 1];
      // every stash commit gets a new hash: compare the saved trees instead
      if (last && last.cwd === cwd && last.tree === tree && sameSet(last.untracked, untracked)) return true; // nothing changed since
      this.snapshots.push({ cwd, ref, index, head, tree, untracked: new Set(untracked), at: Date.now() });
      if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
      return true;
    } catch {
      return false;
    }
  }

  /** What changed since a snapshot: {changed:[{status,file}], created:[file]}. */
  _changesSince(snap) {
    const cwd = snap.cwd;
    const parts = nul(git(cwd, ['diff', '--name-status', '--no-renames', '-z', snap.ref]));
    const changed = [];
    for (let i = 0; i + 1 < parts.length; i += 2) changed.push({ status: parts[i][0], file: parts[i + 1] });
    const created = nul(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).filter((f) => !snap.untracked.has(f));
    return { changed, created };
  }

  /** The newest snapshot something changed after, with its changes. */
  _target(cwd) {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const snap = this.snapshots[i];
      if (snap.cwd !== cwd) continue;
      const ch = this._changesSince(snap);
      if (ch.changed.length || ch.created.length) return { i, snap, ...ch };
    }
    return null;
  }

  // ---------------- diff ----------------

  /**
   * Changes of the latest Claude turn that changed something (or everything not committed).
   * @returns {{ok:true, scope:'turn'|'uncommitted', since:number|null, files:{file:string,add:number|null,del:number|null}[], created:string[], patch:string, truncated:boolean, add:number, del:number}}
   */
  diff(cwd) {
    if (!this.isGitRepo(cwd)) throw new Error('โฟลเดอร์นี้ไม่ใช่ git repository จึงดู diff ไม่ได้');
    const t = this._target(cwd);
    let base = t ? t.snap.ref : null;
    if (!base) {
      try { base = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).trim(); } catch { base = ''; }
    }
    if (!base) throw new Error('repo นี้ยังไม่มี commit แรก จึงยังเทียบ diff ไม่ได้');
    const files = git(cwd, ['diff', '--numstat', '--no-renames', base]).split('\n').filter(Boolean).map((l) => {
      const [a, d, ...rest] = l.split('\t');
      return { file: rest.join('\t'), add: a === '-' ? null : Number(a), del: d === '-' ? null : Number(d) };
    });
    const created = t ? t.created : nul(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
    let patch = git(cwd, ['diff', '--no-color', '--no-renames', base]);
    const truncated = patch.length > MAX_PATCH;
    if (truncated) patch = patch.slice(0, MAX_PATCH);
    const sum = (k) => files.reduce((n, f) => n + (f[k] || 0), 0);
    // token only for a turn: per-file undo (undo(cwd, token, files)) needs a snapshot to go back to
    return { ok: true, scope: t ? 'turn' : 'uncommitted', token: t ? `${t.i}:${t.snap.ref}` : null, since: t ? t.snap.at : null, files, created, patch, patches: splitPatch(patch), truncated, add: sum('add'), del: sum('del') };
  }

  // ---------------- undo ----------------

  /** What "ยกเลิกการแก้ล่าสุด" would do, without doing it. `files` limits it to those paths. */
  undoPreview(cwd, files) {
    if (!this.isGitRepo(cwd)) return { ok: false, reason: 'โฟลเดอร์นี้ไม่ใช่ git repository จึงย้อนการแก้ไม่ได้' };
    const t = this._target(cwd);
    if (!t) return { ok: false, reason: 'ไม่มีการแก้ไฟล์ให้ย้อน (JARVIS จำจุดย้อนกลับเฉพาะงานที่สั่งตั้งแต่เปิดโปรเจกต์นี้)' };
    let headMoved = false;
    try { headMoved = git(cwd, ['rev-parse', 'HEAD']).trim() !== t.snap.head; } catch { /* keep false */ }
    const only = Array.isArray(files) ? new Set(files) : null;
    const pick = (list) => (only ? list.filter((f) => only.has(f)) : list);
    const changed = t.changed.filter((c) => !only || only.has(c.file));
    const created = pick(t.created);
    if (only && !changed.length && !created.length) return { ok: false, reason: 'ไฟล์ที่เลือกไม่มีการแก้ให้ย้อนแล้ว' };
    return {
      ok: true,
      token: `${t.i}:${t.snap.ref}`,
      since: t.snap.at,
      restore: changed.filter((c) => c.status !== 'A').map((c) => c.file),
      added: changed.filter((c) => c.status === 'A').map((c) => c.file), // new and already staged
      remove: [...changed.filter((c) => c.status === 'A').map((c) => c.file), ...created],
      headMoved,
    };
  }

  /**
   * Undo, for the preview the user confirmed (token). Restores changed files
   * (working tree and staging) and moves created files to the Recycle Bin.
   * `files` undoes only those paths; the snapshot stays for the rest.
   */
  async undo(cwd, token, files) {
    const p = this.undoPreview(cwd, files);
    if (!p.ok) return p;
    if (p.token !== token) return { ok: false, reason: 'ไฟล์เปลี่ยนไปหลังจากแสดงรายการ สั่งย้อนใหม่อีกครั้ง' };
    const i = Number(token.split(':')[0]);
    const snap = this.snapshots[i];
    // the state right now, in case the undo itself needs undoing
    let safety = '';
    try { safety = git(cwd, ['stash', 'create', 'jarvis before undo']).trim(); } catch { /* clean tree or git error */ }
    const paths = (list) => list.join('\0') + '\0';
    // staging back to how it was (unstages new files); only paths git knows, or restore refuses
    const tracked = [...p.restore, ...p.added];
    if (tracked.length) {
      git(cwd, ['--literal-pathspecs', 'restore', `--source=${snap.index}`, '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths(tracked) });
    }
    if (p.restore.length) {
      git(cwd, ['--literal-pathspecs', 'restore', `--source=${snap.ref}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths(p.restore) });
    }
    const failed = [];
    for (const f of p.remove) {
      const abs = path.resolve(cwd, f);
      if (!abs.startsWith(path.resolve(cwd) + path.sep)) continue;
      try {
        if (fs.existsSync(abs)) await this.trash(abs);
      } catch (err) {
        failed.push(`${f}: ${err.message}`);
      }
    }
    // a partial undo keeps the snapshot while other files still differ from it
    let rest = false;
    if (Array.isArray(files)) {
      try { const ch = this._changesSince(snap); rest = !!(ch.changed.length || ch.created.length); } catch { rest = true; }
    }
    if (!rest) this.snapshots = this.snapshots.slice(0, i);
    return { ok: true, restored: p.restore, removed: p.remove.filter((f) => !failed.some((x) => x.startsWith(f + ':'))), failed, safety, headMoved: p.headMoved };
  }
}

/** A `git diff` patch split per file: {path: that file's part}. */
function splitPatch(patch) {
  const out = {};
  for (const part of String(patch || '').split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    if (m) out[m[2]] = part.replace(/\n$/, '');
  }
  return out;
}

function sameSet(set, list) {
  return set.size === list.length && list.every((x) => set.has(x));
}

module.exports = { ProjectTools, detectChecks, summarizeOutput, firstError };
