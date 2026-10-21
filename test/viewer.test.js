'use strict';
// Result Viewer: payload schema, URL / id safety, reader-view extraction,
// private-address blocking, and the viewer voice commands.
const test = require('node:test');
const assert = require('node:assert');
const { SCHEMAS } = require('../lib/blocks/schemas');
const { validate } = require('../lib/blocks/validate');
const { BlockExtractor } = require('../lib/blocks/extractor');
const { extract, isPrivateIp, checkUrl, frameable } = require('../lib/web/reader');

const utils = () => import('../renderer/ui/result-utils.js');
const commands = () => import('../renderer/handsfree/commands.js');

test('jarvis-result payloads validate by type', () => {
  const ok = (d) => assert.deepStrictEqual(validate(SCHEMAS.result, d), []);
  ok({ type: 'search', title: 'ราคาทอง', spokenSummary: 'ขึ้น 150 บาท', items: [{ title: 'a', url: 'https://a.com', snippet: 's' }], summary: { text: 'x [1]' } });
  ok({ type: 'news', items: [{ title: 'n', url: 'https://n.com', source: 'N', publishedAt: '2026-10-18T08:00:00Z', summary: 's' }] });
  ok({ type: 'youtube', items: [{ videoId: 'dQw4w9WgXcQ', title: 't', channel: 'c' }] });
  ok({ type: 'weather', location: 'กรุงเทพฯ', current: { temp: 31, condition: 'เมฆ' }, hourly: [{ time: '14:00', temp: 32, rain: 40 }] });
  ok({ type: 'table', columns: ['a', 'b'], rows: [[1, 'x'], [2, 'y']] });
  ok({ type: 'chart', labels: ['1', '2'], series: [{ name: 's', values: [1, 2] }] });
  ok({ type: 'map', lat: 13.76, lon: 100.53, zoom: 15 });
  ok({ type: 'map', lat: 13.76, lon: 100.53, view3d: true, satellite: true, earth: true, streetview: true });
  assert.ok(validate(SCHEMAS.result, { type: 'map', lat: 1, lon: 1, streetview: 'yes' }).length, 'streetview must be boolean');
  ok({ type: 'weather', location: 'เชียงใหม่', lat: 18.79, lon: 98.98, current: { temp: 27 } });
  assert.ok(validate(SCHEMAS.result, { type: 'map', lat: 1, lon: 1, view3d: 'yes' }).length, 'view3d must be boolean');
  assert.ok(validate(SCHEMAS.result, { type: 'video' }).length, 'unknown type rejected');
  assert.ok(validate(SCHEMAS.result, { type: 'map', lat: 120, lon: 0 }).length, 'lat out of range');
  assert.ok(validate(SCHEMAS.result, { type: 'search', items: new Array(41).fill({}) }).length, 'max 40 items');
});

test('linkParts turns chat URLs into links', async () => {
  const { linkParts } = await utils();
  assert.deepStrictEqual(linkParts('ดูที่ https://a.com/x?y=1. ครับ'), [
    { text: 'ดูที่ ' }, { text: 'https://a.com/x?y=1', url: 'https://a.com/x?y=1' }, { text: '. ครับ' },
  ]);
  assert.deepStrictEqual(linkParts('[เว็บ](https://b.com/p)'), [{ text: 'เว็บ', url: 'https://b.com/p' }]);
  assert.deepStrictEqual(linkParts('https://c.comครับ')[0], { text: 'https://c.com', url: 'https://c.com/' });
  assert.strictEqual(linkParts('(https://en.wikipedia.org/wiki/A_(b))')[1].text, 'https://en.wikipedia.org/wiki/A_(b)');
  assert.strictEqual(linkParts('(https://d.com)')[1].text, 'https://d.com');
  assert.deepStrictEqual(linkParts('[x](javascript:alert(1))'), [{ text: '[x](javascript:alert(1))' }]);
  assert.deepStrictEqual(linkParts('ไม่มีลิงก์'), [{ text: 'ไม่มีลิงก์' }]);
});

