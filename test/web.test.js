'use strict';
// Web Viewer: pure helpers (address bar, site names, bounds, schemes),
// per-site permission memory, and the web voice commands.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromeUserAgent, normalizeAddress, resolveSite, dipBounds, isLoadable, isForbidden, splitAddress } = require('../lib/web/web-utils');
const { WebPermissions, permissionKeys } = require('../lib/web/permissions');

test('user agent looks like desktop Chrome, without Electron', () => {
  const ua = chromeUserAgent('140.0.7339.41', 'win32');
  assert.match(ua, /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/140\.0\.0\.0 Safari\/537\.36$/);
  assert.doesNotMatch(ua, /Electron/i);
});

test('address bar input becomes a URL or a search', () => {
  assert.strictEqual(normalizeAddress('github.com'), 'https://github.com/');
  assert.strictEqual(normalizeAddress('https://pantip.com/topic/1'), 'https://pantip.com/topic/1');
  assert.strictEqual(normalizeAddress('localhost:3000'), 'http://localhost:3000/');
  assert.strictEqual(normalizeAddress('192.168.1.1'), 'http://192.168.1.1/');
  assert.strictEqual(normalizeAddress('ไทยรัฐ.com'), new URL('https://ไทยรัฐ.com').toString());
  assert.match(normalizeAddress('ราคาทอง วันนี้'), /^https:\/\/www\.google\.com\/search\?q=/);
  assert.match(normalizeAddress('javascript:alert(1)'), /^https:\/\/www\.google\.com\/search\?q=/);
  assert.match(normalizeAddress('file:///C:/x'), /^https:\/\/www\.google\.com\/search\?q=/);
  assert.strictEqual(normalizeAddress('  '), null);
});

test('spoken site names resolve; unknown names are left to Claude', () => {
  assert.strictEqual(resolveSite('pantip'), 'https://pantip.com/');
  assert.strictEqual(resolveSite('พันทิป'), 'https://pantip.com/');
  assert.strictEqual(resolveSite('GitHub'), 'https://github.com/');
  assert.strictEqual(resolveSite('github.com'), 'https://github.com/');
  assert.strictEqual(resolveSite('docs.python.org/3/'), 'https://docs.python.org/3/');
  assert.strictEqual(resolveSite('ร้านกาแฟ'), null);
  assert.strictEqual(resolveSite(''), null);
});

test('renderer rects become integer DIP bounds', () => {
  assert.deepStrictEqual(dipBounds({ x: 192, y: 133.2, width: 737.27, height: 619.6 }), { x: 192, y: 133, width: 737, height: 620 });
  assert.deepStrictEqual(dipBounds({ x: 10, y: 10, width: 100, height: 50 }, 1.5), { x: 15, y: 15, width: 150, height: 75 });
  assert.strictEqual(dipBounds({ x: 0, y: 0, width: 0, height: 10 }), null);
  assert.strictEqual(dipBounds(null), null);
});

test('only web schemes load in a tab; internal schemes are forbidden', () => {
  for (const u of ['https://a.com', 'http://a.com', 'about:blank']) assert.ok(isLoadable(u), u);
  for (const u of ['mailto:a@b.c', 'zoommtg://x', 'file:///C:/', 'chrome://settings']) assert.ok(!isLoadable(u), u);
  for (const u of ['file:///C:/', 'chrome://gpu', 'devtools://x', 'app://jarvis/renderer/index.html', 'javascript:1']) assert.ok(isForbidden(u), u);
  for (const u of ['mailto:a@b.c', 'https://a.com']) assert.ok(!isForbidden(u), u);
});

test('address display: domain prominent, path dimmed', () => {
  assert.deepStrictEqual(splitAddress('https://www.pantip.com/topic/1?x=2'), { secure: true, host: 'pantip.com', rest: '/topic/1?x=2' });
  assert.deepStrictEqual(splitAddress('http://example.com/'), { secure: false, host: 'example.com', rest: '' });
});

test('per-site permissions are remembered only for askable kinds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-perm-'));
  const p = new WebPermissions(dir);
  assert.strictEqual(p.get('https://a.com', 'geolocation'), undefined);
  p.set('https://a.com', 'geolocation', true);
  p.set('https://a.com', 'midi', true); // not askable → ignored
  p.set('not an origin', 'geolocation', true);
  const q = new WebPermissions(dir);
  assert.strictEqual(q.get('https://a.com', 'geolocation'), true);
  assert.strictEqual(q.get('https://a.com', 'midi'), undefined);
  q.clear();
  assert.strictEqual(new WebPermissions(dir).get('https://a.com', 'geolocation'), undefined);
  assert.deepStrictEqual(permissionKeys('media', { mediaTypes: ['video'] }), ['media:video']);
  assert.deepStrictEqual(permissionKeys('media', {}), ['media:video', 'media:audio']);
  assert.deepStrictEqual(permissionKeys('pointerLock'), []);
});

test('web voice commands (only while a page is the current tab)', async () => {
  const { parseCommand } = await import('../renderer/handsfree/commands.js');
  const W = { viewer: true, web: true };
  const op = (t, c = W) => { const r = parseCommand(t, c); return r && (r.op || r.action); };
  assert.strictEqual(op('สรุปหน้านี้'), 'summarize');
  assert.strictEqual(op('ไปบนสุด'), 'top');
  assert.strictEqual(op('ย้อนกลับ'), 'back');
  assert.strictEqual(op('ไปข้างหน้า'), 'forward');
  assert.strictEqual(op('รีโหลด'), 'reload');
  assert.strictEqual(op('แท็บถัดไป'), 'next-tab');
  assert.strictEqual(op('ปิดแท็บ'), 'close-tab');
  assert.strictEqual(op('ขยายเว็บ'), 'expand');
  assert.strictEqual(op('อ่านต่อ'), 'more');
  assert.strictEqual(op('เลื่อนลง'), 'scroll');
  assert.strictEqual(op('เปิดในเบราว์เซอร์'), 'external');
  assert.strictEqual(op('ปิดหน้าจอ'), 'close');
  assert.deepStrictEqual(parseCommand('คลิกลิงก์ ราคาทองวันนี้ครับ', W), { action: 'viewer', op: 'click', text: 'ราคาทองวันนี้' });
  assert.deepStrictEqual(parseCommand('click the link Pricing', W), { action: 'viewer', op: 'click', text: 'Pricing' });
  // without a web page, "ย้อนกลับ" keeps its Result Viewer meaning
  assert.strictEqual(op('ย้อนกลับ', { viewer: true }), 'prev');
});

test('"เปิดเว็บ …" / "ไปที่ …" from anywhere', async () => {
  const { parseCommand } = await import('../renderer/handsfree/commands.js');
  assert.deepStrictEqual(parseCommand('จาร์วิส เปิดเว็บ pantip'), { action: 'open-site', name: 'pantip', text: 'เปิดเว็บ pantip' });
  assert.strictEqual(parseCommand('ไปที่ github.com').name, 'github.com');
  assert.strictEqual(parseCommand('open github').name, 'github');
  assert.strictEqual(parseCommand('ไปที่ร้านกาแฟใกล้ๆ แล้วสั่งกาแฟ'), null);
  assert.strictEqual(parseCommand('เปิดกล้อง').action, 'camera-on');
});
