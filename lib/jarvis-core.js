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
const { listSkills } = require('./skills');
const { PermissionBroker } = require('./permission-mcp/broker');
const { ruleFor, addAllowRule } = require('./permissions/rules');
const { isSafeAction, attachProblem, inside } = require('./permissions/safe');
const { BlockExtractor } = require('./blocks/extractor');
const { SpeechSegmenter } = require('./tts/segmenter');
const { cleanForSpeech } = require('./tts/clean');
const { AuditLog } = require('./audit');
const { lineDiff } = require('./diff');
const { buildSystemPrompt, TEACH_MODE_PROMPT, CODING_MODE_PROMPT, CODE_PROJECT_MARKERS } = require('./prompt');
const { ProjectTools, detectChecks } = require('./coding/project-tools');

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_WARN_COUNT = 10;
// Slash commands that review a git diff: with a non-git working folder they would only hit denied git calls.
const NEEDS_GIT_REPO = new Set(['code-review', 'review', 'simplify', 'security-review']);
// Commands that only make sense in the interactive terminal UI.
const INTERACTIVE_ONLY = new Set(['login', 'logout', 'config', 'permissions', 'resume', 'doctor', 'ide', 'vim', 'terminal-setup', 'theme', 'exit', 'quit', 'status', 'mcp', 'agents', 'hooks', 'plugin', 'plugins', 'model', 'rewind', 'export']);

// Spoken/typed names → --model alias. '' = whatever Claude Code defaults to.
const MODEL_ALIASES = [
  ['', /^(default|ค่าเริ่มต้น|ค่าปกติ|อัตโนมัติ|auto)$/i],
  ['opus', /^(opus|โอปุส|โอพัส|โอปัส|โอปุ๊ส)$/i],
  ['sonnet', /^(sonnet|ซอนเน็ต|ซอนเนต|ซอนเน็ท|ซอนเน็ด|ซอนเนท)$/i],
  ['haiku', /^(haiku|ไฮกุ|ไฮคุ|ไฮกู)$/i],
];
const MODEL_COMMAND = /^(?:\/model\s+|(?:ขอ)?(?:เปลี่ยน|สลับ|ใช้)\s*โมเดล\s*(?:เป็น|ไปใช้|ไป)?\s*)([^\s]+?)\s*(?:ครับ|ค่ะ|คะ|นะ|หน่อย)*[.!]?$/i;

const CODING_COMMAND = /^(เปิด|ปิด)\s*โหมด\s*(?:เขียน\s*)?(?:โค้ด|โค๊ด|โค็ด|code)\s*(?:ครับ|ค่ะ|คะ|นะ|หน่อย)*[.!]?$/i;

/** @returns {boolean|null} true/false for "เปิด/ปิดโหมดโค้ด", else null. */
function parseCodingModeCommand(text) {
  const m = CODING_COMMAND.exec(String(text || '').trim());
  return m ? m[1] === 'เปิด' : null;
}

