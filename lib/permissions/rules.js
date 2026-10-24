'use strict';
// "Always allow" support: build a Claude Code permission rule for a tool call
// and append it to <project>/.claude/settings.local.json.

const fs = require('fs');
const path = require('path');

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function fileRule(tool, filePath, cwd) {
  if (!filePath) return tool;
  const rel = path.relative(cwd, filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `${tool}(./${toPosix(rel)})`;
  // Absolute paths use the // prefix in Claude Code rules.
  const abs = toPosix(path.resolve(filePath));
  return `${tool}(//${abs.replace(/^\/+/, '')})`;
}

/** Return the rule string for "always allow this", or null when not sensible. */
function ruleFor(toolName, input, cwd) {
  const i = input || {};
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const cmd = String(i.command || '').trim();
      if (!cmd || cmd.length > 500 || /[\r\n]/.test(cmd)) return null;
      return `${toolName}(${cmd})`;
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return fileRule('Edit', i.file_path, cwd);
    case 'NotebookEdit':
      return fileRule('Edit', i.notebook_path, cwd);
    case 'Read':
      return fileRule('Read', i.file_path, cwd);
    case 'WebFetch': {
      try {
        return `WebFetch(domain:${new URL(String(i.url)).hostname})`;
      } catch {
        return 'WebFetch';
      }
    }
    case 'ExitPlanMode':
      return null; // every plan is approved on its own: never "always allow"
    default:
      return /^[\w-]+$/.test(toolName) ? toolName : null;
  }
}

/** Matches a request against in-memory "always" rules added this session. */
function matchesRule(rule, toolName, input, cwd) {
  return ruleFor(toolName, input, cwd) === rule;
}

function addAllowRule(cwd, rule) {
  const dir = path.join(cwd, '.claude');
  const file = path.join(dir, 'settings.local.json');
  let json = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch (err) {
        throw new Error(`อ่าน ${file} ไม่ได้ (JSON เสีย) จึงไม่เขียนทับ: ${err.message}`);
      }
    }
  }
  if (typeof json !== 'object' || Array.isArray(json) || json === null) throw new Error(`${file} ไม่ใช่ object`);
  json.permissions = json.permissions && typeof json.permissions === 'object' ? json.permissions : {};
  const allow = Array.isArray(json.permissions.allow) ? json.permissions.allow : [];
  if (!allow.includes(rule)) allow.push(rule);
  json.permissions.allow = allow;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { ruleFor, matchesRule, addAllowRule };