test('a streamed ```jarvis-result block comes out as a block item', () => {
  const items = [];
  const x = new BlockExtractor((i) => items.push(i));
  x.push('พบผลแล้วครับ\n```jarvis-result\n{"type":"search","title":"t","items":[{"title":"a","url":"https://a.com"}]}\n```\nแสดงบนจอแล้ว\n');
  x.end();
  const b = items.find((i) => i.type === 'block');
  assert.strictEqual(b.kind, 'result');
  assert.strictEqual(b.data.items[0].url, 'https://a.com');
});

test('only http(s) links and real YouTube ids pass', async () => {
  const { safeUrl, youtubeId, domainOf } = await utils();
  assert.strictEqual(safeUrl('https://a.com/x'), 'https://a.com/x');
  assert.strictEqual(safeUrl('javascript:alert(1)'), null);
  assert.strictEqual(safeUrl('data:text/html,<script>'), null);
  assert.strictEqual(safeUrl('file:///C:/x'), null);
  assert.strictEqual(safeUrl(42), null);
  assert.strictEqual(youtubeId({ videoId: 'dQw4w9WgXcQ' }), 'dQw4w9WgXcQ');
  assert.strictEqual(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), 'dQw4w9WgXcQ');
  assert.strictEqual(youtubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(youtubeId({ videoId: 'x"><script>' }), null);
  assert.strictEqual(youtubeId('https://evil.com/watch?v=dQw4w9WgXcQ'), null);
  assert.strictEqual(domainOf('https://www.bbc.com/news'), 'bbc.com');
});

test('relative time in Thai', async () => {
  const { relTime } = await utils();
  const now = Date.parse('2026-10-18T12:00:00Z');
  assert.strictEqual(relTime('2026-10-18T11:55:00Z', now), '5 นาทีที่แล้ว');
  assert.strictEqual(relTime('2026-10-18T10:00:00Z', now), '2 ชม.ที่แล้ว');
  assert.strictEqual(relTime('2026-10-17T10:00:00Z', now), 'เมื่อวาน');
  assert.strictEqual(relTime('2026-10-15T10:00:00Z', now), '3 วันที่แล้ว');
  assert.strictEqual(relTime('', now), '');
  assert.strictEqual(relTime('2 hours ago', now), '2 hours ago');
});

test('reader view: plain text blocks only, scripts / nav dropped, entities decoded', () => {
  const html = `<html><head><title>T &amp; co</title><meta property="og:site_name" content="Site"><meta property="og:image" content="/img.jpg">
    <script>alert(1)</script><style>p{}</style></head><body><nav><p>menu menu menu menu menu menu</p></nav>
    <article><h1>หัวข้อหลัก</h1><p>ย่อหน้าแรกที่ยาวพอจะนับเป็นเนื้อหาจริงของบทความนี้ &lt;b&gt;ไม่ใช่ HTML&lt;/b&gt;</p>
    <p><img src=x onerror=alert(1)>สั้น</p><ul><li>รายการที่หนึ่งยาวพอสมควรสำหรับการทดสอบนะ</li></ul></article></body></html>`;
  const r = extract(html, 'https://example.com/a');
  assert.strictEqual(r.title, 'T & co');
  assert.strictEqual(r.siteName, 'Site');
  assert.strictEqual(r.image, 'https://example.com/img.jpg');
  assert.deepStrictEqual(r.blocks.map((b) => b.kind), ['h', 'p', 'li']);
  assert.ok(r.blocks[1].text.includes('<b>ไม่ใช่ HTML</b>'), 'escaped markup stays text');
  assert.ok(!JSON.stringify(r).includes('alert'), 'no script / handler text');
  assert.ok(!JSON.stringify(r).includes('menu'), 'nav dropped');
});