/** 3725000 → "1 ชั่วโมง 2 นาที 5 วินาที", 65000 → "1 นาที 5 วินาที", 4000 → "4 วินาที" */
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h} ชั่วโมง`);
  if (h || m) parts.push(`${m} นาที`);
  parts.push(`${sec} วินาที`);
  return parts.join(' ');
}

/** The folder looks like a code project (has .git, package.json, …). */
function isCodeProject(dir) {
  return CODE_PROJECT_MARKERS.some((f) => fs.existsSync(path.join(dir, f)));
}

/** @returns {string|null} model alias for a "เปลี่ยนโมเดลเป็น …" / "/model …" command, else null. */
function parseModelCommand(text) {
  const m = MODEL_COMMAND.exec(String(text || '').trim());
  if (!m) return null;
  const hit = MODEL_ALIASES.find(([, re]) => re.test(m[1]));
  return hit ? hit[0] : null;
}

/** The project has a CLAUDE.md Claude Code loads by itself. */
function hasClaudeMd(dir) {
  return ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')].some((f) => fs.existsSync(path.join(dir, f)));
}

const tailLines = (s, n, max) => String(s || '').split('\n').slice(-n).join('\n').slice(-max);
const fileList = (a) => (a.length ? a.slice(0, 30).join(', ') + (a.length > 30 ? ` และอีก ${a.length - 30} ไฟล์` : '') : '-');

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
  /**
   * id / name / primary: one core per project folder (lib/projects.js). The primary core is
   * the conversation on the HUD; others run background tasks and never touch app-wide state
   * (lastCwd, the STT project hint, the permission mode).
   * resolveCommand: how to launch the CLI (tests pass a fake one).
   */
  constructor({ settings, memory, reminders, tempDir, ui, appRoot, logDir, onCwd, onRateLimit, onTurnEnd, trash, id = 'main', name = '', primary = true, resolveCommand, dirGuard }) {
    this.settings = settings;
    this.memory = memory || null; // MemoryStore shared by every project's core
    this.reminders = reminders || null; // ReminderStore shared by every project's core
    this.memorySeen = -1; // the memory version this conversation's Claude knows about
    this.id = id;
    this.name = name;
    this.primary = primary;
    this.resolveCommand = resolveCommand || null;
    // primary only: (dir) => error text when another project owns that folder
    this.dirGuard = dirGuard || (() => null);
    this.onCwd = onCwd || (() => {});
    this.onRateLimit = onRateLimit || (() => {});
    this.onTurnEnd = onTurnEnd || (() => {});
    this.tempDir = tempDir;
    // every payload carries the project id
    this.ui = (channel, payload) => ui(channel, { ...payload, projectId: this.id });
    this.appRoot = appRoot;
    this.logDir = logDir;
    this.session = null;
    this.resumeId = null;
    this.cwd = '';
    this.audit = new AuditLog(null);
    this.pending = new Map(); // approval id -> {req, resolve}
    this.sessionRules = new Set();
    this.approvalPolicy = null; // background projects: 'ask' = always ask, 'auto' = never ask; null = follow settings (main chat)
    this.state = 'STANDBY';
    this.imageCount = 0;
    this.teachMode = false;
    this.teachModeDirty = false;
    this.codingMode = false;
    this.codingModeDirty = false;
    this.folderChosen = false; // the user picked this conversation's folder (popup / folder button)
    this.attachedDirs = []; // dropped / added folders: --add-dir, readable + writable
    this.attachedFiles = []; // dropped / added files outside those: readable
    this.pendingAttach = []; // [{path, kind}] mentioned with the next message
    // coding mode: time spent building, per project (.jarvis/build-time.json)
    this.build = { totalMs: 0, tasks: 0 };
    this.buildTurnStart = null;
    this.pendingContext = '';
    // local test runs / undos the user did by voice, told to Claude with the next message
    this.codeNotes = [];
    this.tools = new ProjectTools({ trash });
    this.profileDirty = false;
    this.slashCommands = null;
    // Claude's own commands/skills (code-review, simplify, …) are not on disk: they only arrive with
    // its init event. The last list is kept in a file so the "/" menu has them before the first message.
    this.slashCache = this._readSlashCache();
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
    if (!this.primary) return; // lib/projects.js sets the folder
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
    this.disposed = true; // a warm() already scheduled must not start a CLI after this
    this._dropPendingApprovals('ปิดโปรเจกต์แล้ว');
    if (this.session) this.session.dispose(); // taskkill /T
    this.tools.cancel();
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

  /** Memory text for a new system prompt; marks this conversation as up to date with it. */
  _memoryText() {
    if (!this.memory) return '';
    this.memorySeen = this.memory.version;
    return this.memory.render();
  }

  argsFor(resumeId) {
    const s = this.settings.get();
    return buildClaudeArgs({
      appendSystemPrompt: buildSystemPrompt({ profile: s.userProfile, memory: resumeId ? '' : this._memoryText() }),
      // bypassPermissions is only ever for the conversation the user is watching
      permissionMode: !this.primary && s.permissionMode === 'bypassPermissions' ? 'default' : s.permissionMode,
      permissionPromptTool: 'mcp__jarvis__approve',
      mcpConfigs: [this.mcpConfigFile, ...s.mcpConfigPaths],
      settingsJson: this.guardSettingsJson(),
      addDirs: [...s.addDirs, ...this.attachedDirs],
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
      projectId: this.id,
      name: this.name,
      state: this.state,
      cwd: this.cwd,
      permissionMode: s.permissionMode,
      model: s.model,
      sessionId: (this.session && this.session.sessionId) || this.resumeId,
      teachMode: this.teachMode,
      codingMode: this.codingMode,
      isCodeProject: !!this.cwd && isCodeProject(this.cwd),
      hasClaudeMd: !!this.cwd && hasClaudeMd(this.cwd),
      checks: this.cwd ? detectChecks(this.cwd) : { test: null, check: null },
      attachments: this.pendingAttach,
      build: { ...this.build, runningSince: this.buildTurnStart },
      imageCount: this.imageCount,
      slashCommands: this.slashCommands,
    };
  }

  publish() {
    this.ui('app-state', this.snapshot());
  }

  /**
   * Everything "/" can call, for the input's slash menu: skills and commands on disk,
   * plus names Claude reported in its init event, plus JARVIS's own /model.
   */
  listCommands({ home } = {}) {
    const items = listSkills({ home, cwd: this.cwd });
    const have = new Set(items.map((x) => x.name.toLowerCase()));
    for (const name of this.slashCommands || this.slashCache || []) {
      const n = String(name);
      if (have.has(n.toLowerCase()) || INTERACTIVE_ONLY.has(n.toLowerCase())) continue;
      have.add(n.toLowerCase());
      items.push({ name: n, description: '', source: 'claude', kind: 'command' });
    }
    if (!have.has('model')) items.push({ name: 'model', description: 'เปลี่ยนโมเดล เช่น /model opus, /model sonnet, /model haiku, /model default', source: 'jarvis', kind: 'command' });
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  _slashCacheFile() {
    return this.logDir ? path.join(this.logDir, 'slash-commands.json') : null;
  }

  // The file maps project folder → command list, so one project's custom commands don't show up in another.
  _readSlashFile() {
    try {
      const all = JSON.parse(fs.readFileSync(this._slashCacheFile(), 'utf8'));
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    } catch {
      return {};
    }
  }

  _slashKey() {
    return this.cwd ? path.resolve(this.cwd).toLowerCase() : null;
  }

  _readSlashCache() {
    const key = this._slashKey();
    const list = key && this._slashCacheFile() ? this._readSlashFile()[key] : null;
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 500) : null;
  }

  _writeSlashCache(list) {
    const file = this._slashCacheFile();
    const key = this._slashKey();
    const same = Array.isArray(this.slashCache) && this.slashCache.length === list.length && this.slashCache.every((x, i) => x === list[i]);
    this.slashCache = list;
    if (same || !file || !key) return; // unchanged: no disk write on every session init
    try {
      const all = this._readSlashFile();
      delete all[key]; // re-added last, so the oldest projects are the ones dropped
      all[key] = list;
      for (const k of Object.keys(all).slice(0, -50)) delete all[k];
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, file); // atomic, so a crash can't leave truncated JSON
    } catch { /* best effort: the menu still works from the live list */ }
  }

  setCwd(dir, { silent } = {}) {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('โฟลเดอร์ไม่ถูกต้อง');
    if (this.session && this.session.busy) throw new Error('รอให้ตอบรอบนี้เสร็จก่อนเปลี่ยนโฟลเดอร์');
    const changed = path.resolve(dir) !== path.resolve(this.cwd || '.');
    if (changed && this.primary) {
      const why = this.dirGuard(path.resolve(dir));
      if (why) throw Object.assign(new Error(why), { code: 'FOLDER_IN_USE' });
    }
    const first = !this.cwd;
    this.cwd = path.resolve(dir);
    this.audit = new AuditLog(this.cwd);
    if (this.primary) this.settings.update({ lastCwd: this.cwd });
    if (changed || first) {
      this.codingMode = isCodeProject(this.cwd);
      this.codingModeDirty = this.codingMode;
      this.build = this.loadBuildTime();
      this.tools.reset();
      this.codeNotes = [];
      this.slashCache = this._readSlashCache();
    }
    if (this.primary) this.onCwd(this.cwd);
    if (changed) this.newSession({ silent: true });
    if (!silent) this.publish();
  }

  /** The user picked the folder for this conversation (popup / folder button): remembered until a new conversation. */
  chooseFolder(dir) {
    this.setCwd(dir);
    this.folderChosen = true;
    this.publish();
  }

  /** A git-based /command needs a project folder: picked in this conversation, or the current one is a git repo. */
  needsFolderPick(text) {
    const t = String(text || '');
    if (!t.startsWith('/') || !NEEDS_GIT_REPO.has(t.slice(1).split(/\s+/)[0].toLowerCase())) return false;
    if (this.folderChosen) return false;
    return !(this.cwd && fs.existsSync(path.join(this.cwd, '.git')));
  }

  /** Folders offered by the picker popup: the current one, attached ones and those added in Settings. */
  folderOptions() {
    const seen = new Set();
    const out = [];
    for (const p of [this.cwd, ...this.attachedDirs, ...this.settings.get().addDirs]) {
      if (!p) continue;
      const abs = path.resolve(p);
      const key = abs.toLowerCase();
      if (seen.has(key) || !fs.existsSync(abs)) continue;
      seen.add(key);
      out.push({ path: abs, git: fs.existsSync(path.join(abs, '.git')), current: !!this.cwd && key === path.resolve(this.cwd).toLowerCase() });
    }
    return out;
  }

  // ---------- session lifecycle ----------

  ensureSession() {
    if (this.session) return this.session;
    if (this.disposed) throw Object.assign(new Error('โปรเจกต์นี้ถูกปิดแล้ว'), { code: 'DISPOSED' });
    if (!this.cwd) {
      const e = new Error('ยังไม่ได้เลือกโฟลเดอร์โปรเจกต์ กดปุ่ม "เลือกโฟลเดอร์" ก่อน');
      e.code = 'NO_CWD';
      throw e;
    }
    const s = this.settings.get();
    const session = new ClaudeSession({
      resolveCommand: this.resolveCommand || (() => resolveClaudeCommand({ customPath: s.claudePath })),
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
    // background projects start the CLI only when they get a task
    if (this.disposed || !this.primary || !this.cwd || !this.settings.get().persistentProcess) return;
    try {
      this.ensureSession().warm();
    } catch { /* reported when the user actually sends */ }
  }

  newSession({ silent } = {}) {
    this._dropPendingApprovals('เริ่มเซสชันใหม่');
    if (this.session) this.session.dispose();
    this.session = null;
    this.resumeId = null;
    this.imageCount = 0;
    this.sessionRules.clear();
    this.folderChosen = false;
    this.slashCommands = null;
    this.teachModeDirty = this.teachMode;
    this.codingModeDirty = this.codingMode;
    this.profileDirty = false; // a new conversation gets the profile in its system prompt
    this.attachedDirs = [];
    this.attachedFiles = [];
    this.pendingAttach = [];
    // bypassPermissions never survives into a new session (background cores never use it: see argsFor).
    if (this.primary && this.settings.get().permissionMode === 'bypassPermissions') this.settings.setPermissionMode('default');
    this.setState('STANDBY');
    if (!silent) this.ui('session', { kind: 'new' });
    this.publish();
    setImmediate(() => this.warm());
  }

  /** Continue a past conversation of this project (history panel): the CLI restarts with --resume <id>. */
  resumeSession(id) {
    if (this.session && this.session.busy) throw new Error('รอให้ตอบรอบนี้เสร็จก่อน หรือกดหยุดก่อน');
    this._dropPendingApprovals('เปลี่ยนเซสชัน');
    if (this.session) this.session.dispose();
    this.session = null;
    this.resumeId = id;
    this.imageCount = 0;
    this.sessionRules.clear();
    this.folderChosen = false;
    this.teachModeDirty = this.teachMode;
    this.codingModeDirty = this.codingMode;
    this.profileDirty = !!this.settings.get().userProfile.trim(); // the old conversation kept its old system prompt
    if (this.memory) this.memorySeen = this.memory.render() ? -1 : this.memory.version; // same for the memory: tell it with the next message
    this.attachedDirs = [];
    this.attachedFiles = [];
    this.pendingAttach = [];
    this.setState('STANDBY');
    this.ui('session', { kind: 'resumed', sessionId: id });
    this.publish();
    setImmediate(() => this.warm());
  }

  /** Restart the CLI with --resume so a new permission mode / settings take effect. */
  restartKeepingContext() {
    if (!this.session) return;
    if (this.session.busy) throw new Error('รอให้ตอบรอบนี้เสร็จก่อน หรือกดหยุดก่อน');
    this.resumeId = this.session.sessionId || this.resumeId;
    this._dropPendingApprovals('รีสตาร์ทเซสชัน');
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
    // new conversations get it in the system prompt; this one hears it with the next message
    if (keys.includes('userProfile')) this.profileDirty = true;
    const restartKeys = ['model', 'mcpConfigPaths', 'addDirs', 'claudePath', 'persistentProcess', 'approvalTimeoutSec'];
    if (keys.some((k) => restartKeys.includes(k)) && this.session) {
      // Mid-turn: restart once the turn ends so the change isn't silently lost.
      if (this.session.busy) this.restartPending = true;
      else this.restartKeepingContext();
    }
    if (keys.includes('model')) this.publish();
  }

  /** Switch --model ('' = Claude Code default) and keep the conversation. */
  setModel(model) {
    const r = this.settings.update({ model });
    if (!r.ok) return r;
    this.onSettingsChanged(['model']);
    this.ui('settings', this.settings.get());
    return r;
  }

  setTeachMode(on) {
    if (this.teachMode === !!on) return;
    this.teachMode = !!on;
    this.teachModeDirty = true;
    this.publish();
  }

  /**
   * Files / folders dropped on the window or added with ＋.
   * - a folder when no project is chosen yet becomes the project
   * - other folders: Claude may read and edit in them (--add-dir; the CLI restarts with --resume)
   * - files: Claude may read them
   * All are mentioned with the next message. System folders, whole drives, the
   * home folder, AppData, secrets and programs are refused.
   * @returns {{ok:boolean, added:{path:string,kind:string}[], rejected:{path:string,reason:string}[]}}
   */
  attach(paths, { home = os.homedir() } = {}) {
    const added = [];
    const rejected = [];
    let newDir = false;
    for (const raw of paths) {
      let p;
      let st;
      try {
        p = fs.realpathSync(String(raw));
        st = fs.statSync(p);
      } catch {
        rejected.push({ path: String(raw), reason: 'ไม่พบไฟล์' });
        continue;
      }
      const isDir = st.isDirectory();
      const why = attachProblem(p, isDir, home);
      if (why) {
        rejected.push({ path: p, reason: why });
        continue;
      }
      if (isDir && !this.cwd) {
        this.setCwd(p);
        added.push({ path: p, kind: 'project' });
        continue;
      }
      const known = [this.cwd, ...this.attachedDirs].some((d) => d && inside(p, d));
      if (isDir && !known) {
        this.attachedDirs.push(p);
        newDir = true;
      } else if (!isDir && !known && !this.attachedFiles.includes(p)) this.attachedFiles.push(p);
      const item = { path: p, kind: isDir ? 'folder' : 'file' };
      if (!this.pendingAttach.some((a) => a.path === p)) this.pendingAttach.push(item);
      added.push(item);
    }
    if (newDir && this.session) {
      if (this.session.busy) this.restartPending = true;
      else this.restartKeepingContext();
    }
    this.publish();
    return { ok: rejected.length === 0, added, rejected };
  }

  /** Remove one pending attachment (the ✕ on its chip). Folder access stays for the session. */
  detach(p) {
    this.pendingAttach = this.pendingAttach.filter((a) => a.path !== p);
    this.publish();
  }

  // ---------- build time (coding mode) ----------

  buildTimeFile() {
    return this.cwd ? path.join(this.cwd, '.jarvis', 'build-time.json') : null;
  }

  loadBuildTime() {
    try {
      const j = JSON.parse(fs.readFileSync(this.buildTimeFile(), 'utf8'));
      if (Number.isFinite(j.totalMs) && j.totalMs >= 0 && Number.isInteger(j.tasks) && j.tasks >= 0) return { totalMs: j.totalMs, tasks: j.tasks };
    } catch { /* none yet */ }
    return { totalMs: 0, tasks: 0 };
  }

  saveBuildTime() {
    const f = this.buildTimeFile();
    if (!f) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ ...this.build, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    } catch { /* read-only folder: keep it in memory */ }
  }

  /** A coding-mode turn ended: add its time and tell the UI. */
  _endBuildTurn({ cancelled, error } = {}) {
    if (!this.buildTurnStart) return;
    const turnMs = Date.now() - this.buildTurnStart;
    this.buildTurnStart = null;
    this.build.totalMs += turnMs;
    this.build.tasks += 1;
    this.saveBuildTime();
    const status = cancelled ? ' (หยุดกลางคัน)' : error ? ' (ผิดพลาด)' : '';
    this.ui('build:time', {
      turnMs,
      totalMs: this.build.totalMs,
      tasks: this.build.tasks,
      text: `⏱ งานนี้ใช้เวลา ${fmtDuration(turnMs)}${status} · รวมเวลาสร้างระบบทั้งหมด ${fmtDuration(this.build.totalMs)} (${this.build.tasks} งาน)`,
    });
  }

  resetBuildTime() {
    this.build = { totalMs: 0, tasks: 0 };
    this.saveBuildTime();
    this.publish();
  }

  setCodingMode(on) {
    if (this.codingMode === !!on) return;
    this.codingMode = !!on;
    this.codingModeDirty = true;
    this.publish();
  }

  // ---------- sending ----------

  /**
   * @param {{text:string, images?:string[], imageSource?:'camera'|'screen', t0?:number, source?:string}} msg
   */
  send(msg) {
    let text = String(msg.text || '').trim();
    const images = msg.images || [];
    if (!text && !images.length && this.pendingAttach.length) text = 'ดูไฟล์ที่แนบมาให้หน่อย';
    if (!text && !images.length) throw new Error('ข้อความว่าง');
    const model = images.length ? null : parseModelCommand(text);
    if (model !== null) {
      if (this.session && this.session.busy) throw Object.assign(new Error('JARVIS ยังตอบรอบก่อนไม่เสร็จ'), { code: 'BUSY' });
      const r = this.setModel(model);
      if (!r.ok) throw new Error(r.errors.join(', '));
      this.ui('notice', { level: 'info', text: `เปลี่ยนโมเดลเป็น ${model || 'ค่าเริ่มต้นของ Claude Code'} แล้ว — บทสนทนาเดิมยังอยู่` });
      return null;
    }
    const coding = images.length ? null : parseCodingModeCommand(text);
    if (coding !== null) {
      this.setCodingMode(coding);
      this.ui('notice', { level: 'info', text: coding ? 'เปิดโหมดโค้ด — JARVIS จะอ่านก่อนแก้ ตรวจผลก่อนสรุป และไม่อ่านโค้ดออกเสียง' : 'ปิดโหมดโค้ดแล้ว' });
      return null;
    }
    // Not picked yet in this conversation: the HUD shows the folder popup, then sends this again.
    if (!images.length && this.needsFolderPick(text)) {
      throw Object.assign(new Error('เลือกโฟลเดอร์โปรเจกต์ก่อน'), { code: 'PICK_FOLDER' });
    }
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
    if (this.pendingAttach.length) {
      const list = this.pendingAttach.map((a) => `- ${a.kind === 'folder' ? 'โฟลเดอร์' : 'ไฟล์'}: ${a.path}`).join('\n');
      prefix += `[ผู้ใช้แนบไฟล์/โฟลเดอร์ต่อไปนี้ (อ่านได้เลย โฟลเดอร์แก้ไขได้ด้วย)]\n${list}\n\n`;
      this.pendingAttach = [];
      this.publish();
    }
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
    if (this.profileDirty) {
      const profile = this.settings.get().userProfile.trim();
      if (profile) prefix += `[JARVIS: ข้อมูลเกี่ยวกับผู้ใช้ (อัปเดตแล้ว) — ${profile}]\n`;
      this.profileDirty = false;
    }
    // a resumed conversation kept its old system prompt, and another project may have changed the memory since
    if (this.memory && this.memorySeen !== this.memory.version) {
      const mem = this.memory.render();
      prefix += `[JARVIS: ความจำระยะยาว (อัปเดตแล้ว) — ${mem || 'ว่าง'}]\n`;
      this.memorySeen = this.memory.version;
    }
    if (this.codeNotes.length) {
      prefix += this.codeNotes.join('\n') + '\n';
      this.codeNotes = [];
    }
    if (this.codingModeDirty) {
      prefix += this.codingMode
        ? `[JARVIS: เปิดโหมดโค้ด — ${CODING_MODE_PROMPT}]\n`
        : '[JARVIS: ปิดโหมดโค้ดแล้ว กลับไปตอบตามปกติ]\n';
      this.codingModeDirty = false;
    }
    if (images.length) {
      prefix += msg.imageSource === 'screen'
        ? '[แนบภาพหน้าจอคอมพิวเตอร์ของผู้ใช้ ณ ตอนที่ถาม (ไม่รวมหน้าต่าง JARVIS) — "ดูนี่" หมายถึงสิ่งที่อยู่บนหน้าจอนี้]\n'
        : `[แนบภาพจากกล้อง ${images.length} ภาพ ณ ตอนที่ผู้ใช้ถาม]\n`;
    }
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
    // undo point for "ยกเลิกการแก้ล่าสุด" (git projects only; a few ms)
    if (this.cwd && !this.summaryRequest) this.tools.snapshot(this.cwd);
    this.turnPipe = this._makePipeline();
    this.setState('THINKING');
    const turnId = session.send(content, { t0: msg.t0 || Date.now() });
    this.buildTurnStart = this.codingMode ? msg.t0 || Date.now() : null;
    this.ui('turn:start', { turnId, isSlash, buildStartedAt: this.buildTurnStart });
    return turnId;
  }

  _makePipeline() {
    const pipe = {};
    pipe.segmenter = new SpeechSegmenter((seg) => {
      const speak = cleanForSpeech(seg);
      if (speak) this.ui('tts:segment', { text: speak });
    });
    pipe.extractor = new BlockExtractor((item) => {
      if (item.type === 'block' && item.kind === 'reminder') {
        if (this.reminders) this.reminders.apply(item.data); // hidden: Claude confirms by voice
        return;
      }
      if (item.type === 'block' && item.kind === 'memory') {
        // handled here, never shown: Claude already knows what it just stored, so this conversation stays in sync
        if (this.memory) {
          this.memory.apply(item.data);
          this.memorySeen = this.memory.version;
        }
        return;
      }
      this.ui('chat:item', item);
      if (item.type === 'text') pipe.segmenter.push(item.text);
      if (item.type === 'block-error') this.ui('terminal', { stream: 'block', text: `บล็อก jarvis-${item.kind} ผิดรูปแบบ: ${item.error}\n${item.raw.slice(0, 800)}` });
    });
    return pipe;
  }

  /** Deny and close every open approval, so no request outlives the session it belongs to. */
  _dropPendingApprovals(message) {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message });
      this.pending.delete(id);
      this.ui('approval:close', { id });
    }
  }

  stop() {
    this._dropPendingApprovals('ผู้ใช้กดหยุด');
    if (this.session) this.session.stop();
    this.tools.cancel();
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

  // ---------- local coding commands (voice: รันเทสต์ / รันเช็ก / ดู diff / ยกเลิกการแก้ล่าสุด) ----------

  _needProject() {
    if (!this.cwd) throw Object.assign(new Error('ยังไม่ได้เลือกโฟลเดอร์โปรเจกต์'), { code: 'NO_CWD' });
  }

  _needIdle(what) {
    if (this.session && this.session.busy) throw Object.assign(new Error(`รอให้ JARVIS ทำงานรอบนี้เสร็จก่อน แล้วค่อย${what}`), { code: 'BUSY' });
  }

  /** Run the project's tests ('test') or checks ('check') here, without Claude. */
  async runCheck(kind) {
    this._needProject();
    this._needIdle(kind === 'test' ? 'รันเทสต์' : 'รันเช็ก');
    const cwd = this.cwd;
    const found = detectChecks(cwd)[kind];
    if (found) this.ui('terminal', { stream: 'info', text: `รันในเครื่อง: ${found.command} (${cwd})` });
    const r = await this.tools.run(kind, cwd, {
      onOutput: (s) => {
        const t = s.trimEnd();
        if (t) this.ui('terminal', { stream: 'stdout', text: t });
      },
    });
    this.audit.write({ tool: 'jarvis-local', input: { command: r.command }, decision: r.ok ? 'passed' : r.cancelled ? 'cancelled' : 'failed', source: 'user-voice' });
    if (!r.cancelled && cwd === this.cwd) {
      const head = `[JARVIS: ผู้ใช้สั่งรัน ${r.command} เองในเครื่อง`;
      this.codeNotes.push(r.ok
        ? `${head} — ผ่าน]`
        : `${head} — ไม่ผ่าน (exit ${r.exitCode ?? '-'}${r.timedOut ? ', หมดเวลา' : ''}) ท้าย output:\n${tailLines(r.tail, 60, 3000)}]`);
    }
    return r;
  }

  /** Changes of the latest turn that changed files (or everything uncommitted). */
  projectDiff() {
    this._needProject();
    return this.tools.diff(this.cwd);
  }

  undoPreview() {
    this._needProject();
    this._needIdle('ย้อนการแก้');
    return this.tools.undoPreview(this.cwd);
  }

  async undoApply(token) {
    this._needProject();
    this._needIdle('ย้อนการแก้');
    const r = await this.tools.undo(this.cwd, token);
    if (r.ok) {
      this.audit.write({ tool: 'jarvis-undo', input: { restored: r.restored, removed: r.removed, safety: r.safety }, decision: 'executed', source: 'user-hud' });
      this.codeNotes.push(`[JARVIS: ผู้ใช้ย้อนการแก้ไฟล์ของงานล่าสุดกลับแล้ว — คืนค่า: ${fileList(r.restored)} · ไฟล์ที่สร้างใหม่ถูกย้ายไปถังขยะ: ${fileList(r.removed)} — เนื้อหาไฟล์เปลี่ยนไปแล้ว อ่านใหม่ก่อนแก้ต่อ]`);
    }
    return r;
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
      if (ev.type === 'rate_limit_event') this.onRateLimit(ev.rate_limit_info);
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
      if (this.slashCommands && this.slashCommands.length) this._writeSlashCache(this.slashCommands.map(String));
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
      if (name === 'TodoWrite' && input && Array.isArray(input.todos)) this.ui('todos', { todos: input.todos });
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
    session.on('result', ({ ev, latency, turnId }) => {
      // a result after the turn already ended (stopped, then the CLI finished anyway) belongs to no turn
      if (turnId == null) return;
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
      this._endBuildTurn({ cancelled, error });
      this.onTurnEnd();
      this.setState(error ? 'ERROR' : 'STANDBY', { cancelled: !!cancelled });
      this.publish();
      if (this.restartPending) {
        this.restartPending = false;
        setImmediate(() => { if (this.session && !this.session.busy) this.restartKeepingContext(); });
      }
      // background projects don't keep an idle CLI running; the next task resumes the conversation
      if (!this.primary) setImmediate(() => { if (this.session && !this.session.busy) this.session.stop(); });
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
    const s = this.settings.get();
    // Background project set to "don't ask": allow every permission request. Guard 'ask' requests still reach the user.
    if (req.kind === 'permission' && this.approvalPolicy === 'auto' && s.permissionMode !== 'plan') {
      this.audit.write({ session: this.session && this.session.sessionId, tool, tool_use_id: req.tool_use_id, input, decision: 'allow', source: 'jarvis-project-auto' });
      return { behavior: 'allow', updatedInput: input };
    }
    // Safe actions (installs, builds, edits inside the project, …) don't ask — unless the project is set to "ask every time".
    // Guard 'ask' requests (firmware upload, admin) always reach the user.
    if (req.kind === 'permission' && s.autoApproveSafe && this.approvalPolicy !== 'ask' && s.permissionMode !== 'plan'
      && isSafeAction(tool, input, { cwd: this.cwd, dirs: this.attachedDirs, files: this.attachedFiles })) {
      this.audit.write({ session: this.session && this.session.sessionId, tool, tool_use_id: req.tool_use_id, input, decision: 'allow', source: 'jarvis-auto-safe' });
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
    // an answer meant for another project never settles a request here
    if (r.projectId !== undefined && r.projectId !== this.id) return { ok: false, errors: ['คำขอนี้เป็นของโปรเจกต์อื่น'] };
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

module.exports = { JarvisCore, toolSummary, previewFor, parseModelCommand, parseCodingModeCommand, isCodeProject, fmtDuration, INTERACTIVE_ONLY };
