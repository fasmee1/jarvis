import test from 'node:test';
import assert from 'node:assert';

const { toolPhase } = await import('../renderer/ui/task-phase.js');

test('toolPhase names the action and the file', () => {
  assert.strictEqual(toolPhase('Read', { file_path: 'D:\\mee-jarvis\\jarvis\\main.js' }), 'กำลังอ่าน main.js');
  assert.strictEqual(toolPhase('Edit', { file_path: '/a/b/app.js' }), 'กำลังแก้ app.js');
  assert.strictEqual(toolPhase('Write', { file_path: 'x.txt' }), 'กำลังเขียน x.txt');
});

test('toolPhase works without input or for unknown tools', () => {
  assert.strictEqual(toolPhase('Bash', null), 'กำลังรันคำสั่ง');
  assert.strictEqual(toolPhase('Foo', {}), 'กำลังใช้ Foo');
  assert.strictEqual(toolPhase('', {}), 'กำลังทำงาน');
});

test('toolPhase shortens long targets', () => {
  const out = toolPhase('Grep', { pattern: 'x'.repeat(100) });
  assert.ok(out.startsWith('กำลังค้นข้อความ "'));
  assert.ok(out.endsWith('…'));
  assert.ok(out.length < 70);
});
