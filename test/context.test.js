'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { contextTokens, windowFromResult, shouldAutoCompact, SubagentTracker } = require('../lib/claude/context');

test('contextTokens adds prompt, cache-written and cache-read tokens', () => {
  assert.strictEqual(contextTokens({ input_tokens: 2, cache_creation_input_tokens: 25161, cache_read_input_tokens: 15945, output_tokens: 4 }), 41108);
  assert.strictEqual(contextTokens({}), null);
  assert.strictEqual(contextTokens(null), null);
  assert.strictEqual(contextTokens({ input_tokens: 'x', cache_read_input_tokens: -5 }), null);
});

test('windowFromResult takes the biggest contextWindow, or null', () => {
  assert.strictEqual(windowFromResult({ modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } } }), 1000000);
  assert.strictEqual(windowFromResult({ modelUsage: { a: {} } }), null);
  assert.strictEqual(windowFromResult({}), null);
});

test('shouldAutoCompact: over the threshold, off at 0, and not again right after a compaction that stayed big', () => {
  const w = 200000;
  assert.strictEqual(shouldAutoCompact({ used: 100000, window: w, at: 80 }), false);
  assert.strictEqual(shouldAutoCompact({ used: 160000, window: w, at: 80 }), true);
  assert.strictEqual(shouldAutoCompact({ used: 190000, window: w, at: 0 }), false);
  assert.strictEqual(shouldAutoCompact({ used: 0, window: w, at: 80 }), false);
  // the last compaction left 165k: wait for 20k more
  assert.strictEqual(shouldAutoCompact({ used: 170000, window: w, at: 80, lastPost: 165000 }), false);
  assert.strictEqual(shouldAutoCompact({ used: 186000, window: w, at: 80, lastPost: 165000 }), true);
  assert.strictEqual(shouldAutoCompact({ used: 170000, at: 80 }), true, 'default window 200k');
});

test('SubagentTracker follows task_started / progress / updated for subagents only', () => {
  const t = new SubagentTracker();
  assert.strictEqual(t.handle({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'tu', description: 'List files', subagent_type: 'Explore', task_type: 'local_agent' }), true);
  assert.strictEqual(t.handle({ type: 'system', subtype: 'task_started', task_id: 'sh', task_type: 'local_bash' }), false, 'a shell task is not a subagent');
  assert.strictEqual(t.handle({ type: 'system', subtype: 'task_progress', task_id: 'a1', usage: { total_tokens: 25324, tool_uses: 2 }, last_tool_name: 'Glob', description: 'Finding *' }), true);
  assert.strictEqual(t.handle({ type: 'system', subtype: 'task_progress', task_id: 'nope' }), false);
  let [a] = t.list();
  assert.deepStrictEqual([a.title, a.type, a.status, a.tools, a.tokens, a.lastTool], ['List files', 'Explore', 'running', 2, 25324, 'Glob']);
  assert.strictEqual(t.handle({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'completed' } }), true);
  assert.strictEqual(t.handle({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' }), false, 'already completed');
  [a] = t.list();
  assert.strictEqual(a.status, 'completed');
  assert.ok(a.endedAt);
  assert.strictEqual(t.handle({ type: 'assistant' }), false);
  assert.strictEqual(t.reset(), true);
  assert.strictEqual(t.list().length, 0);
});
