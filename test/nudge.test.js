'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CheckNudge } = require('../lib/coding/nudge');

const UNDO = /ยกเลิกการแก้ล่าสุด/;
const TEST_HINT = /ยังไม่ได้รันเทสต์/;

test('nudge: edits without a check remind once, undo hint every edit turn', () => {
  const n = new CheckNudge();
  n.toolUse('Edit', { file_path: 'D:/p/a.js' });
  n.toolUse('Write', { file_path: 'D:/p/b.js' });
  const first = n.reminder(true);
  assert.match(first, /2 ไฟล์/);
  assert.match(first, UNDO);
  n.toolUse('Edit', { file_path: 'D:/p/c.js' });
  const second = n.reminder(true);
  assert.match(second, /3 ไฟล์/, 'new edit starts a new reminder');
  assert.strictEqual(n.reminder(true), '', 'no edits this turn: silent');
});

test('nudge: a test run, no checks, or protected paths drop the test reminder', () => {
  const n = new CheckNudge();
  n.toolUse('Edit', { file_path: 'D:/p/a.js' });
  n.toolUse('Bash', { command: 'npm test' });
  const afterTest = n.reminder(true);
  assert.doesNotMatch(afterTest, TEST_HINT);
  assert.match(afterTest, UNDO);

  n.toolUse('Edit', { file_path: 'D:\\p\\.git\\config' });
  n.toolUse('Write', { file_path: 'D:\\p\\.claude\\x.md' });
  assert.strictEqual(n.reminder(true), '', 'protected paths are not counted');

  n.toolUse('Edit', { file_path: 'D:/p/a.js' });
  assert.doesNotMatch(n.reminder(false), TEST_HINT, 'project has no test command');
  n.toolUse('Read', { file_path: 'D:/p/z.js' });
  assert.strictEqual(n.reminder(false), '', 'reading adds nothing');
});
