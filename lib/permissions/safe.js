'use strict';
// "Safe" actions JARVIS approves by itself (setting autoApproveSafe), so the user
// is only asked about things that can do real damage. Anything this file does
// not recognise still asks, and the guard hook (lib/hooks/guard.js) runs first
// and blocks / always-asks its patterns regardless of this.
//
// Safe =
//  - read-only tools, and reading files inside the project / attached paths
//  - creating and editing files inside the project or an attached folder
//    (not .git internals, not .claude/ settings — that would let it grant itself permissions)
//  - shell commands made only of known-safe pieces: looking around, git without
//    deleting / pushing / rewriting history, and project-local installs,
//    scaffolding, builds and tests (npm install, npx create-next-app, pip install, …)

const path = require('path');

const READ_ONLY_TOOLS = new Set(['Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'WebSearch', 'ToolSearch']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

/** p is root itself or inside it. */
function inside(p, root) {
  const a = norm(p);
  const r = norm(root);
  return a === r || a.startsWith(r + path.sep) || a.startsWith(r + '/');
}

// Secrets: never auto-approved (any tool), and refused as attachments.
const SENSITIVE = /(^|[\\/\s"'=~])\.(ssh|aws|azure|gnupg|kube|docker)([\\/\s"']|$)|\bid_(rsa|dsa|ecdsa|ed25519)\b|\.(pem|pfx|p12|key|kdbx)\b|(^|[\\/\s"'])\.env(\.[\w-]+)?([\s"']|$)|\.npmrc\b|\.git-credentials\b|\.netrc\b|\blogin data\b|\bcookies(\.sqlite)?\b|\bcredentials(\.json)?\b/i;

// Never auto-approve writes here, even inside the project.
const PROTECTED_WRITE = /[\\/](\.git|\.claude|\.jarvis)([\\/]|$)/i;

function pathIn(p, roots, cwd, { write = false } = {}) {
  if (!p || typeof p !== 'string') return false;
  const abs = path.resolve(cwd || '.', p);
  if (write && PROTECTED_WRITE.test(abs)) return false;
  return roots.some((r) => r && inside(abs, r));
}

// ---------------- shell commands ----------------

/**
 * Split a command line into pipeline/sequence segments, respecting quotes.
 * Returns null when it uses anything that could hide a second command or
 * write somewhere unexpected: $( ), ${ }, backticks, <( ), heredocs, newlines,
 * redirections (except 2>&1 and > /dev/null / nul / $null).
 */
function splitCommand(cmd) {
  if (/[\r\n`]|\$\(|\$\{|<\(|>\(|<</.test(cmd)) return null;
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '&' || ch === '|' || ch === ';') {
      if (ch === '&' && cur.endsWith('>')) { cur += ch; continue; } // 2>&1
      segs.push(cur);
      cur = '';
      if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  if (q) return null;
  segs.push(cur);
  const out = [];
  for (let s of segs) {
    s = ` ${s} `.replace(/\s\d?>&\d(?=\s)/g, ' ').replace(/\s\d?>>?\s*(\/dev\/null|\$null|nul)(?=\s)/gi, ' ');
    if (/[<>]/.test(s.replace(/"[^"]*"|'[^']*'/g, ''))) return null;
    s = s.trim();
    if (s) out.push(s);
  }
  return out.length ? out : null;
}

function words(seg) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Commands that only look at things (any arguments, any folder).
const LOOK = new Set([
  'ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'wc', 'echo', 'which', 'where', 'tree',
  'grep', 'rg', 'findstr', 'sort', 'uniq', 'diff', 'file', 'stat', 'du', 'df', 'date', 'whoami', 'hostname',
  'get-childitem', 'gci', 'get-content', 'gc', 'get-location', 'test-path', 'select-string', 'get-command',
  'resolve-path', 'measure-object', 'select-object', 'format-table', 'out-string', 'write-output', 'write-host',
]);
const CD = new Set(['cd', 'set-location', 'sl', 'chdir', 'pushd']);

const VERSION_ONLY = /^(-v|--version|-version|version|--help|-h|help)$/i;

// Scaffolders / project tools allowed through npx, bunx, pnpm dlx, npm exec.
const NPX_OK = new Set([
  'create-next-app', 'create-vite', 'create-react-app', 'create-astro', 'create-svelte', 'sv', 'create-remix', 'create-expo-app',
  'create-t3-app', 'nuxi', 'next', 'vite', 'astro', 'tsc', 'typescript', 'eslint', 'prettier', 'jest', 'vitest', 'playwright',
  'serve', 'http-server', 'live-server', 'tailwindcss', '@tailwindcss/cli', 'shadcn', 'shadcn-ui', 'prisma', 'expo', 'ts-node', 'tsx', 'nodemon',
]);
// create-next-app@latest → create-next-app; @tailwindcss/cli@4 → @tailwindcss/cli
const pkgName = (s) => String(s || '').toLowerCase().replace(/(.)@[^/@]*$/, '$1');

const GIT_OK = new Set(['status', 'log', 'diff', 'show', 'init', 'add', 'commit', 'rev-parse', 'ls-files', 'blame', 'fetch', 'stash', 'shortlog', 'describe', 'tag', 'remote', 'config', 'switch', 'checkout', 'branch', 'restore', 'clone']);

function gitOk(args) {
  const sub = (args[0] || '').toLowerCase();
  if (!sub || VERSION_ONLY.test(sub)) return true;
  if (!GIT_OK.has(sub)) return false; // push, reset, clean, rebase, rm, merge, … ask
  const rest = args.slice(1);
  const has = (...f) => rest.some((a) => f.includes(a));
  switch (sub) {
    case 'branch': return !has('-d', '-D', '--delete', '-m', '-M', '--move', '-f', '--force', '-c', '-C');
    case 'checkout': return has('-b') || (rest.length === 1 && !rest[0].startsWith('-') && rest[0] !== '.'); // new / other branch only
    case 'switch': return !has('--discard-changes', '-f', '--force', '-C');
    case 'restore': return has('--staged') && !has('--worktree', '-W');
    case 'stash': return !rest[0] || ['list', 'show', 'push', 'save'].includes(rest[0]);
    case 'tag': return !has('-d', '--delete', '-f', '--force');
    case 'remote': return !rest[0] || ['-v', 'show', 'get-url'].includes(rest[0]);
    case 'config': return has('--get', '--list', '-l', '--get-all') || rest.length <= 1;
    case 'commit': return !has('--amend', '--no-verify', '-n');
    default: return true;
  }
}

const PM_OK = new Set(['install', 'i', 'ci', 'add', 'test', 't', 'run', 'run-script', 'start', 'build', 'dev', 'init', 'create', 'ls', 'list', 'outdated', 'view', 'info', 'why', 'exec', 'dlx', 'lint', 'preview', 'remove', 'uninstall', 'rm', 'update', 'up', 'upgrade', 'audit']);

function pmOk(args) {
  const sub = (args[0] || '').toLowerCase();
  const rest = args.slice(1);
  if (args.some((a) => /^(-g|--global|--location=global)$/i.test(a))) return false; // global installs ask (guard too)
  if (!sub || VERSION_ONLY.test(sub)) return true;
  if (!PM_OK.has(sub)) return false; // publish, login, config set, … ask
  if (sub === 'audit') return !rest.includes('--force');
  if (sub === 'create' || sub === 'init') {
    const t = rest.find((a) => !a.startsWith('-'));
    return !t || NPX_OK.has(pkgName(t)) || NPX_OK.has('create-' + pkgName(t));
  }
  if (sub === 'exec' || sub === 'dlx') return npxOk(rest.filter((a) => a !== '--'));
  return true;
}

function npxOk(args) {
  const a = args.filter((x) => !/^(-y|--yes|--no-install|--quiet|-q)$/i.test(x));
  return !!a[0] && !a[0].startsWith('-') && NPX_OK.has(pkgName(a[0]));
}

function pipOk(args) {
  const sub = (args[0] || '').toLowerCase();
  return ['install', 'list', 'show', 'freeze', 'check', '--version', '-v'].includes(sub) && !args.some((x) => /^--(target|prefix|root)\b/i.test(x));
}

/** All non-flag arguments are paths inside writable folders. */
function pathsArgsOk(args, dirs, here) {
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-(itemtype|type)$/i.test(a)) { i++; continue; } // PowerShell: -ItemType Directory
    if (a.startsWith('-')) continue;
    targets.push(a);
  }
  return targets.length > 0 && targets.every((t) => pathIn(t, dirs, here, { write: true }));
}

/**
 * @param {string} seg one command
 * @param {{dirs:string[], readable:string[], here:string}} ctx
 */
function segmentOk(seg, ctx) {
  const w = words(seg);
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift(); // NODE_ENV=production npm run build
  if (!w.length) return false;
  const cmd = path.basename(w[0]).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  const args = w.slice(1);
  if (LOOK.has(cmd)) return true;
  if (cmd === 'find') return !args.some((a) => /^-(exec|execdir|delete|ok|fprint)/i.test(a));
  if (cmd === 'git' && (args[0] || '').toLowerCase() === 'clone') return true; // clones into the current folder
  // everything below changes things: only from inside the project / an attached folder
  const home = ctx.dirs.some((d) => inside(ctx.here, d));
  if (!home && !(args.length === 1 && VERSION_ONLY.test(args[0]))) return false;
  switch (cmd) {
    case 'git': return gitOk(args);
    case 'npm': case 'pnpm': case 'yarn': case 'bun': return pmOk(args);
    case 'npx': case 'bunx': return npxOk(args);
    case 'pip': case 'pip3': return pipOk(args);
    case 'python': case 'python3': case 'py': {
      if (!args.length || VERSION_ONLY.test(args[0])) return true;
      if (args[0] === '-m') {
        const mod = (args[1] || '').toLowerCase();
        if (mod === 'pip') return pipOk(args.slice(2));
        return ['venv', 'pytest', 'http.server', 'unittest'].includes(mod);
      }
      return !args[0].startsWith('-') && pathIn(args[0], ctx.dirs, ctx.here); // a script in the project
    }
    case 'node': case 'deno':
      if (!args.length || VERSION_ONLY.test(args[0])) return true;
      return !args[0].startsWith('-') && pathIn(args[0], ctx.dirs, ctx.here);
    case 'mkdir': case 'md': case 'touch': return pathsArgsOk(args, ctx.dirs, ctx.here);
    case 'new-item': return args.some((a) => /^directory$/i.test(a)) && pathsArgsOk(args, ctx.dirs, ctx.here);
    case 'tsc': case 'eslint': case 'prettier': case 'jest': case 'vitest': case 'next': case 'vite': case 'pytest': case 'code':
      return true;
    default:
      return false;
  }
}

/**
 * Every piece of the shell command is known-safe.
 * @param {{cwd:string, dirs?:string[]}} ctx dirs: writable folders (project + attached)
 */
function isSafeCommand(command, { cwd, dirs = [] } = {}) {
  if (SENSITIVE.test(String(command || ''))) return false;
  const segs = splitCommand(String(command || '').trim());
  if (!segs) return false;
  const ctx = { dirs: [cwd, ...dirs].filter(Boolean), here: cwd || process.cwd() };
  for (const s of segs) {
    const w = words(s);
    const c = (w[0] || '').toLowerCase();
    if (CD.has(c)) {
      const target = w.slice(1).find((a) => !a.startsWith('-'));
      if (target && target !== '~') ctx.here = path.resolve(ctx.here, target);
      else ctx.here = '/__home__';
      continue;
    }
    if (!segmentOk(s, ctx)) return false;
  }
  return true;
}

/**
 * @param {string} tool tool name
 * @param {object} input tool input
 * @param {{cwd:string, dirs?:string[], files?:string[]}} ctx
 *   dirs: attached folders (read + write); files: attached single files (read only)
 */
function isSafeAction(tool, input, { cwd, dirs = [], files = [] } = {}) {
  const i = input || {};
  const writable = [cwd, ...dirs].filter(Boolean);
  if (READ_ONLY_TOOLS.has(tool)) return !SENSITIVE.test(String(i.path || '') + ' ' + String(i.pattern || ''));
  const target = String(i.file_path || i.notebook_path || i.command || '');
  if (SENSITIVE.test(target)) return false;
  if (tool === 'Read') return pathIn(i.file_path, [...writable, ...files], cwd);
  if (WRITE_TOOLS.has(tool)) return pathIn(i.file_path || i.notebook_path, writable, cwd, { write: true });
  if (tool === 'Bash' || tool === 'PowerShell') return isSafeCommand(i.command, { cwd, dirs });
  return false;
}

// Places a dropped / added path may never be: system folders, a whole drive,
// the user's whole home folder, app data, secrets.
const SYSTEM_DIRS = /^[a-z]:[\\/](windows|program files( \(x86\))?|programdata|\$recycle\.bin|system volume information)([\\/]|$)/i;

/**
 * @param {string} p real (symlink-resolved) absolute path
 * @param {boolean} isDir
 * @param {string} home the user's home folder
 * @returns {string|null} why it is refused, or null when it is fine to attach
 */
function attachProblem(p, isDir, home) {
  const abs = path.resolve(p);
  if (path.parse(abs).root.replace(/[\\/]+$/, '').toLowerCase() === abs.replace(/[\\/]+$/, '').toLowerCase()) return 'ทั้งไดรฟ์';
  if (SYSTEM_DIRS.test(abs)) return 'โฟลเดอร์ระบบ';
  if (home && (norm(abs) === norm(home) || norm(abs) === norm(path.dirname(home)))) return 'โฟลเดอร์ผู้ใช้ทั้งหมด';
  if (home && inside(abs, path.join(home, 'AppData'))) return 'โฟลเดอร์ข้อมูลโปรแกรม (AppData)';
  if (SENSITIVE.test(abs)) return 'อาจมีรหัสผ่านหรือกุญแจลับ';
  if (!isDir && /\.(exe|msi|bat|cmd|ps1|vbs|scr|lnk)$/i.test(abs)) return 'ไฟล์โปรแกรม';
  return null;
}

module.exports = { isSafeAction, isSafeCommand, splitCommand, inside, attachProblem, SENSITIVE };
