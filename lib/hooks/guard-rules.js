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

function defaultGuardConfig() {
  return { enabled: true, block: [...DEFAULT_BLOCK], ask: [...DEFAULT_ASK], blockPaths: [...DEFAULT_BLOCK_PATHS] };
}

module.exports = { evaluate, compile, defaultGuardConfig, DEFAULT_BLOCK, DEFAULT_ASK, DEFAULT_BLOCK_PATHS };
