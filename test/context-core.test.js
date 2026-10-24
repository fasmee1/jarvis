'use strict';
// JarvisCore: context size, compaction notices, subagent events and the automatic /compact.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SettingsStore } = require('../lib/settings');
const { JarvisCore } = require('../lib/jarvis-core');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ctxc-')));

function make(settingsPatch = {}) {
  const settings = new SettingsStore(tmp());
  if (Object.keys(settingsPatch).length) settings.update(settingsPatch);
  const events = [];
  const core = new JarvisCore({ settings, tempDir: tmp(), ui: (c, p) => events.push([c, p]), appRoot: tmp(), logDir: tmp() });
  core.warm = () => {};
  core.session = { busy: false };
  const sent = [];
  core._startTurn = (content) => { sent.push(content); return 't'; };
  return { core, events, sent };
}

const assistant = (u, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { usage: u, content: [] } });

test('context size follows the last main-thread message; a subagent message does not count', () => {
  const { core } = make();
  core._trackContext(assistant({ input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 4000 }));
  assert.strictEqual(core.ctxUsed, 5002);
  core._trackContext(assistant({ input_tokens: 999999 }, 'toolu_sub'));
  assert.strictEqual(core.ctxUsed, 5002);
  core._trackContext({ type: 'result', modelUsage: { m: { contextWindow: 1000000 } } });
  const c = core.snapshot().context;
  assert.deepStrictEqual([c.used, c.window, c.compacting], [5002, 1000000, false]);
});

test('compaction: status shows it, the boundary resets the size and tells the user', () => {
  const { core, events } = make();
  core.ctxUsed = 150000;
  core._trackContext({ type: 'system', subtype: 'status', status: 'compacting' });
  assert.strictEqual(core.snapshot().context.compacting, true);
  core._trackContext({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  assert.strictEqual(core.compacting, false);
  core._trackContext({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 12000 } });
  assert.strictEqual(core.ctxUsed, 12000);
  const note = events.filter(([c]) => c === 'notice').at(-1)[1].text;
  assert.match(note, /150k → 12k/);
});

test('subagent events are published, and a new turn clears them', () => {
  const { core, events } = make();
  core._trackContext({ type: 'system', subtype: 'task_started', task_id: 'a', description: 'ค้นไฟล์', subagent_type: 'Explore', task_type: 'local_agent' });
  core._trackContext({ type: 'system', subtype: 'task_progress', task_id: 'a', usage: { total_tokens: 3000, tool_uses: 1 }, last_tool_name: 'Glob' });
  const last = () => events.filter(([c]) => c === 'subagents').at(-1)[1].agents;
  assert.deepStrictEqual([last().length, last()[0].title, last()[0].tools], [1, 'ค้นไฟล์', 1]);
  core.subagents.reset();
  core._publishSubagents();
  assert.strictEqual(last().length, 0);
});

test('auto compact: runs /compact once when the context is nearly full, never mid-turn, off at 0', () => {
  const { core, sent } = make();
  core.ctxWindow = 200000;
  core.ctxUsed = 100000;
  core._maybeAutoCompact();
  assert.deepStrictEqual(sent, [], 'below 80%');
  core.ctxUsed = 170000;
  core.session.busy = true;
  core._maybeAutoCompact();
  assert.deepStrictEqual(sent, [], 'busy');
  core.session.busy = false;
  core._maybeAutoCompact();
  assert.deepStrictEqual(sent, ['/compact']);
  assert.strictEqual(core.autoCompacting, true);
  // it compacted but stayed big: no new compaction until the context grows another tenth
  core._trackContext({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 170000, post_tokens: 165000 } });
  core.autoCompacting = false;
  core.ctxUsed = 170000;
  core._maybeAutoCompact();
  assert.strictEqual(sent.length, 1);

  const off = make({ autoCompactAt: 0 });
  off.core.ctxWindow = 200000;
  off.core.ctxUsed = 199000;
  off.core._maybeAutoCompact();
  assert.deepStrictEqual(off.sent, []);
});

test('a new conversation forgets the old size', () => {
  const { core } = make();
  core.ctxUsed = 90000;
  core.lastAutoPost = 80000;
  core.session = null;
  core.newSession({ silent: true });
  assert.strictEqual(core.ctxUsed, null);
  assert.strictEqual(core.lastAutoPost, 0);
});
