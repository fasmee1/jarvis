'use strict';
// Default safety-net patterns for the PreToolUse guard hook. These apply even
// in bypassPermissions. The user can disable the guard or edit the lists in
// Settings. Patterns are case-insensitive regular expressions matched against
// the shell command (Bash / PowerShell) or the target path (file tools).

const DEFAULT_BLOCK = [
  // Formatting / wiping disks
  String.raw`\bformat(\.com)?\s+[a-z]:`,
  String.raw`\bformat-volume\b`,
  String.raw`\bclear-disk\b`,
  String.raw`\bremove-partition\b`,
  String.raw`\bdiskpart\b`,
  String.raw`\bmkfs(\.\w+)?\s`,
  String.raw`\bdd\s+.*\bof=/dev/(sd|nvme|hd)`,
  // Deleting a whole drive, system folders or the user's home folder
  String.raw`\brm\s+(-\w*\s+)*-\w*r\w*\s+(-\w+\s+)*("|')?(/|~|\$HOME|/c|/mnt/c|[a-z]:[\\/]?)("|')?\s*($|[;&|])`,
  String.raw`\brm\s+(-\w*\s+)*-\w*r\w*\s+.*([a-z]:)?[\\/](windows|program files( \(x86\))?|programdata)([\\/]?["']?\s*($|[;&|]))`,
  String.raw`\b(rd|rmdir)\s+(/s\s+|/q\s+)+("|')?([a-z]:[\\/]?|%systemroot%|%userprofile%|[a-z]:\\(windows|users|program files[^"']*))("|')?\s*($|[;&|])`,
  String.raw`\bdel\s+(/[a-z]\s+)*("|')?[a-z]:\\?\*?(\.\*)?("|')?\s*($|[;&|])`,
  String.raw`\bremove-item\b.*-recurse.*("|'|\s)([a-z]:\\?|\$env:(systemroot|windir|userprofile)|[a-z]:\\(windows|users|program files[^"']*))("|')?\s*($|[;&|]|-)`,
  String.raw`\bremove-item\b.*("|'|\s)([a-z]:\\?|\$env:(systemroot|windir|userprofile)|[a-z]:\\(windows|users|program files[^"']*))("|')?\s.*-recurse`,
  // System registry / boot configuration
  String.raw`\breg(\.exe)?\s+(add|delete|import|restore|load|unload)\s+("|')?(hklm|hkey_local_machine|hkcr|hkey_classes_root)`,
  String.raw`\b(set|new|remove|rename)-item(property)?\b.*\b(hklm|hkey_local_machine):`,
  String.raw`\bbcdedit\b`,
  String.raw`\bvssadmin\s+delete\b`,
  String.raw`\bcipher\s+/w\b`,
];

const DEFAULT_ASK = [
  // Uploading firmware to a board
  String.raw`\barduino-cli(\.exe)?\b.*\bupload\b`,
  String.raw`\besptool(\.py|\.exe)?\b`,
  String.raw`\bavrdude\b`,
  String.raw`\b(pio|platformio)\b.*(-t|--target)\s+upload\b`,
  String.raw`\bmpremote\b.*\b(cp|fs|run|mip)\b`,
  // Anything needing admin rights / installers
  String.raw`-verb\s+runas\b`,
  String.raw`\brunas(\.exe)?\s`,
  String.raw`\bsudo\s`,
  String.raw`\bmsiexec\b`,
  String.raw`\b(winget|choco|scoop)\s+(install|upgrade|uninstall)\b`,
  String.raw`\binstall-(module|package)\b.*-scope\s+allusers`,
  String.raw`\bnpm\s+(i|install)\s+(-g|--global)\b`,
];

// Paths that file-writing tools must never touch.
const DEFAULT_BLOCK_PATHS = [
  String.raw`^[a-z]:[\\/]windows([\\/]|$)`,
  String.raw`^[a-z]:[\\/]program files( \(x86\))?([\\/]|$)`,
  String.raw`^[a-z]:[\\/]programdata[\\/]microsoft([\\/]|$)`,
];

