'use strict';
// Find how to launch the Claude Code CLI on Windows without shell: true.
// Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980), so for an
// npm-installed claude.cmd we run its cli.js with the system node instead.

const fs = require('fs');
const path = require('path');

function pathDirs(env) {
  const p = env.PATH || env.Path || '';
  return p.split(path.delimiter).filter(Boolean);
}

function which(name, env = process.env, exts) {
  const list = exts || (process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']);
  for (const dir of pathDirs(env)) {
    for (const ext of list) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch { /* not here */ }
    }
  }
  return null;
}

// Locate cli.js for an npm global install next to claude.cmd.
function cliJsForCmd(cmdPath) {
  const dir = path.dirname(cmdPath);
  const candidates = [
    path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ];
  // Also parse the shim itself: npm shims reference "%dp0%\node_modules\...\cli.js".
  try {
    const shim = fs.readFileSync(cmdPath, 'utf8');
    const m = shim.match(/%~?dp0%?\\([^"\r\n]*?cli\.js)/i);
    if (m) candidates.unshift(path.join(dir, m[1]));
  } catch { /* ignore */ }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/**
 * @returns {{command: string, prefixArgs: string[], source: string}}
 * Throws an Error with code 'CLAUDE_NOT_FOUND' when nothing usable exists.
 */
function resolveClaudeCommand({ customPath = '', env = process.env } = {}) {
  const fromPath = (p, source) => {
    const ext = path.extname(p).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      const cli = cliJsForCmd(p);
      // Use node from PATH — never process.execPath, which is Electron.
      const node = which('node', env, process.platform === 'win32' ? ['.exe'] : ['']);
      if (!cli || !node) {
        const e = new Error(`พบ ${p} แต่หา cli.js หรือ node.exe ไม่เจอ`);
        e.code = 'CLAUDE_NOT_FOUND';
        throw e;
      }
      return { command: node, prefixArgs: [cli], source: source + ':cmd-shim' };
    }
    if (ext === '.js' || ext === '.mjs') {
      const node = which('node', env, process.platform === 'win32' ? ['.exe'] : ['']);
      if (!node) {
        const e = new Error('ไม่พบ node.exe ใน PATH');
        e.code = 'CLAUDE_NOT_FOUND';
        throw e;
      }
      return { command: node, prefixArgs: [p], source: source + ':js' };
    }
    return { command: p, prefixArgs: [], source };
  };

  if (customPath) {
    if (!fs.existsSync(customPath)) {
      const e = new Error(`ไม่พบไฟล์ claude ที่ตั้งไว้: ${customPath}`);
      e.code = 'CLAUDE_NOT_FOUND';
      throw e;
    }
    return fromPath(customPath, 'settings');
  }

  const found = which('claude', env);
  if (found) return fromPath(found, 'PATH');

  // Native installer default location.
  const home = env.USERPROFILE || env.HOME || '';
  const native = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (home && fs.existsSync(native)) return { command: native, prefixArgs: [], source: 'native-default' };

  const e = new Error('ไม่พบคำสั่ง claude ในเครื่อง ติดตั้ง Claude Code ก่อน หรือกำหนด path ใน Settings');
  e.code = 'CLAUDE_NOT_FOUND';
  throw e;
}

module.exports = { resolveClaudeCommand, which, cliJsForCmd };
