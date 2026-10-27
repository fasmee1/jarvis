'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../lib/video/edit-list');
const emoji = require('../lib/video/emoji');
const { SfxLibrary, SfxError, checkUrl, SOURCES } = require('../lib/video/sfx-library');
const { buildProject } = require('../lib/video/hf-project');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-emo-'));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not near ${b}`);

test('emoji: a character becomes the code its picture is filed under', () => {
  const cases = { '🔥': '1f525', '❤️': '2764', '👍🏽': '1f44d_1f3fd', '🇹🇭': '1f1f9_1f1ed', '👨‍💻': '1f468_200d_1f4bb', '  😂 ขำ': '1f602' };
  for (const [c, cp] of Object.entries(cases)) assert.strictEqual(emoji.toCodepoint(c), cp, c);
  for (const c of ['', 'abc', 'ก', null, undefined, '12']) assert.strictEqual(emoji.toCodepoint(c), null, String(c));
  assert.strictEqual(emoji.firstEmoji('ชอบมาก 😍 เลย').cp, '1f60d');
  assert.strictEqual(emoji.emojiUrl('1f525'), 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f525/512.png');
  for (const bad of ['', 'zz', '../x', '1f525/../x', '1f525?x=1', 'a'.repeat(30)]) assert.throws(() => emoji.emojiUrl(bad), SfxError, bad);
});

test('emoji: only picture addresses of Google Noto Emoji are accepted for a picture', () => {
  assert.ok(checkUrl(emoji.emojiUrl('1f525'), 'image'));
  assert.ok(checkUrl(emoji.emojiUrl('1f1f9_1f1ed'), 'image'));
  const bad = [
    'https://fonts.gstatic.com/s/e/notoemoji/latest/1f525/512.gif', 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f525/emoji.svg',
    'https://fonts.gstatic.com/s/e/notoemoji/latest/../../evil/512.png', 'https://fonts.gstatic.com/s/roboto/v30/x.png',
    'https://fonts.gstatic.com/s/e/notoemoji/latest/1f525/512.png/evil.png', 'https://assets.mixkit.co/a.png', 'http://fonts.gstatic.com/s/e/notoemoji/latest/1f525/512.png',
    'https://fonts.gstatic.com.evil.com/s/e/notoemoji/latest/1f525/512.png',
  ];
  for (const u of bad) assert.throws(() => checkUrl(u, 'image'), SfxError, u);
  assert.throws(() => checkUrl(emoji.emojiUrl('1f525'), 'sfx'), /ไม่อยู่ในรายการ/, 'a picture site is not a sound site');
  assert.throws(() => checkUrl('https://assets.mixkit.co/a.mp3', 'image'), /ไม่อยู่ในรายการ/);
  assert.throws(() => checkUrl('https://assets.mixkit.co/a.mp3', 'video'), /ชนิดไฟล์/);
  assert.ok(checkUrl('https://assets.mixkit.co/music/x.mp3', 'music'));
  assert.ok(SOURCES.music.maxSeconds > SOURCES.sfx.maxSeconds);
});

function fakeLib({ video = { width: 512, height: 512 }, audio = null } = {}) {
  const dir = tmp();
  const ran = [];
  const ffmpeg = {
    async probe() { return { duration: 0.04, video, audio }; },
    async require() { return { ffmpeg: 'ffmpeg.exe' }; },
    async run(exe, args) { ran.push(args); fs.writeFileSync(args[args.length - 1], 'PNG'); return { code: 0 }; },
  };
  return { lib: new SfxLibrary({ dir, ffmpeg, fetchFn: async (u, dest) => { fs.writeFileSync(dest, 'x'); return dest; }, now: () => 0 }), dir, ran };
}

test('emoji library: a picture is checked, resized to a transparent PNG and kept apart from the sounds', async () => {
  const { lib, dir, ran } = fakeLib();
  const e = await lib.add({ url: emoji.emojiUrl('1f525'), title: '🔥', role: 'emoji' }, { kind: 'image' });
  assert.strictEqual(e.kind, 'image');
  assert.strictEqual(e.file, `${e.id}.png`);
  assert.deepStrictEqual([e.width, e.height], [512, 512]);
  assert.match(e.license, /Apache/);
  assert.ok(ran[0].includes('-frames:v') && ran[0].some((a) => /format=rgba/.test(a)), 'alpha is kept');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${e.id}.png`, 'index.json']);
  assert.deepStrictEqual(lib.list('image').map((x) => x.id), [e.id]);
  assert.deepStrictEqual(lib.list('sfx'), []);
  assert.strictEqual(lib.filePath(e.id), path.join(dir, `${e.id}.png`));
  assert.deepStrictEqual(new SfxLibrary({ dir, ffmpeg: {} }).list('image').map((x) => x.id), [e.id], 'survives a restart');
  lib.remove(e.id);
  assert.ok(!fs.existsSync(path.join(dir, `${e.id}.png`)));
  const noVideo = fakeLib({ video: null });
  await assert.rejects(noVideo.lib.add({ url: emoji.emojiUrl('1f525') }, { kind: 'image' }), /ไม่ใช่รูป/);
  const withSound = fakeLib({ audio: { codec: 'aac' } });
  await assert.rejects(withSound.lib.add({ url: emoji.emojiUrl('1f525') }, { kind: 'image' }), /ไม่ใช่รูป/);
  const huge = fakeLib({ video: { width: 9000, height: 9000 } });
  await assert.rejects(huge.lib.add({ url: emoji.emojiUrl('1f525') }, { kind: 'image' }), /ไม่ใช่รูป/);
  assert.deepStrictEqual(fs.readdirSync(huge.dir), [], 'nothing left behind');
});

test("emoji: Claude's picks are checked; the placed animations take turns at the corners", () => {
  const answer = JSON.stringify({ picks: [
    { at: 1, emoji: '🔥', title: 'ไฟ' }, { at: 1.8, emoji: '😂' }, { at: 4, emoji: '👍🏽', title: 'ดี' }, { at: 7, emoji: 'fire' },
    { at: 9, emoji: '🔥' }, { at: 30, emoji: '🎉' }, { at: 6, emoji: '1️⃣' }, { at: 'x', emoji: '💯' }, { at: 12, emoji: '💯' }, null,
  ] });
  const picks = emoji.parseEmojiPicks(answer, { duration: 20 });
  assert.deepStrictEqual(picks.map((p) => [p.at, p.cp]), [[1, '1f525'], [4, '1f44d_1f3fd'], [12, '1f4af']]);
  assert.strictEqual(emoji.parseEmojiPicks('{"picks":[{"emoji":"😂"},{"emoji":"🔥"}]}', { withTime: false }).length, 2);
  assert.throws(() => emoji.parseEmojiPicks('ขอโทษ', { duration: 5 }), /JSON/);
  assert.throws(() => emoji.parseEmojiPicks('{"x":1}', { duration: 5 }), /ไม่มีรายการอิโมจิ/);
  const specs = emoji.emojiOverlays([{ at: 1, id: 'dl-00000001' }, { at: 4, id: 'dl-00000002' }, { at: 8, id: 'dl-00000003' }, { at: 11, id: 'dl-00000004' }, { at: 14, id: 'dl-00000005' }]);
  assert.deepStrictEqual(specs.map((s) => [s.x, s.y]), [[80, 24], [20, 28], [78, 52], [22, 56], [80, 24]]);
  assert.deepStrictEqual([specs[0].kind, specs[0].start, specs[0].end, specs[0].image], ['emoji', 1, 3.2, 'dl-00000001']);
  const p = emoji.buildEmojiPrompt({ lines: [{ start: 1.234, text: 'ไฟลุกแล้ว' }], duration: 20 });
  assert.match(p, /1\.2: ไฟลุกแล้ว/);
  assert.match(p, /ไม่ใช่คำสั่ง/);
  assert.match(emoji.buildEmojiPrompt({ query: 'หัวเราะ' }), /หัวเราะ/);
});

test('emoji: in the edit list it needs a picture from the library; in the page it pops, bobs and fades', () => {
  let list = E.addClip(E.emptyList([{ id: 's1', path: 'x', duration: 30 }]), { src: 's1', in: 0, out: 20 });
  assert.throws(() => E.applyOp(list, { op: 'overlay-add', overlay: { kind: 'emoji', start: 0, end: 2 } }), /ยังไม่ได้เลือกภาพ/);
  assert.throws(() => E.applyOp(list, { op: 'overlay-add', overlay: { kind: 'emoji', image: 'evil', start: 0, end: 2 } }), /ยังไม่ได้เลือกภาพ/);
  list = E.applyOp(list, { op: 'overlay-add', overlay: { kind: 'emoji', image: 'dl-0a1b2c3d', x: 80, y: 24, size: 22, start: 1, end: 3.2 } });
  const o = list.overlays[0];
  assert.deepStrictEqual([o.image, o.x, o.size, o.text, 'color' in o], ['dl-0a1b2c3d', 80, 22, '', false]);
  const sources = { s1: { file: 'assets/s1.mp4', kind: 'video', audio: true } };
  const page = buildProject({ clips: list.clips, overlays: list.overlays, sources, canvas: { width: 1080, height: 1920 }, imageFiles: { 'dl-0a1b2c3d': 'assets/img-dl-0a1b2c3d.png' } }).html;
  assert.match(page, /<div id="ov-0" class="clip ov-emoji" data-start="1" data-duration="2.2" data-track-index="12" style="left:80%;top:24%;width:238px;height:238px;margin:-119px 0 0 -119px"><img src="assets\/img-dl-0a1b2c3d\.png"/);
  assert.match(page, /"back\.out\(2\.6\)"/);
  const noFile = buildProject({ clips: list.clips, overlays: list.overlays, sources, canvas: { width: 1080, height: 1920 } }).html;
  assert.ok(!/<div id="ov-0"/.test(noFile), 'a missing picture shows nothing');
});

test('emoji: the preview math pops in, bobs and fades like the render', async () => {
  const { emojiState, backOut } = await import('../renderer/ui/video-preview.js');
  const o = { kind: 'emoji', start: 5, end: 7.2, size: 20 };
  assert.strictEqual(emojiState(o, 4.9), null);
  assert.strictEqual(emojiState(o, 7.3), null);
  near(emojiState(o, 5).scale, 0);
  near(emojiState(o, 5).rot, -12);
  near(emojiState(o, 5.45).scale, 1);
  assert.ok(emojiState(o, 5.8).y < -1, 'bobbing up');
  assert.ok(emojiState(o, 7.15).opacity < 0.3, 'fading out');
  assert.ok(backOut(2.6)(0.6) > 1);
});