test('framing headers decide iframe vs reader', () => {
  const H = (o) => new Headers(o);
  assert.strictEqual(frameable(H({})), true);
  assert.strictEqual(frameable(H({ 'x-frame-options': 'DENY' })), false);
  assert.strictEqual(frameable(H({ 'x-frame-options': 'SAMEORIGIN' })), false);
  assert.strictEqual(frameable(H({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" })), false);
  assert.strictEqual(frameable(H({ 'content-security-policy': 'frame-ancestors *' })), true);
});

test('web reader never fetches local / private addresses', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
  await assert.rejects(checkUrl('http://localhost:3000/'));
  await assert.rejects(checkUrl('http://127.0.0.1/'));
  await assert.rejects(checkUrl('file:///C:/Windows/win.ini'));
  await assert.rejects(checkUrl('https://user:pw@example.com/'));
});

test('viewer voice commands (only while the viewer is open)', async () => {
  const { parseCommand: p } = await commands();
  const V = { viewer: true };
  const VV = { viewer: true, video: true };
  assert.deepStrictEqual(p('ปิด', V), { action: 'viewer', op: 'close' });
  assert.deepStrictEqual(p('ปิดหน้าจอ', V), { action: 'viewer', op: 'close' });
  assert.deepStrictEqual(p('ขยายจอ', V), { action: 'viewer', op: 'wide', n: 1 });
  assert.deepStrictEqual(p('ขยายเต็มจอครับ', V), { action: 'viewer', op: 'wide', n: 1 });
  assert.deepStrictEqual(p('ย่อจอ', V), { action: 'viewer', op: 'wide', n: 0 });
  assert.deepStrictEqual(p('ขยายจอ', { viewer: true, web: true }), { action: 'viewer', op: 'wide', n: 1 });
  assert.deepStrictEqual(p('ขยาย', { viewer: true, web: true }), { action: 'viewer', op: 'expand' });
  assert.strictEqual(p('ปิด', {}), null, 'plain "ปิด" means nothing without the viewer');
  assert.deepStrictEqual(p('ถัดไป', V), { action: 'viewer', op: 'next' });
  assert.deepStrictEqual(p('ก่อนหน้า', V), { action: 'viewer', op: 'prev' });
  assert.deepStrictEqual(p('เปิดอันที่ 2', V), { action: 'viewer', op: 'open', n: 2 });
  assert.deepStrictEqual(p('เปิดอันที่สอง', V), { action: 'viewer', op: 'open', n: 2 });
  assert.deepStrictEqual(p('อ่านข่าวแรก', V), { action: 'viewer', op: 'read', n: 1 });
  assert.deepStrictEqual(p('อ่านข่าวที่ ๓', V), { action: 'viewer', op: 'read', n: 3 });
  assert.deepStrictEqual(p('เลื่อนลง', V), { action: 'viewer', op: 'scroll', n: 1 });
  assert.deepStrictEqual(p('เลื่อนขึ้นครับ', V), { action: 'viewer', op: 'scroll', n: -1 });
  assert.deepStrictEqual(p('เปิดในเบราว์เซอร์', V), { action: 'viewer', op: 'external' });
  assert.deepStrictEqual(p('เล่น', VV), { action: 'viewer', op: 'play' });
  assert.deepStrictEqual(p('หยุด', VV), { action: 'viewer', op: 'pause' });
  assert.deepStrictEqual(p('หยุด', V), { action: 'stop' }, 'no video: หยุด still stops speaking');
  assert.deepStrictEqual(p('ข้าม 10 วิ', VV), { action: 'viewer', op: 'seek', n: 10 });
  assert.deepStrictEqual(p('ข้ามไปสิบวินาที', VV), { action: 'viewer', op: 'seek', n: 10 });
  assert.deepStrictEqual(p('ถอยหลังห้าวินาที', VV), { action: 'viewer', op: 'seek', n: -5 });
  assert.deepStrictEqual(p('เสียงดังขึ้น', VV), { action: 'viewer', op: 'volume', n: 15 });
  assert.deepStrictEqual(p('Open the second one', V), { action: 'viewer', op: 'open', n: 2 });
  assert.deepStrictEqual(p('ปิดกล้อง', V), { action: 'camera-off' });
  assert.strictEqual(p('เปิดอันที่สองแล้วสรุปให้หน่อย', V), null, 'longer requests go to Claude');
});
