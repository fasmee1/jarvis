'use strict';
// Sets up a folder's Claude environment without waiting for the user's first message: starts a
// throwaway CLI there, sends the local-only "/cost" (no model call, no cost) so it reports its
// init event, and returns the "/" command names it lists. The CLI only sends init after a turn.
// The folder may be untrusted, so the probe runs with a minimal CLI: only the user's own settings,
// no MCP servers, no tools and no permission wiring (project hooks / MCP never start from a probe).

const { spawn } = require('child_process');
const { StreamJsonParser } = require('./stream-parser');

const PROBE_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--setting-sources', 'user',
  '--strict-mcp-config',
  '--tools', '',
  '--permission-mode', 'default',
  '--no-session-persistence',
];

/**
 * @param {{resolveCommand: () => {command:string, prefixArgs:string[]}, cwd: string, env: object, timeoutMs?: number}} o
 * @returns {{promise: Promise<string[]|null>, cancel: () => void}} promise resolves null on failure / timeout
 */
function probeSlashCommands(o) {
  let proc = null;
  let finish = () => {};
  const promise = new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(null), o.timeoutMs || 20000);
    finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc && proc.exitCode === null) {
        if (process.platform === 'win32') {
          const k = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          k.on('error', () => { try { proc.kill(); } catch { /* gone */ } });
        } else {
          try { proc.kill('SIGKILL'); } catch { /* gone */ }
        }
      }
      resolve(value);
    };
    try {
      const { command, prefixArgs } = o.resolveCommand();
      proc = spawn(command, [...prefixArgs, ...PROBE_ARGS], {
        cwd: o.cwd,
        env: o.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      return finish(null);
    }
    const parser = new StreamJsonParser({
      onEvent: (ev) => {
        if (ev.type === 'system' && ev.subtype === 'init') {
          finish(Array.isArray(ev.slash_commands) ? ev.slash_commands.map(String) : null);
        }
      },
      onBadLine: () => {},
    });
    proc.stdout.on('data', (d) => parser.push(d));
    proc.on('error', () => finish(null));
    proc.on('exit', () => finish(null));
    proc.stdin.on('error', () => {});
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '/cost' }, parent_tool_use_id: null }) + '\n');
  });
  return { promise, cancel: () => finish(null) };
}

module.exports = { probeSlashCommands };
