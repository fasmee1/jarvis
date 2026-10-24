'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PermissionBroker } = require('../lib/permission-mcp/broker');
const { ruleFor, addAllowRule } = require('../lib/permissions/rules');
const { evaluate, evaluatePlan, defaultGuardConfig } = require('../lib/hooks/guard-rules');
const { buildClaudeArgs } = require('../lib/claude/args');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
}

// Drive the real MCP server over stdio, exactly like Claude Code does.
function mcpCall(env, calls) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'permission-mcp', 'server.js')], { env: { ...process.env, ...env } });
    const out = [];
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        out.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        if (out.length === calls.length) {
          p.stdin.end();
          resolve(out);
        }
      }
    });
    p.on('error', reject);
    for (const c of calls) p.stdin.write(JSON.stringify(c) + '\n');
  });
}

const callApprove = (id, tool, input) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: tool, input, tool_use_id: 'tu' + id } } });

test('MCP approve tool round-trips through the broker (allow + deny + bad token)', async () => {
  const seen = [];
  const broker = new PermissionBroker({
    timeoutSec: 5,
    onRequest: (req) => {
      seen.push(req);
      return req.input.command === 'ok' ? { behavior: 'allow', updatedInput: req.input } : { behavior: 'deny', message: 'nope' };
    },
  });
  await broker.start();
  try {
    const env = { JARVIS_PIPE: broker.pipe, JARVIS_TOKEN: broker.token };
    const out = await mcpCall(env, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      callApprove(3, 'Bash', { command: 'ok' }),
      callApprove(4, 'Bash', { command: 'rm x' }),
    ]);
    const byId = Object.fromEntries(out.map((m) => [m.id, m]));
    assert.strictEqual(byId[2].result.tools[0].name, 'approve');
    assert.deepStrictEqual(JSON.parse(byId[3].result.content[0].text), { behavior: 'allow', updatedInput: { command: 'ok' } });
    assert.deepStrictEqual(JSON.parse(byId[4].result.content[0].text), { behavior: 'deny', message: 'nope' });
    assert.strictEqual(seen[0].tool_name, 'Bash');
    assert.strictEqual(seen[0].kind, 'permission');

    const bad = await mcpCall({ JARVIS_PIPE: broker.pipe, JARVIS_TOKEN: 'wrong' }, [callApprove(5, 'Bash', { command: 'ok' })]);
    assert.strictEqual(JSON.parse(bad[0].result.content[0].text).behavior, 'deny');
  } finally {
    broker.stop();
  }
});

test('broker denies automatically after the timeout', async () => {
  let settledWhy = null;
  const broker = new PermissionBroker({ timeoutSec: 0.3, onRequest: () => new Promise(() => {}) });
  broker.onSettled = (_r, _d, why) => { settledWhy = why; };
  await broker.start();
  try {
    const out = await mcpCall({ JARVIS_PIPE: broker.pipe, JARVIS_TOKEN: broker.token }, [callApprove(1, 'Write', { file_path: 'a' })]);
    const v = JSON.parse(out[0].result.content[0].text);
    assert.strictEqual(v.behavior, 'deny');
    assert.match(v.message, /วินาที/);
    assert.strictEqual(settledWhy, 'timeout');
  } finally {
    broker.stop();
  }
});

test('MCP server denies when the app pipe is unreachable', async () => {
  const out = await mcpCall({ JARVIS_PIPE: process.platform === 'win32' ? '\\\\.\\pipe\\jarvis-nope-xyz' : '/tmp/nope.sock', JARVIS_TOKEN: 't' }, [callApprove(1, 'Bash', { command: 'x' })]);
  assert.strictEqual(JSON.parse(out[0].result.content[0].text).behavior, 'deny');
});

test('ruleFor builds Claude Code permission rules', () => {
  const cwd = path.resolve('/proj');
  assert.strictEqual(ruleFor('Bash', { command: 'arduino-cli compile .' }, cwd), 'Bash(arduino-cli compile .)');
  assert.strictEqual(ruleFor('Bash', { command: 'a\nb' }, cwd), null);
  assert.strictEqual(ruleFor('Edit', { file_path: path.join(cwd, 'src', 'a.ino') }, cwd), 'Edit(./src/a.ino)');
  assert.strictEqual(ruleFor('Write', { file_path: path.join(cwd, 'x.txt') }, cwd), 'Edit(./x.txt)');
  assert.strictEqual(ruleFor('WebFetch', { url: 'https://docs.arduino.cc/x' }, cwd), 'WebFetch(domain:docs.arduino.cc)');
  assert.strictEqual(ruleFor('mcp__srv__tool', {}, cwd), 'mcp__srv__tool');
});

test('addAllowRule merges into settings.local.json without clobbering, refuses corrupt files', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.claude'));
  const file = path.join(dir, '.claude', 'settings.local.json');
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Read'], deny: ['Bash(rm *)'] }, env: { A: '1' } }));
  addAllowRule(dir, 'Bash(npm test)');
  addAllowRule(dir, 'Bash(npm test)');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(j.permissions.allow, ['Read', 'Bash(npm test)']);
  assert.deepStrictEqual(j.permissions.deny, ['Bash(rm *)']);
  assert.strictEqual(j.env.A, '1');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => addAllowRule(dir, 'X'), /JSON/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
});

