'use strict';
// Finds the Claude Code skills and slash commands the user can call with "/name":
// personal (~/.claude/skills, ~/.claude/commands), project (<cwd>/.claude/...) and
// enabled plugins (named "plugin:skill"). Read straight from disk so the "/" menu
// works before the first message (Claude's own list only arrives with its init event).
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DESC = 300;

/** Minimal YAML front matter reader: top-level `key: value`, quoted, and `>` / `|` blocks. */
function parseFrontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    if (/^[>|][+-]?$/.test(val)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      val = val[0] === '>' ? block.join(' ') : block.join('\n');
    } else if (/^(["']).*\1$/.test(val)) {
      val = val.slice(1, -1);
    }
    out[kv[1]] = val.replace(/\s+/g, ' ').trim();
  }
  return out;
}

/** Text of the first non-heading line of a markdown body (description fallback). */
function firstLine(text) {
  const body = String(text || '').replace(/^﻿?---\r?\n[\s\S]*?\r?\n---/, '');
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return line || '';
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function clip(s) {
  s = String(s || '');
  return s.length > MAX_DESC ? s.slice(0, MAX_DESC - 1) + '…' : s;
}

/** skills/<name>/SKILL.md → entries. */
function scanSkills(dir, source, prefix = '') {
  const out = [];
  for (const d of listDir(dir)) {
    if (!d.isDirectory()) continue;
    const text = readText(path.join(dir, d.name, 'SKILL.md'));
    if (text == null) continue;
    const fm = parseFrontMatter(text);
    if (String(fm['user-invocable']).toLowerCase() === 'false') continue;
    out.push({ name: prefix + (fm.name || d.name), description: clip(fm.description || firstLine(text)), source, kind: 'skill' });
  }
  return out;
}

/** commands/**\/*.md → entries (sub-folders become "folder:name"). */
function scanCommands(dir, source, prefix = '', depth = 0) {
  const out = [];
  for (const d of listDir(dir)) {
    const full = path.join(dir, d.name);
    if (d.isDirectory() && depth < 2) out.push(...scanCommands(full, source, `${prefix}${d.name}:`, depth + 1));
    else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) {
      const text = readText(full);
      if (text == null) continue;
      const fm = parseFrontMatter(text);
      out.push({ name: prefix + d.name.slice(0, -3), description: clip(fm.description || firstLine(text)), source, kind: 'command' });
    }
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Installed plugins that are not switched off in settings.json. */
function enabledPlugins(claudeDir) {
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const settings = readJson(path.join(claudeDir, 'settings.json')) || {};
  const enabled = settings.enabledPlugins || {};
  const out = [];
  for (const [id, installs] of Object.entries((installed && installed.plugins) || {})) {
    if (enabled[id] === false) continue;
    const inst = Array.isArray(installs) ? installs[0] : installs;
    if (!inst || !inst.installPath) continue;
    out.push({ name: id.split('@')[0], dir: inst.installPath });
  }
  return out;
}

/**
 * @param {{home?: string, cwd?: string}} o
 * @returns {{name: string, description: string, source: string, kind: string}[]} sorted by name, unique
 */
function listSkills({ home = os.homedir(), cwd = '' } = {}) {
  const claudeDir = path.join(home, '.claude');
  const all = [];
  if (cwd) {
    all.push(...scanSkills(path.join(cwd, '.claude', 'skills'), 'project'));
    all.push(...scanCommands(path.join(cwd, '.claude', 'commands'), 'project'));
  }
  all.push(...scanSkills(path.join(claudeDir, 'skills'), 'user'));
  all.push(...scanCommands(path.join(claudeDir, 'commands'), 'user'));
  for (const p of enabledPlugins(claudeDir)) {
    all.push(...scanSkills(path.join(p.dir, 'skills'), 'plugin', `${p.name}:`));
    all.push(...scanCommands(path.join(p.dir, 'commands'), 'plugin', `${p.name}:`));
  }
  const seen = new Map();
  for (const s of all) if (!seen.has(s.name.toLowerCase())) seen.set(s.name.toLowerCase(), s); // project wins over user
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listSkills, parseFrontMatter };
