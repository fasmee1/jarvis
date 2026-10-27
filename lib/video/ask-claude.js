'use strict';
// One question to Claude, apart from the user's conversation, for the video editor.
// The CLI runs like the folder probe (lib/claude/probe.js): only the user's own
// settings, no MCP servers, no tools, nothing saved — so text from a clip can never
// make it act on the computer. Resolves the final answer text.

const { spawn } = require('child_process');
const { StreamJsonParser } = require('../claude/stream-parser');

const ASK_ARGS = [
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

class AskError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** The args after the CLI command: ASK_ARGS + system prompt + model. */
function buildAskArgs({ system = '', model = '', webTools = false } = {}) {
  const args = [...ASK_ARGS];
  if (webTools) {
    // read-only web access and nothing else: no files, no shell, no MCP
    const i = args.indexOf('--tools');
    args.splice(i, 2, '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch');
  }
  if (system) args.push('--append-system-prompt', system);
  if (model) args.push('--model', model);
  return args;
}

/**
 * o.resolveCommand() → { command, prefixArgs } · o.cwd · o.env · o.prompt · o.system · o.model
 * o.webTools: also allow WebSearch and WebFetch (and nothing else).
 * o.signal cancels (AskError ABORTED) · o.timeoutMs (default 3 min) · o.onText(chars so far) for progress.
 */
function askClaude(o) {
  return new Promise((resolve, reject) => {
    let proc = null;
    let done = false;
    let chars = 0;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      if (proc && proc.exitCode === null) {
        if (process.platform === 'win32' && proc.pid) {
          const k = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          k.on('error', () => { try { proc.kill(); } catch { /* gone */ } });
        } else {
          try { proc.kill('SIGKILL'); } catch { /* gone */ }
        }
      }
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => finish(new AskError('ยกเลิกแล้ว', 'ABORTED'));
    const timer = setTimeout(() => finish(new AskError('JARVIS ใช้เวลาคิดนานเกินไป', 'TIMEOUT')), o.timeoutMs || 180000);
    if (o.signal) {
      if (o.signal.aborted) return onAbort();
      o.signal.addEventListener('abort', onAbort, { once: true });
    }
    let stderr = '';
    try {
      const { command, prefixArgs = [] } = o.resolveCommand();
      proc = spawn(command, [...prefixArgs, ...buildAskArgs(o)], { cwd: o.cwd, env: o.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return finish(new AskError(`เปิด Claude Code ไม่ได้: ${err.message}`, 'SPAWN'));
    }
    const parser = new StreamJsonParser({
      onEvent: (ev) => {
        if (ev.type === 'stream_event' && ev.event && ev.event.delta && typeof ev.event.delta.text === 'string') {
          chars += ev.event.delta.text.length;
          if (o.onText) { try { o.onText(chars); } catch { /* progress only */ } }
        }
        if (ev.type === 'result') {
          if (ev.is_error || typeof ev.result !== 'string') finish(new AskError(`Claude ตอบไม่สำเร็จ${ev.result ? `: ${String(ev.result).slice(0, 200)}` : ''}`, 'RESULT'));
          else finish(null, ev.result);
        }
      },
      onBadLine: () => {},
    });
    proc.stdout.on('data', (d) => parser.push(d));
    proc.stdout.on('end', () => parser.end()); // a last line without a newline
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.on('error', (err) => finish(new AskError(`เปิด Claude Code ไม่ได้: ${err.message}`, 'SPAWN')));
    proc.on('close', (code) => finish(new AskError(`Claude Code ปิดไปก่อนตอบ (exit ${code}) ${stderr.trim().split(/\r?\n/).pop() || ''}`.trim(), 'EXIT')));
    proc.stdin.on('error', () => {});
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: o.prompt }, parent_tool_use_id: null }) + '\n');
    proc.stdin.end();
  });
}

module.exports = { askClaude, buildAskArgs, AskError, ASK_ARGS };