function compile(list) {
  const out = [];
  for (const p of list || []) {
    try {
      out.push({ src: p, re: new RegExp(p, 'i') });
    } catch {
      /* invalid pattern: skipped, reported in Settings */
    }
  }
  return out;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * @returns {{action:'allow'|'block'|'ask', reason?:string, pattern?:string}}
 */
function evaluate(toolName, toolInput, cfg) {
  if (!cfg || cfg.enabled === false) return { action: 'allow' };
  const input = toolInput || {};
  if (SHELL_TOOLS.has(toolName)) {
    const cmd = String(input.command || '');
    for (const { src, re } of compile(cfg.block)) {
      if (re.test(cmd)) return { action: 'block', reason: 'คำสั่งนี้อยู่ในรายการอันตรายที่ JARVIS บล็อกไว้', pattern: src };
    }
    for (const { src, re } of compile(cfg.ask)) {
      if (re.test(cmd)) return { action: 'ask', reason: 'คำสั่งนี้ต้องยืนยันบนจอทุกครั้ง (อัปโหลดลงบอร์ด/ต้องใช้สิทธิ์ admin)', pattern: src };
    }
  }
  if (FILE_TOOLS.has(toolName)) {
    const p = String(input.file_path || input.notebook_path || '');
    for (const { src, re } of compile(cfg.blockPaths)) {
      if (re.test(p)) return { action: 'block', reason: 'ห้ามเขียนไฟล์ในโฟลเดอร์ระบบ', pattern: src };
    }
  }
  return { action: 'allow' };
}

// ---------- plan mode: nothing may change anything ----------

const PLAN_READONLY_CMDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'echo', 'which', 'where', 'stat', 'tree',
  'sort', 'uniq', 'cd', 'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'get-location', 'get-item', 'test-path', 'get-command',
]);
const PLAN_READONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'blame', 'branch', 'remote']);

function isReadOnlyShell(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return true;
  if (/`|\$\(|\$\{/.test(text)) return false;
  // any output redirection other than to the null device / stderr merge
  const stripped = text.replace(/\d?>&\d|\d?>>?\s*(\/dev\/null|\$null|nul)\b/gi, '');
  if (/>/.test(stripped)) return false;
  for (const seg of stripped.split(/&&|\|\||[;|&\r\n]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const head = words[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
    if (head === 'git') {
      const sub = words.slice(1).find((w) => !w.startsWith('-'));
      if (!sub || !PLAN_READONLY_GIT.has(sub.toLowerCase())) return false;
      if (sub.toLowerCase() === 'branch' && words.some((w) => /^-(d|D|m|M|c|C|-delete|-move|-copy)$/.test(w))) return false;
      if (sub.toLowerCase() === 'remote' && words.some((w) => /^(add|remove|rm|rename|set-url|prune)$/.test(w))) return false;
      continue;
    }
    if (!PLAN_READONLY_CMDS.has(head)) return false;
    if (head === 'find' && words.some((w) => /^-(delete|exec|execdir|ok|fprint\w*|fls)$/.test(w))) return false;
  }
  return true;
}

/**
 * Plan mode is strictly read-only. Returns a block verdict for anything that could change files, run
 * non-read-only commands, or call a third-party MCP tool that is not clearly a read; otherwise allow.
 * @returns {{action:'allow'|'block', reason?:string}}
 */
function evaluatePlan(toolName, toolInput) {
  const input = toolInput || {};
  const deny = (what) => ({ action: 'block', reason: `โหมดแพลน ห้ามแก้ไขใด ๆ (${what}) — ต้องให้ผู้ใช้อนุมัติแผนและออกจากโหมดแพลนก่อน` });
  if (FILE_TOOLS.has(toolName)) return deny(toolName);
  if (SHELL_TOOLS.has(toolName)) return isReadOnlyShell(input.command) ? { action: 'allow' } : deny('คำสั่งที่ไม่ใช่แบบอ่านอย่างเดียว');
  if (/^mcp__/.test(toolName) && !/^mcp__jarvis__/.test(toolName)) {
    const action = toolName.split('__').slice(2).join('__');
    if (!/^(get|list|read|search|fetch|query|find|whoami|view|analyze|describe|show)([_A-Z-]|$)/.test(action)) return deny('เครื่องมือ MCP ที่อาจเขียนข้อมูล');
  }
  return { action: 'allow' };
}

function defaultGuardConfig() {
  return { enabled: true, block: [...DEFAULT_BLOCK], ask: [...DEFAULT_ASK], blockPaths: [...DEFAULT_BLOCK_PATHS] };
}

module.exports = { evaluate, evaluatePlan, isReadOnlyShell, compile, defaultGuardConfig, DEFAULT_BLOCK, DEFAULT_ASK, DEFAULT_BLOCK_PATHS };