test('guard blocks catastrophic commands, asks for uploads/admin, allows normal work', () => {
  const cfg = defaultGuardConfig();
  const block = [
    'format C: /q',
    'Format-Volume -DriveLetter D',
    'rm -rf /',
    'rm -rf ~',
    'rd /s /q C:\\',
    'rmdir /s /q C:\\Windows',
    'Remove-Item -Recurse -Force C:\\Users',
    'Remove-Item C:\\Windows -Recurse',
    'reg delete HKLM\\Software\\X /f',
    'Set-ItemProperty -Path HKLM:\\SOFTWARE\\X -Name a -Value 1',
    'diskpart /s wipe.txt',
    'bcdedit /set safeboot',
  ];
  for (const c of block) assert.strictEqual(evaluate('Bash', { command: c }, cfg).action, 'block', c);
  const ask = [
    'arduino-cli upload -p COM3 --fqbn arduino:avr:uno .',
    'esptool.py --port COM5 write_flash 0x0 fw.bin',
    'python -m esptool erase_flash',
    'Start-Process winget -Verb RunAs',
    'winget install OpenSCAD.OpenSCAD',
    'npm install -g something',
  ];
  for (const c of ask) assert.strictEqual(evaluate('PowerShell', { command: c }, cfg).action, 'ask', c);
  const allow = [
    'arduino-cli compile --fqbn arduino:avr:uno .',
    'rm -rf build',
    'rm -rf ./node_modules',
    'Remove-Item -Recurse .\\build',
    'git status',
    'reg query HKLM\\Software',
    'del /q build\\*.o',
  ];
  for (const c of allow) assert.strictEqual(evaluate('Bash', { command: c }, cfg).action, 'allow', c);
  assert.strictEqual(evaluate('Write', { file_path: 'C:\\Windows\\System32\\x.dll' }, cfg).action, 'block');
  assert.strictEqual(evaluate('Write', { file_path: 'C:\\proj\\a.ino' }, cfg).action, 'allow');
  assert.strictEqual(evaluate('Bash', { command: 'format C:' }, { ...cfg, enabled: false }).action, 'allow');
});

test('guard hook script talks to the broker for "ask" commands', async () => {
  const dir = tmpdir();
  const cfgFile = path.join(dir, 'guard.json');
  fs.writeFileSync(cfgFile, JSON.stringify(defaultGuardConfig()));
  const broker = new PermissionBroker({ timeoutSec: 5, onRequest: (req) => ({ behavior: req.kind === 'guard' ? 'allow' : 'deny' }) });
  await broker.start();
  const runHook = (ev) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'hooks', 'guard.js')], {
        env: { ...process.env, JARVIS_GUARD_CONFIG: cfgFile, JARVIS_PIPE: broker.pipe, JARVIS_TOKEN: broker.token },
      });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('exit', () => resolve(out ? JSON.parse(out) : null));
      p.stdin.end(JSON.stringify(ev));
    });
  try {
    const up = await runHook({ tool_name: 'Bash', tool_input: { command: 'arduino-cli upload -p COM3 .' } });
    assert.strictEqual(up.hookSpecificOutput.permissionDecision, 'allow');
    const fmt = await runHook({ tool_name: 'Bash', tool_input: { command: 'format D:' } });
    assert.strictEqual(fmt.hookSpecificOutput.permissionDecision, 'deny');
    const normal = await runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.strictEqual(normal, null);
  } finally {
    broker.stop();
  }
});

test('plan mode: file tools and mutating shell are blocked, read-only shell is allowed', () => {
  for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.strictEqual(evaluatePlan(t, { file_path: 'C:\proj\a.js' }).action, 'block', t);
  const blocked = ['rm a.txt', 'echo hi > a.txt', 'git commit -m x', 'git branch -D x', 'npm install', 'ls && touch a', 'cat a | tee b', 'echo $(touch a)', 'find . -delete', 'node build.js'];
  for (const c of blocked) assert.strictEqual(evaluatePlan('Bash', { command: c }).action, 'block', c);
  const allowed = ['ls -la', 'git status', 'git diff HEAD', 'cat a.js | grep foo', 'rg TODO src 2>&1', 'dir'];
  for (const c of allowed) assert.strictEqual(evaluatePlan('PowerShell', { command: c }).action, 'allow', c);
  assert.strictEqual(evaluatePlan('Read', { file_path: 'a' }).action, 'allow');
  assert.strictEqual(evaluatePlan('mcp__x__create_form', {}).action, 'block');
  assert.strictEqual(evaluatePlan('mcp__x__get_design_context', {}).action, 'allow');
});

test('buildClaudeArgs passes disallowedTools', () => {
  const a = buildClaudeArgs({ permissionMode: 'plan', disallowedTools: ['Write', 'Edit'] });
  assert.ok(a.includes('--disallowedTools') && a.includes('Write,Edit'));
});

test('ExitPlanMode: a plan is shown to the user and can never be "always allowed"', async () => {
  const { ruleFor } = require('../lib/permissions/rules');
  const { toolSummary, previewFor } = require('../lib/jarvis-core');
  assert.strictEqual(ruleFor('ExitPlanMode', { plan: 'x' }, process.cwd()), null);
  assert.match(toolSummary('ExitPlanMode', {}), /แผน/);
  assert.deepStrictEqual(previewFor('ExitPlanMode', { plan: '1. ทำ A' }), { plan: '1. ทำ A' });
  assert.strictEqual(previewFor('ExitPlanMode', {}), null);
});
