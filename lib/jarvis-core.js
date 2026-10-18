'use strict';
// Main-process brain of Mee JARVIS. Owns the Claude session, the permission
// broker, the block/TTS pipeline and the audit log. Talks to the UI only via
// `ui(channel, payload)` so it can be tested without Electron.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { ClaudeSession } = require('./claude/session');
const { buildClaudeArgs } = require('./claude/args');
const { resolveClaudeCommand, which } = require('./claude/resolve');
const { PermissionBroker } = require('./permission-mcp/broker');
const { ruleFor, addAllowRule } = require('./permissions/rules');
const { BlockExtractor } = require('./blocks/extractor');
const { SpeechSegmenter } = require('./tts/segmenter');
const { cleanForSpeech } = require('./tts/clean');
const { AuditLog } = require('./audit');
const { lineDiff } = require('./diff');
const { buildSystemPrompt, TEACH_MODE_PROMPT } = require('./prompt');

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_WARN_COUNT = 10;
// Commands that only make sense in the interactive terminal UI.
const INTERACTIVE_ONLY = new Set(['login', 'logout', 'config', 'permissions', 'resume', 'doctor', 'ide', 'vim', 'terminal-setup', 'theme', 'exit', 'quit', 'status', 'mcp', 'agents', 'hooks', 'plugin', 'plugins', 'model', 'rewind', 'export']);

