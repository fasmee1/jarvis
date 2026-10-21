'use strict';
// A private copy of a git repo for one background project (git worktree): Claude edits
// its own branch in a sibling folder, so the HUD's conversation and other tasks keep
// working in the original folder without touching each other's files.
// Never deletes work: a copy with changes or commits is kept and reported.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const TIMEOUT_MS = 30_000;
const RETRIES = 8;
const RETRY_MS = 500;
const BRANCH_RE = /^jarvis\/[A-Za-z0-9._-]{1,60}$/;

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr || err.message).trim().split('\n')[0] || 'git ล้มเหลว'), { code: err.code }));
      else resolve(String(stdout).trim());
    });
  });
}

/** Where the copies of `repo` live. */
const worktreeRoot = (repo) => path.join(path.dirname(path.resolve(repo)), path.basename(path.resolve(repo)) + '.jarvis-wt');

// real paths: git prints the long form, the caller may hold a short (8.3) or linked one
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const same = (a, b) => real(a).toLowerCase() === real(b).toLowerCase();

/**
 * Create `<repo's parent>/<repo>.jarvis-wt/<name>` on a new branch `jarvis/<name>` from HEAD.
 * @returns {Promise<{path:string, branch:string, baseSha:string}>}  throws Error with .code 'NOT_GIT' | 'GIT'
 */
async function createWorktree(repo) {
  let top;
  let baseSha;
  try {
    top = await git(repo, ['rev-parse', '--show-toplevel']);
    baseSha = await git(repo, ['rev-parse', '--verify', 'HEAD']);
  } catch (err) {
    throw Object.assign(new Error('โฟลเดอร์นี้ไม่ใช่ git repo หรือยังไม่มี commit — แยกสำเนาไม่ได้'), { code: 'NOT_GIT' });
  }
  if (!same(top, repo)) throw Object.assign(new Error(`ต้องเลือกโฟลเดอร์รากของ git repo (${top})`), { code: 'NOT_GIT' });
  const name = 't-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const branch = `jarvis/${name}`;
  const dir = path.join(worktreeRoot(repo), name);
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  } catch (err) {
    throw Object.assign(new Error(`สร้างสำเนาไม่สำเร็จ: ${err.message}`), { code: 'GIT' });
  }
  return { path: dir, branch, baseSha };
}

/**
 * Remove the copy when nothing was done in it (no changes, no commits); otherwise keep it.
 * @returns {Promise<{removed:boolean, reason?:string}>}
 */
async function removeWorktreeIfClean({ origin, path: dir, branch, baseSha }) {
  if (!BRANCH_RE.test(branch || '') || !fs.existsSync(origin)) return { removed: false, reason: 'ไม่พบ repo ต้นฉบับ' };
  if (!fs.existsSync(dir)) {
    try { await git(origin, ['worktree', 'prune']); await git(origin, ['branch', '-d', branch]); } catch { /* already gone */ }
    return { removed: true };
  }
  try {
    // JARVIS's own bookkeeping (.jarvis/audit.log) doesn't count; ignored files do (a build or node_modules is work)
    const dirty = (await git(dir, ['status', '--porcelain', '--ignored'])).split('\n').filter((l) => {
      const p = l.slice(3).replace(/^"/, '');
      return l.trim() && p !== '.jarvis/' && !p.startsWith('.jarvis/');
    }).join('\n');
    const head = await git(dir, ['rev-parse', 'HEAD']);
    if (dirty || head !== baseSha) return { removed: false, reason: dirty ? 'มีการแก้ไขที่ยังไม่ commit' : 'มี commit ใหม่' };
    // The project's Claude process may still be shutting down and hold the folder (Windows): try again for a few seconds.
    // --force only because we just checked there is nothing but .jarvis/ in it.
    for (let i = 0; ; i++) {
      try {
        await git(origin, ['worktree', 'remove', '--force', dir]);
        break;
      } catch (err) {
        if (i >= RETRIES) throw err;
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
    await git(origin, ['branch', '-d', branch]);
    return { removed: true };
  } catch (err) {
    return { removed: false, reason: err.message };
  }
}

module.exports = { createWorktree, removeWorktreeIfClean, worktreeRoot, BRANCH_RE };
