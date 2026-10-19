// Conversation popup: voice commands and the folder path shown in its toolbar.
const test = require('node:test');
const assert = require('node:assert');

test('voice: เปิดบทสนทนา / ปิดบทสนทนา open and close the conversation popup', async () => {
  const { parseCommand: p } = await import('../renderer/handsfree/commands.js');
  for (const t of ['เปิดบทสนทนา', 'จาร์วิส เปิดบทสนทนาครับ', 'ดูบทสนทนา', 'เปิดแชท', 'open conversation']) assert.deepStrictEqual(p(t), { action: 'talk-open' }, t);
  for (const t of ['ปิดบทสนทนา', 'ปิดบทสนทนาหน่อย', 'ซ่อนแชท', 'close conversation']) assert.deepStrictEqual(p(t), { action: 'talk-close' }, t);
  // works while the viewer is open too, and never swallows other commands
  assert.deepStrictEqual(p('ปิดบทสนทนา', { viewer: true }), { action: 'talk-close' });
  assert.deepStrictEqual(p('ปิด', { viewer: true }), { action: 'viewer', op: 'close' });
  assert.strictEqual(p('ช่วยสรุปบทสนทนาเมื่อกี้ให้หน่อย'), null);
});

test('folder path: middle-ellipsized, both ends kept', async () => {
  const { middleEllipsis: m } = await import('../renderer/ui/conversation.js');
  assert.strictEqual(m('D:/New folder (2)', 40), 'D:/New folder (2)');
  const long = 'C:/Users/Acer/Documents/projects/clients/very-long-name/mee-jarvis';
  const s = m(long, 30);
  assert.strictEqual(s.length, 30);
  assert.ok(s.startsWith('C:/Users/') && s.endsWith('mee-jarvis') && s.includes('…'), s);
  assert.strictEqual(m('', 10), '');
});
