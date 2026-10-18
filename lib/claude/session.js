'use strict';
// One Claude Code conversation. Primary mode keeps a single
// `claude -p --input-format stream-json` process alive and writes each user
// turn to its stdin. Fallback mode spawns a fresh process per turn with
// --resume <session_id>. User text is only ever sent through stdin.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { StreamJsonParser } = require('./stream-parser');

const NO_DATA_MS = 60_000;

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  if (process.platform === 'win32') {
    const k = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    k.on('error', () => {
      try { proc.kill(); } catch { /* gone */ }
    });
  } else {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

const LOGIN_RE = /(not logged in|please run \/login|invalid api key|authentication_error|oauth token|\/login)/i;

class ClaudeSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => {command:string, prefixArgs:string[]}} o.resolveCommand
   * @param {(resumeId:string|null) => string[]} o.buildArgs
   * @param {string} o.cwd
   * @param {object} o.env
   * @param {boolean} [o.persistent=true]
   * @param {string|null} [o.resumeId]
   */
  constructor(o) {
    super();
    this.o = o;
    this.persistent = o.persistent !== false;
    this.sessionId = o.resumeId || null;
    this.proc = null;
    this.turn = null;
    this.turnSeq = 0;
    this.stderrTail = '';
    this.sawInit = false;
    this.awaitingApproval = 0;
    this.watchdog = null;
    this.triedFallback = false;
  }

  get busy() {
    return !!this.turn;
  }

  _spawn() {
    const { command, prefixArgs } = this.o.resolveCommand();
    const args = [...prefixArgs, ...this.o.buildArgs(this.sessionId)];
    this.emit('spawn', { command, args });
    const proc = spawn(command, args, {
      cwd: this.o.cwd,
      env: this.o.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.proc = proc;
    this.sawInit = false;
    this.stderrTail = '';
    const parser = new StreamJsonParser({
      onEvent: (ev) => this._onEvent(ev),
      onBadLine: (line, err) => this.emit('bad-line', { line, error: err.message }),
    });
    proc.stdout.on('data', (d) => {
      if (this.turn) this.turn.lastData = Date.now();
      parser.push(d);
    });
    proc.stdout.on('end', () => parser.end());
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      if (this.turn) this.turn.lastData = Date.now();
      this.emit('stderr', d);
    });
    proc.stdin.on('error', (err) => this.emit('stderr', `[stdin] ${err.message}\n`));
    proc.on('error', (err) => {
      const code = err.code === 'ENOENT' ? 'CLAUDE_NOT_FOUND' : 'SPAWN_FAILED';
      this._fail(code, err.code === 'ENOENT' ? 'ไม่พบโปรแกรม claude' : `เปิด claude ไม่ได้: ${err.message}`);
    });
    proc.on('exit', (code, signal) => this._onExit(proc, code, signal));
    return proc;
  }

  /**
   * Start the CLI ahead of the first message so its startup (settings, plugins,
   * MCP servers) overlaps with the user speaking/typing. Persistent mode only.
   */
  warm() {
    if (!this.persistent || this.turn || (this.proc && this.proc.exitCode === null)) return false;
    try {
      this._spawn();
      return true;
    } catch (err) {
      this.emit('error-info', { code: err.code || 'SPAWN_FAILED', message: err.message });
      return false;
    }
  }

  /**
   * Send one user turn.
   * @param {string|object[]} content  text or Anthropic content blocks
   * @param {{t0?:number}} meta
   */
  send(content, meta = {}) {
    if (this.turn) throw Object.assign(new Error('ยังตอบรอบก่อนไม่เสร็จ'), { code: 'BUSY' });
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const isSlash = typeof content === 'string' && content.trim().startsWith('/');
    const msg = {
      type: 'user',
      message: { role: 'user', content: isSlash ? content.trim() : blocks },
      parent_tool_use_id: null,
      session_id: this.sessionId || undefined,
    };
    const now = Date.now();
    this.turn = {
      id: ++this.turnSeq,
      t0: meta.t0 || now,
      t1: null,
      t2: null,
      lastData: now,
      awaitingMs: 0,
      awaitStart: null,
      toolsOpen: new Set(),
      deltaMsgs: new Set(),
      curMsg: null,
      cancelled: false,
      msg,
    };
    const turn = this.turn;

    if (!this.proc || this.proc.exitCode !== null || !this.persistent) this._spawn();
    const proc = this.proc;
    proc.stdin.write(JSON.stringify(msg) + '\n', () => {
      turn.t1 = Date.now();
      this.emit('stdin-written', { turnId: turn.id, t1: turn.t1 });
    });
    if (!this.persistent) proc.stdin.end();
    this._startWatchdog();
    this.emit('turn-start', { turnId: turn.id, t0: turn.t0 });
    return turn.id;
  }

  setAwaitingApproval(on) {
    const t = this.turn;
    this.awaitingApproval = Math.max(0, this.awaitingApproval + (on ? 1 : -1));
    if (!t) return;
    if (on && this.awaitingApproval === 1) t.awaitStart = Date.now();
    if (!on && this.awaitingApproval === 0 && t.awaitStart) {
      t.awaitingMs += Date.now() - t.awaitStart;
      t.awaitStart = null;
      t.lastData = Date.now();
    }
  }

  /** Cancel the current answer and anything Claude is running (kills the process tree). */
  stop() {
    const t = this.turn;
    if (t) t.cancelled = true;
    const proc = this.proc;
    this.proc = null; // next send() respawns with --resume <session_id>
    killTree(proc);
    if (t) this._endTurn({ cancelled: true });
  }

  dispose() {
    this.stop();
    this.removeAllListeners();
  }

  _startWatchdog() {
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      const t = this.turn;
      if (!t) return clearInterval(this.watchdog);
      if (t.toolsOpen.size || this.awaitingApproval) {
        t.lastData = Date.now();
        return;
      }
      if (Date.now() - t.lastData > NO_DATA_MS) {
        this._fail('NO_DATA', 'Claude ไม่ส่งข้อมูลมาเกิน 60 วินาที จึงหยุดรอบนี้');
        this.stop();
      }
    }, 1000);
  }

  _endTurn(extra) {
    const t = this.turn;
    if (!t) return;
    this.turn = null;
    clearInterval(this.watchdog);
    this.awaitingApproval = 0;
    this.emit('turn-end', { turnId: t.id, ...extra });
  }

  _fail(code, message) {
    this.emit('error-info', { code, message, stderr: this.stderrTail.slice(-1500) });
    if (this.turn) this._endTurn({ error: code });
  }

  _onExit(proc, code, signal) {
    this.emit('exit', { code, signal });
    if (proc !== this.proc && this.proc !== null) return; // an old process we replaced
    if (this.proc === proc) this.proc = null;
    if (!this.turn || this.turn.cancelled) return;
    if (!this.sawInit && this.persistent && !this.triedFallback && /input-format|stream-json/i.test(this.stderrTail)) {
      // Persistent stream-json input not supported: switch to per-turn mode.
      this.triedFallback = true;
      this.persistent = false;
      this.emit('mode-fallback', { reason: this.stderrTail.slice(-500) });
      const turn = this.turn;
      const p = this._spawn();
      p.stdin.write(JSON.stringify(turn.msg) + '\n', () => { turn.t1 = Date.now(); });
      p.stdin.end();
      return;
    }
    if (LOGIN_RE.test(this.stderrTail)) return this._fail('NOT_LOGGED_IN', 'ยังไม่ได้ login Claude Code — เปิด terminal แล้วรัน claude จากนั้นพิมพ์ /login');
    this._fail('PROCESS_DIED', `Claude หยุดทำงานกลางทาง (exit ${code}${signal ? ' ' + signal : ''})`);
  }

  _onEvent(ev) {
    const t = this.turn;
    this.emit('raw', ev);
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.sawInit = true;
          if (ev.session_id) this.sessionId = ev.session_id;
          this.emit('init', ev);
        }
        return;
      case 'stream_event': {
        if (!t || ev.parent_tool_use_id) return;
        const e = ev.event || {};
        if (e.type === 'message_start' && e.message) t.curMsg = e.message.id;
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) {
          if (t.curMsg) t.deltaMsgs.add(t.curMsg);
          if (!t.t2) {
            t.t2 = Date.now();
            this.emit('first-delta', { turnId: t.id, t2: t.t2 });
          }
          this.emit('text', { turnId: t.id, text: e.delta.text });
        }
        return;
      }
      case 'assistant': {
        const m = ev.message || {};
        for (const c of m.content || []) {
          if (c.type === 'tool_use') {
            if (t) t.toolsOpen.add(c.id);
            this.emit('tool-use', { id: c.id, name: c.name, input: c.input, parent: ev.parent_tool_use_id || null });
          } else if (c.type === 'text' && t && !ev.parent_tool_use_id && !t.deltaMsgs.has(m.id)) {
            // Partial messages were not streamed for this message: use the full text.
            if (!t.t2) {
              t.t2 = Date.now();
              this.emit('first-delta', { turnId: t.id, t2: t.t2 });
            }
            this.emit('text', { turnId: t.id, text: c.text });
          }
        }
        if (t && !ev.parent_tool_use_id && m.content && m.content.some((c) => c.type === 'text')) {
          this.emit('message-end', { turnId: t.id });
        }
        return;
      }
      case 'user': {
        const content = ev.message && ev.message.content;
        if (!Array.isArray(content)) return;
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          if (t) t.toolsOpen.delete(c.tool_use_id);
          const meta = (ev.tool_result_meta || []).find((x) => x.id === c.tool_use_id) || null;
          this.emit('tool-result', {
            id: c.tool_use_id,
            content: c.content,
            isError: !!c.is_error,
            meta,
            parent: ev.parent_tool_use_id || null,
          });
        }
        return;
      }
      case 'result': {
        if (ev.session_id) this.sessionId = ev.session_id;
        const latency = t
          ? { t0: t.t0, t1: t.t1, t2: t.t2, awaitingMs: t.awaitingMs }
          : null;
        this.emit('result', { ev, latency, turnId: t && t.id });
        if (ev.is_error && LOGIN_RE.test(String(ev.result || '') + JSON.stringify(ev.errors || ''))) {
          this.emit('error-info', { code: 'NOT_LOGGED_IN', message: 'ยังไม่ได้ login Claude Code — เปิด terminal แล้วรัน claude จากนั้นพิมพ์ /login' });
        }
        this._endTurn({ result: true });
        return;
      }
      default:
        return;
    }
  }
}

module.exports = { ClaudeSession, killTree };