function short(s, n = 160) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function toolSummary(name, input = {}) {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `กำลังรัน ${name}: ${short(input.command, 200)}`;
    case 'Read':
      return `อ่านไฟล์ ${input.file_path}`;
    case 'Write':
      return `เขียนไฟล์ ${input.file_path}`;
    case 'Edit':
    case 'MultiEdit':
      return `แก้ไฟล์ ${input.file_path}`;
    case 'NotebookEdit':
      return `แก้ notebook ${input.notebook_path}`;
    case 'Glob':
      return `ค้นไฟล์ ${input.pattern}`;
    case 'Grep':
      return `ค้นข้อความ "${short(input.pattern, 60)}"`;
    case 'WebSearch':
      return `ค้นเว็บ: ${short(input.query, 100)}`;
    case 'WebFetch':
      return `เปิดเว็บ ${input.url}`;
    case 'Task':
    case 'Agent':
      return `ส่งงานให้ subagent: ${short(input.description || input.prompt, 100)}`;
    case 'TodoWrite':
      return 'อัปเดตรายการงาน';
    default:
      return `ใช้เครื่องมือ ${name}`;
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

/** Diff preview for file-changing tool calls shown in the approval dialog. */
function previewFor(toolName, input = {}) {
  try {
    if (toolName === 'Edit') return { file: input.file_path, diff: lineDiff(input.old_string, input.new_string) };
    if (toolName === 'MultiEdit') {
      return {
        file: input.file_path,
        diff: (input.edits || []).flatMap((e, i) => [{ op: '@', line: `แก้ไขที่ ${i + 1}` }, ...lineDiff(e.old_string, e.new_string)]),
      };
    }
    if (toolName === 'Write') {
      let old = '';
      try {
        const st = fs.statSync(input.file_path);
        if (st.size < 512 * 1024) old = fs.readFileSync(input.file_path, 'utf8');
      } catch { /* new file */ }
      return { file: input.file_path, isNew: !old, diff: lineDiff(old, input.content) };
    }
  } catch { /* preview is best effort */ }
  return null;
}

function nodeCommand() {
  const node = which('node', process.env, process.platform === 'win32' ? ['.exe'] : ['']);
  if (node) return { command: node, env: {} };
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

class JarvisCore {
  constructor({ settings, tempDir, ui, appRoot, logDir }) {
    this.settings = settings;
    this.tempDir = tempDir;
    this.ui = ui;
    this.appRoot = appRoot;
    this.logDir = logDir;
    this.session = null;
    this.resumeId = null;
    this.cwd = '';
    this.audit = new AuditLog(null);
    this.pending = new Map(); // approval id -> {req, resolve}
    this.sessionRules = new Set();
    this.state = 'STANDBY';
    this.imageCount = 0;
    this.teachMode = false;
    this.teachModeDirty = false;
    this.pendingContext = '';
    this.slashCommands = null;
    this.summaryRequest = null;
    this.toolNames = new Map();
    this.tag = crypto.randomBytes(6).toString('hex');
  }

  async init() {
    this.broker = new PermissionBroker({
      onRequest: (req) => this._onPermissionRequest(req),
      timeoutSec: this.settings.get().approvalTimeoutSec,
    });
    this.broker.onSettled = (req, decision, why) => this._onApprovalSettledExternally(req, decision, why);
    await this.broker.start();
    this.writeHelperFiles();
    const s = this.settings.get();
    const start = process.env.JARVIS_START_CWD || s.lastCwd;
    if (start && fs.existsSync(start)) this.setCwd(start, { silent: true });
  }

  // ---------- configuration files handed to the CLI ----------

  writeHelperFiles() {
    fs.mkdirSync(this.tempDir, { recursive: true });
    const node = nodeCommand();
    this.nodeCmd = node;
    this.mcpConfigFile = path.join(this.tempDir, `jarvis-mcp-${this.tag}.json`);
    const mcp = {
      mcpServers: {
        jarvis: {
          type: 'stdio',
          command: node.command,
          args: [path.join(this.appRoot, 'lib', 'permission-mcp', 'server.js')],
          env: {
            ...node.env,
            JARVIS_PIPE: this.broker.pipe,
            JARVIS_TOKEN: this.broker.token,
            JARVIS_APPROVAL_TIMEOUT_SEC: String(this.settings.get().approvalTimeoutSec),
          },
        },
      },
    };
    fs.writeFileSync(this.mcpConfigFile, JSON.stringify(mcp, null, 2), { encoding: 'utf8', mode: 0o600 });
    this.guardConfigFile = path.join(this.tempDir, `jarvis-guard-${this.tag}.json`);
    this.writeGuardConfig();
  }

  writeGuardConfig() {
    fs.writeFileSync(this.guardConfigFile, JSON.stringify(this.settings.guardConfig()), 'utf8');
  }

  cleanup() {
    if (this.session) this.session.dispose();
    for (const f of [this.mcpConfigFile, this.guardConfigFile]) {
      try { fs.unlinkSync(f); } catch { /* gone */ }
    }
    if (this.broker) this.broker.stop();
  }

  guardSettingsJson() {
    const fwd = (p) => p.replace(/\\/g, '/');
    const guard = fwd(path.join(this.appRoot, 'lib', 'hooks', 'guard.js'));
    return JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `"${fwd(this.nodeCmd.command)}" "${guard}"`,
                timeout: this.settings.get().approvalTimeoutSec + 30,
              },
            ],
          },
        ],
      },
    });
  }

  claudeEnv() {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, this.nodeCmd.env, {
      JARVIS_PIPE: this.broker.pipe,
      JARVIS_TOKEN: this.broker.token,
      JARVIS_GUARD_CONFIG: this.guardConfigFile,
      JARVIS_APPROVAL_TIMEOUT_SEC: String(this.settings.get().approvalTimeoutSec),
      MCP_TOOL_TIMEOUT: String((this.settings.get().approvalTimeoutSec + 60) * 1000),
    });
    return env;
  }

  argsFor(resumeId) {
    const s = this.settings.get();
    return buildClaudeArgs({
      appendSystemPrompt: buildSystemPrompt(),
      permissionMode: s.permissionMode,
      permissionPromptTool: 'mcp__jarvis__approve',
      mcpConfigs: [this.mcpConfigFile, ...s.mcpConfigPaths],
      settingsJson: this.guardSettingsJson(),
      addDirs: s.addDirs,
      model: s.model,
      resume: resumeId,
    });
  }

  // ---------- state ----------

  setState(state, extra) {
    this.state = state;
    this.ui('state', { state, ...extra });
  }

  snapshot() {
    const s = this.settings.get();
    return {
      state: this.state,
      cwd: this.cwd,
      permissionMode: s.permissionMode,
      sessionId: (this.session && this.session.sessionId) || this.resumeId,
      teachMode: this.teachMode,
      imageCount: this.imageCount,
      slashCommands: this.slashCommands,
    };
  }

  publish() {
    this.ui('app-state', this.snapshot());
  }

  setCwd(dir, { silent } = {}) {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('โฟลเดอร์ไม่ถูกต้อง');
    if (this.session && this.session.busy) throw new Error('รอให้ตอบรอบนี้เสร็จก่อนเปลี่ยนโฟลเดอร์');
    const changed = path.resolve(dir) !== path.resolve(this.cwd || '.');
    this.cwd = path.resolve(dir);
    this.audit = new AuditLog(this.cwd);
    this.settings.update({ lastCwd: this.cwd });
    if (changed) this.newSession({ silent: true });
    if (!silent) this.publish();
  }

  // ---------- session lifecycle ----------

  ensureSession() {
    if (this.session) return this.session;
    if (!this.cwd) {
      const e = new Error('ยังไม่ได้เลือกโฟลเดอร์โปรเจกต์ กดปุ่ม "เลือกโฟลเดอร์" ก่อน');
      e.code = 'NO_CWD';
      throw e;
    }
    const s = this.settings.get();
    const session = new ClaudeSession({
      resolveCommand: () => resolveClaudeCommand({ customPath: s.claudePath }),
      buildArgs: (resume) => this.argsFor(resume),
      cwd: this.cwd,
      env: this.claudeEnv(),
      persistent: s.persistentProcess,
      resumeId: this.resumeId,
    });
    this._wire(session);
    this.session = session;
    return session;
  }

  /** Pre-start the CLI so the first answer doesn't pay for its startup. */
  warm() {
    if (!this.cwd || !this.settings.get().persistentProcess) return;
    try {
      this.ensureSession().warm();
    } catch { /* reported when the user actually sends */ }
  }

  newSession({ silent } = {}) {
    if (this.session) this.session.dispose();
    this.session = null;
    this.resumeId = null;
    this.imageCount = 0;
    this.sessionRules.clear();
    this.slashCommands = null;
    this.teachModeDirty = this.teachMode;
    // bypassPermissions never survives into a new session.
    if (this.settings.get().permissionMode === 'bypassPermissions') this.settings.setPermissionMode('default');
    this.setState('STANDBY');
    if (!silent) this.ui('session', { kind: 'new' });
    this.publish();
    setImmediate(() => this.warm());
  }

  /** Restart the CLI with --resume so a new permission mode / settings take effect. */
  restartKeepingContext() {
    if (!this.session) return;
    if (this.session.busy) throw new Error('รอให้ตอบรอบนี้เสร็จก่อน หรือกดหยุดก่อน');
    this.resumeId = this.session.sessionId || this.resumeId;
    this.session.dispose();
    this.session = null;
    setImmediate(() => this.warm());
  }

  setPermissionMode(mode, confirmText) {
    if (this.session && this.session.busy) return { ok: false, errors: ['รอให้ตอบรอบนี้เสร็จก่อน หรือกดหยุดก่อนเปลี่ยนโหมด'] };
    const r = this.settings.setPermissionMode(mode, confirmText);
    if (r.ok) {
      this.restartKeepingContext();
      if (mode === 'bypassPermissions' && !this.settings.get().confirmVoiceBeforeSend) {
        this.ui('notice', { level: 'warn', text: 'แนะนำให้เปิด "ยืนยันข้อความเสียงก่อนส่ง" ระหว่างอยู่ในโหมด bypassPermissions' });
      }
      this.publish();
    }
    return r;
  }

  onSettingsChanged(keys) {
    if (keys.some((k) => k.startsWith('guard'))) this.writeGuardConfig();
    if (keys.includes('approvalTimeoutSec')) this.broker.timeoutSec = this.settings.get().approvalTimeoutSec;
    const restartKeys = ['model', 'mcpConfigPaths', 'addDirs', 'claudePath', 'persistentProcess', 'approvalTimeoutSec'];
    if (keys.some((k) => restartKeys.includes(k)) && this.session && !this.session.busy) this.restartKeepingContext();
  }

  setTeachMode(on) {
    if (this.teachMode === !!on) return;
    this.teachMode = !!on;
    this.teachModeDirty = true;
    this.publish();
  }

  // ---------- sending ----------

  /**
   * @param {{text:string, images?:string[], t0?:number, source?:string}} msg
   */
  send(msg) {
    const text = String(msg.text || '').trim();
    const images = msg.images || [];
    if (!text && !images.length) throw new Error('ข้อความว่าง');
    const session = this.ensureSession();
    if (session.busy) throw Object.assign(new Error('JARVIS ยังตอบรอบก่อนไม่เสร็จ'), { code: 'BUSY' });

    if (text.startsWith('/') && !images.length) {
      const name = text.slice(1).split(/\s+/)[0].toLowerCase();
      const known = this.slashCommands;
      if (INTERACTIVE_ONLY.has(name) || (known && !known.includes(name))) {
        this.ui('notice', {
          level: 'warn',
          text: `คำสั่ง /${name} ใช้ไม่ได้ในโหมดเชื่อมต่อของ JARVIS — กด "เปิด Claude Code แบบ interactive" เพื่อใช้ใน terminal`,
          action: 'open-interactive',
        });
        return null;
      }
      return this._startTurn(text, msg, true);
    }

    const blocks = [];
    for (const dataUrl of images) {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
      if (!m) throw new Error('รูปแบบภาพไม่ถูกต้อง');
      if ((m[2].length * 3) / 4 > MAX_IMAGE_BYTES) throw new Error('ภาพใหญ่เกินไป');
      blocks.push({ type: 'image', source: { type: 'base64', media_type: `image/${m[1]}`, data: m[2] } });
    }
    let prefix = '';
    if (this.pendingContext) {
      prefix += `[บริบทจาก session ก่อนหน้า]\n${this.pendingContext}\n[จบบริบท]\n\n`;
      this.pendingContext = '';
    }
    if (this.teachModeDirty) {
      prefix += this.teachMode
        ? `[JARVIS: เปิดโหมดสอนประดิษฐ์ — ${TEACH_MODE_PROMPT}]\n`
        : '[JARVIS: ปิดโหมดสอนประดิษฐ์แล้ว กลับไปตอบตามปกติ]\n';
      this.teachModeDirty = false;
    }
    if (images.length) prefix += `[แนบภาพจากกล้อง ${images.length} ภาพ ณ ตอนที่ผู้ใช้ถาม]\n`;
    blocks.push({ type: 'text', text: prefix + (text || 'ดูภาพนี้ให้หน่อย') });
    this.imageCount += images.length;
    if (images.length && this.imageCount > IMAGE_WARN_COUNT) {
      this.ui('notice', {
        level: 'warn',
        text: `session นี้ส่งภาพไปแล้ว ${this.imageCount} ภาพ ทำให้ใช้ token มาก แนะนำ "เริ่ม session ใหม่จากสรุป"`,
        action: 'new-from-summary',
      });
    }
    return this._startTurn(blocks, msg, false);
  }

  _startTurn(content, msg, isSlash) {
    const session = this.session;
    this.turnPipe = this._makePipeline();
    this.setState('THINKING');
    const turnId = session.send(content, { t0: msg.t0 || Date.now() });
    this.ui('turn:start', { turnId, isSlash });
    return turnId;
  }

  _makePipeline() {
    const pipe = {};
    pipe.segmenter = new SpeechSegmenter((seg) => {
      const speak = cleanForSpeech(seg);
      if (speak) this.ui('tts:segment', { text: speak });
    });
    pipe.extractor = new BlockExtractor((item) => {
      this.ui('chat:item', item);
      if (item.type === 'text') pipe.segmenter.push(item.text);
      if (item.type === 'block-error') this.ui('terminal', { stream: 'block', text: `บล็อก jarvis-${item.kind} ผิดรูปแบบ: ${item.error}\n${item.raw.slice(0, 800)}` });
    });
    return pipe;
  }

  stop() {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'ผู้ใช้กดหยุด' });
      this.pending.delete(id);
      this.ui('approval:close', { id });
    }
    if (this.session) this.session.stop();
    this.ui('tts:stop', {});
    this.setState('STANDBY');
    setTimeout(() => this.warm(), 300);
  }

  newSessionFromSummary() {
    const session = this.session;
    if (!session || !session.sessionId) {
      this.newSession();
      return { ok: true, empty: true };
    }
    if (session.busy) return { ok: false, errors: ['รอให้ตอบเสร็จก่อน'] };
    this.summaryRequest = { sessionId: session.sessionId };
    this._startTurn(
      [{ type: 'text', text: 'สรุปความคืบหน้าของงานใน session นี้เพื่อใช้เป็นบริบทเริ่ม session ใหม่: เป้าหมาย สิ่งที่ทำเสร็จแล้ว ไฟล์ที่เกี่ยวข้อง ขั้นตอนถัดไป และข้อมูลสำคัญที่ต้องจำ ตอบเป็นข้อความล้วนไม่เกิน 300 คำ ไม่ต้องใช้เครื่องมือ' }],
      { t0: Date.now() },
      false
    );
    return { ok: true };
  }

  openInteractive() {
    if (!this.cwd) throw new Error('ยังไม่ได้เลือกโฟลเดอร์');
    const s = this.settings.get();
    const { command, prefixArgs } = resolveClaudeCommand({ customPath: s.claudePath });
    const sid = (this.session && this.session.sessionId) || this.resumeId;
    const args = [...prefixArgs, ...(sid ? ['--resume', sid] : [])];
    if (s.model) args.push('--model', s.model);
    // detached on Windows gives the child its own new console window.
    const env = this.claudeEnv();
    for (const k of ['JARVIS_PIPE', 'JARVIS_TOKEN', 'JARVIS_GUARD_CONFIG', 'ELECTRON_RUN_AS_NODE']) delete env[k];
    const child = spawn(command, args, { cwd: this.cwd, detached: true, stdio: 'ignore', shell: false, windowsHide: false, env });
    child.unref();
    return { ok: true, resumed: !!sid };
  }

  // ---------- session events ----------

  _wire(session) {
    session.on('spawn', ({ command, args }) => {
      const shown = args.map((a) => (a.length > 120 ? a.slice(0, 60) + '…' : a));
      this.ui('terminal', { stream: 'info', text: `spawn ${command} ${shown.join(' ')}` });
    });
    session.on('stderr', (d) => this.ui('terminal', { stream: 'stderr', text: d }));
    session.on('bad-line', ({ line, error }) => this.ui('terminal', { stream: 'bad', text: `บรรทัด JSON อ่านไม่ได้ (${error}): ${line.slice(0, 500)}` }));
    session.on('raw', (ev) => {
      if (ev.type === 'stream_event') return; // too chatty; deltas are shown in chat
      if (ev.type === 'system' && /^hook_/.test(ev.subtype || '')) {
        // Hooks from the user's own setup (e.g. plugin SessionStart hooks) can inject
        // pages of text; show a one-line summary instead of the raw payload.
        const name = ev.hook_name || ev.hook_event || 'hook';
        if (ev.subtype === 'hook_started') this.ui('terminal', { stream: 'info', text: `hook ${name} → เริ่ม` });
        else {
          const out = String(ev.output || ev.stdout || '');
          const code = ev.exit_code ?? ev.exitCode;
          this.ui('terminal', { stream: 'info', text: `hook ${name} → เสร็จ${code != null ? ` (exit ${code})` : ''}${out ? ` · output ${out.length.toLocaleString()} ตัวอักษร` : ''}` });
        }
        return;
      }
      this.ui('terminal', { stream: 'event', text: JSON.stringify(ev).slice(0, 2000) });
    });
    session.on('mode-fallback', ({ reason }) => this.ui('notice', { level: 'warn', text: 'โหมดเปิด process ค้างไว้ใช้ไม่ได้ เปลี่ยนเป็นเปิด claude ใหม่ทุกรอบ (--resume)', detail: reason }));
    session.on('init', (ev) => {
      this.slashCommands = ev.slash_commands || null;
      const servers = ev.mcp_servers || [];
      const mine = servers.find((x) => x.name === 'jarvis');
      if (!mine || mine.status !== 'connected') {
        this.ui('error', { code: 'PERMISSION_MCP', message: 'ระบบขออนุญาต (permission MCP) เชื่อมต่อไม่ได้ — คำขอใช้เครื่องมือจะถูกปฏิเสธทั้งหมด', detail: JSON.stringify(mine || null) });
      }
      const failed = servers.filter((x) => x.name !== 'jarvis' && x.status === 'failed');
      if (failed.length) this.ui('notice', { level: 'warn', text: `MCP ที่โหลดไม่ขึ้น: ${failed.map((f) => f.name).join(', ')}` });
      this.ui('session', { kind: 'init', sessionId: ev.session_id, model: ev.model, tools: (ev.tools || []).length, permissionMode: ev.permissionMode });
      this.publish();
    });
    session.on('first-delta', () => {
      this.setState('STREAMING');
      const t = session.turn;
      if (t) this.ui('latency', { t0: t.t0, t1: t.t1, t2: t.t2, awaitingMs: t.awaitingMs });
    });
    session.on('stdin-written', ({ t1 }) => this.ui('latency', { t1 }));
    session.on('text', ({ text }) => {
      if (this.state !== 'STREAMING' && this.state !== 'AWAITING_APPROVAL') this.setState('STREAMING');
      if (this.turnPipe) this.turnPipe.extractor.push(text);
    });
    session.on('message-end', () => {
      if (!this.turnPipe) return;
      this.turnPipe.extractor.end();
      this.turnPipe.segmenter.flush();
      this.ui('tts:flush', {});
    });
    session.on('tool-use', ({ id, name, input, parent }) => {
      this.toolNames.set(id, { name, input });
      if (!parent) this.setState('TOOL_RUNNING', { tool: name });
      this.ui('activity', { kind: 'tool-use', id, name, parent, summary: toolSummary(name, input), input, preview: previewFor(name, input) });
      if (name === 'TodoWrite' && input && Array.isArray(input.todos)) this.ui('todos', input.todos);
      this.audit.write({ session: session.sessionId, tool: name, tool_use_id: id, input, decision: 'requested', source: parent ? 'subagent' : 'claude' });
    });
    session.on('tool-result', ({ id, content, isError, meta, parent }) => {
      const info = this.toolNames.get(id) || {};
      this.toolNames.delete(id);
      const decision = meta && meta.permission_decision ? meta.permission_decision.decision : null;
      this.ui('activity', { kind: 'tool-result', id, name: info.name, parent, isError, decision, text: resultText(content).slice(0, 4000) });
      this.audit.write({
        session: session.sessionId,
        tool: info.name || '?',
        tool_use_id: id,
        input: info.input,
        decision: isError && meta && meta.non_execution_kind ? 'denied' : decision || (isError ? 'error' : 'executed'),
        source: meta && meta.permission_decision ? meta.permission_decision.source : null,
      });
      if (!parent && this.state === 'TOOL_RUNNING') this.setState('THINKING');
    });
    session.on('result', ({ ev, latency }) => {
      if (this.turnPipe) {
        this.turnPipe.extractor.end();
        this.turnPipe.segmenter.flush();
        this.ui('tts:flush', {});
      }
      this.ui('turn:result', {
        isError: !!ev.is_error,
        subtype: ev.subtype,
        resultText: typeof ev.result === 'string' ? ev.result.slice(0, 2000) : '',
        costUsd: ev.total_cost_usd,
        usage: ev.usage,
        durationMs: ev.duration_ms,
        numTurns: ev.num_turns,
        denials: (ev.permission_denials || []).map((d) => ({ tool: d.tool_name, summary: toolSummary(d.tool_name, d.tool_input) })),
        latency,
      });
      if (this.summaryRequest) {
        const summary = typeof ev.result === 'string' ? ev.result : '';
        this.summaryRequest = null;
        if (summary && !ev.is_error) {
          setImmediate(() => {
            this.newSession({ silent: true });
            this.pendingContext = summary;
            this.ui('session', { kind: 'new-from-summary', summary });
          });
        }
      }
    });
    session.on('turn-end', ({ cancelled, error }) => {
      this.turnPipe = null;
      this.setState(error ? 'ERROR' : 'STANDBY', { cancelled: !!cancelled });
      this.publish();
    });
    session.on('error-info', (e) => this.ui('error', e));
  }

  // ---------- permissions ----------

  _onPermissionRequest(req) {
    const tool = req.tool_name;
    const input = req.input || {};
    // "Always allow" rules added this session apply immediately.
    const rule = ruleFor(tool, input, this.cwd || process.cwd());
    if (req.kind === 'permission' && rule && this.sessionRules.has(rule)) {
      this.audit.write({ session: this.session && this.session.sessionId, tool, tool_use_id: req.tool_use_id, input, decision: 'allow', source: 'jarvis-session-rule' });
      return { behavior: 'allow', updatedInput: input };
    }
    return new Promise((resolve) => {
      this.pending.set(req.id, { req, resolve, rule });
      if (this.session) this.session.setAwaitingApproval(true);
      this.prevState = this.state;
      this.setState('AWAITING_APPROVAL');
      this.ui('approval:request', {
        id: req.id,
        kind: req.kind,
        tool,
        summary: toolSummary(tool, input),
        input,
        preview: previewFor(tool, input),
        reason: req.reason || null,
        rule: req.kind === 'permission' ? rule : null,
        timeoutSec: this.broker.timeoutSec,
        createdAt: Date.now(),
      });
      this.ui('tts:announce', { text: `ขออนุญาต${tool === 'Bash' || tool === 'PowerShell' ? 'รันคำสั่ง' : 'ใช้ ' + tool} ดูบนจอครับ` });
    });
  }

  _finishApproval(id) {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    if (this.session) this.session.setAwaitingApproval(false);
    this.ui('approval:close', { id });
    if (!this.pending.size && this.state === 'AWAITING_APPROVAL') this.setState(this.session && this.session.busy ? 'TOOL_RUNNING' : 'STANDBY');
    return p;
  }

  _onApprovalSettledExternally(req, decision, why) {
    const p = this._finishApproval(req.id);
    if (!p) return;
    this.audit.write({ session: this.session && this.session.sessionId, tool: req.tool_name, tool_use_id: req.tool_use_id, input: req.input, decision: 'deny', source: why });
    if (why === 'timeout') this.ui('notice', { level: 'warn', text: `ไม่มีการตอบคำขอใช้ ${req.tool_name} ภายในเวลา จึงปฏิเสธอัตโนมัติ` });
  }

  /**
   * @param {{id:string, decision:'once'|'always'|'deny'|'deny-reason', reason?:string}} r
   */
  respondApproval(r) {
    const p = this._finishApproval(r.id);
    if (!p) return { ok: false, errors: ['คำขอนี้หมดอายุแล้ว'] };
    const { req, resolve, rule } = p;
    const base = { session: this.session && this.session.sessionId, tool: req.tool_name, tool_use_id: req.tool_use_id, input: req.input, source: 'user-hud' };
    if (r.decision === 'once' || r.decision === 'always') {
      let note;
      if (r.decision === 'always' && rule && req.kind === 'permission') {
        this.sessionRules.add(rule);
        try {
          const file = addAllowRule(this.cwd, rule);
          note = `บันทึก rule ${rule} ลง ${file}`;
          this.ui('notice', { level: 'info', text: note });
        } catch (err) {
          note = err.message;
          this.ui('notice', { level: 'error', text: err.message });
        }
      }
      this.audit.write({ ...base, decision: r.decision === 'always' ? 'allow-always' : 'allow-once', note });
      resolve({ behavior: 'allow', updatedInput: req.input });
    } else {
      const reason = r.decision === 'deny-reason' && r.reason ? String(r.reason).slice(0, 1000) : '';
      this.audit.write({ ...base, decision: 'deny', note: reason || undefined });
      resolve({ behavior: 'deny', message: reason ? `ผู้ใช้ปฏิเสธ เหตุผล: ${reason}` : 'ผู้ใช้ปฏิเสธคำขอนี้' });
    }
    return { ok: true };
  }
}

module.exports = { JarvisCore, toolSummary, previewFor, INTERACTIVE_ONLY };
