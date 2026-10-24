'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { declaredServers, mcpOverview } = require('../lib/mcp-info');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-')));

test('declaredServers reads names and transport from user, project-local, .mcp.json and Settings files, never secrets', () => {
  const home = tmp();
  const cwd = tmp();
  const extra = path.join(tmp(), 'extra.json');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { figma: { type: 'http', url: 'https://x/mcp?token=SECRET' } },
    projects: { [cwd.replace(/\\/g, '/')]: { mcpServers: { mine: { command: 'node', env: { KEY: 'SECRET' } } } }, other: { mcpServers: { nope: {} } } },
  }));
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { type: 'sse', url: 'https://y' } } }));
  fs.writeFileSync(extra, JSON.stringify({ mcpServers: { cfg: { command: 'x' } } }));
  const d = declaredServers({ cwd, home, extraPaths: [extra, path.join(home, 'missing.json'), 5] });
  assert.deepStrictEqual(d.map((x) => `${x.source}:${x.name}:${x.transport}`).sort(),
    ['local:mine:stdio', 'project:shared:sse', 'settings:cfg:stdio', 'user:figma:http']);
  assert.ok(!JSON.stringify(d).includes('SECRET'));
});

test('declaredServers survives missing or broken files', () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, '.claude.json'), '{ not json');
  assert.deepStrictEqual(declaredServers({ cwd: tmp(), home }), []);
  assert.deepStrictEqual(declaredServers({ home: tmp() }), []);
});

test("mcpOverview joins live status; undeclared live servers are listed, JARVIS's own is hidden", () => {
  const declared = [{ name: 'figma', source: 'user', transport: 'http' }, { name: 'idle', source: 'project', transport: 'stdio' }];
  const live = [{ name: 'figma', status: 'connected' }, { name: 'jarvis', status: 'connected' }, { name: 'plugin_x', status: 'failed' }];
  const o = mcpOverview({ declared, live });
  assert.deepStrictEqual(o.map((s) => [s.name, s.status]), [['figma', 'connected'], ['idle', null], ['plugin_x', 'failed']]);
  assert.strictEqual(mcpOverview({ declared, live: null })[0].status, null);
});
