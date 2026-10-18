'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { StreamJsonParser } = require('../lib/claude/stream-parser');
const { buildClaudeArgs } = require('../lib/claude/args');

test('parser handles lines split across chunks, including inside UTF-8 chars', () => {
  const events = [];
  const bad = [];
  const p = new StreamJsonParser({ onEvent: (e) => events.push(e), onBadLine: (l) => bad.push(l) });
  const text = JSON.stringify({ type: 'a', t: 'สวัสดี' }) + '\n' + JSON.stringify({ type: 'b' }) + '\n';
  const buf = Buffer.from(text, 'utf8');
  for (let i = 0; i < buf.length; i += 3) p.push(buf.subarray(i, i + 3));
  assert.deepStrictEqual(events, [{ type: 'a', t: 'สวัสดี' }, { type: 'b' }]);
  assert.strictEqual(bad.length, 0);
});

test('parser skips unparseable lines and reports them', () => {
  const events = [];
  const bad = [];
  const p = new StreamJsonParser({ onEvent: (e) => events.push(e), onBadLine: (l) => bad.push(l) });
  p.push('not json\n{"type":"ok"}\r\n\n');
  p.push('{"type":"tail"}');
  p.end();
  assert.deepStrictEqual(events.map((e) => e.type), ['ok', 'tail']);
  assert.deepStrictEqual(bad, ['not json']);
});

test('buildClaudeArgs uses verified flags and never enables bypass by accident', () => {
  const a = buildClaudeArgs({
    appendSystemPrompt: 'SP',
    permissionMode: 'weird',
    permissionPromptTool: 'mcp__jarvis__approve',
    mcpConfigs: ['a.json', '', 'b.json'],
    addDirs: ['D:/x'],
    model: 'opus',
    resume: 'abc',
  });
  for (const f of ['-p', '--verbose', '--include-partial-messages']) assert.ok(a.includes(f));
  assert.strictEqual(a[a.indexOf('--input-format') + 1], 'stream-json');
  assert.strictEqual(a[a.indexOf('--output-format') + 1], 'stream-json');
  assert.strictEqual(a[a.indexOf('--setting-sources') + 1], 'user,project,local');
  assert.strictEqual(a[a.indexOf('--permission-mode') + 1], 'default');
  assert.strictEqual(a[a.indexOf('--permission-prompt-tool') + 1], 'mcp__jarvis__approve');
  assert.deepStrictEqual(a.slice(a.indexOf('--mcp-config') + 1, a.indexOf('--mcp-config') + 3), ['a.json', 'b.json']);
  assert.strictEqual(a[a.indexOf('--resume') + 1], 'abc');
  assert.ok(!a.includes('--allowedTools'), 'no tool allow-list by default');
});
