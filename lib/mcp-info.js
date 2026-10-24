'use strict';
// Which MCP servers a project can use, for the "/mcp" view. Names and transport only: a server's
// command, args, env and URL can hold tokens, so they are never read out of the config files.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILE = 2 * 1024 * 1024;
const MAX_SERVERS = 100;

function readJson(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function listServers(obj, source) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.entries(obj).slice(0, MAX_SERVERS).map(([name, def]) => {
    const t = def && typeof def === 'object' ? def.type : '';
    return { name: String(name).slice(0, 100), source, transport: ['stdio', 'http', 'sse'].includes(t) ? t : def && def.url ? 'http' : 'stdio' };
  });
}

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

/**
 * Servers declared for `cwd`: user (~/.claude.json), this project's entry there, the project's .mcp.json,
 * and the extra --mcp-config files from Settings. Later sources do not hide earlier ones with the same name.
 * @returns {{name:string, source:'user'|'local'|'project'|'settings', transport:string}[]}
 */
function declaredServers({ cwd, home = os.homedir(), extraPaths = [] } = {}) {
  const out = [];
  const user = readJson(path.join(home, '.claude.json'));
  if (user) {
    out.push(...listServers(user.mcpServers, 'user'));
    if (cwd && user.projects && typeof user.projects === 'object') {
      const key = Object.keys(user.projects).find((k) => norm(k) === norm(cwd));
      if (key && user.projects[key]) out.push(...listServers(user.projects[key].mcpServers, 'local'));
    }
  }
  if (cwd) {
    const proj = readJson(path.join(cwd, '.mcp.json'));
    if (proj) out.push(...listServers(proj.mcpServers, 'project'));
  }
  for (const f of extraPaths) {
    const j = typeof f === 'string' ? readJson(f) : null;
    if (j) out.push(...listServers(j.mcpServers, 'settings'));
  }
  return out;
}

/**
 * Declared servers joined with the status the last init event reported.
 * status: 'connected' | 'failed' | 'pending' | … from Claude, or null when no session has reported yet.
 */
function mcpOverview({ declared, live }) {
  const status = new Map((live || []).map((s) => [String(s.name), String(s.status || '')]));
  const seen = new Set();
  const servers = [];
  for (const d of declared) {
    const key = `${d.source}:${d.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    servers.push({ ...d, status: status.has(d.name) ? status.get(d.name) : null });
  }
  // reported by Claude but not declared in a file we read (plugins, built-in connectors)
  const names = new Set(declared.map((d) => d.name));
  for (const [name, st] of status) {
    if (name === 'jarvis' || names.has(name)) continue; // "jarvis" is JARVIS's own permission server
    servers.push({ name: name.slice(0, 100), source: 'other', transport: '', status: st });
  }
  return servers;
}

module.exports = { declaredServers, mcpOverview };
