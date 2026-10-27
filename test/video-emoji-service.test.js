'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MediaRegistry } = require('../lib/video/media');
const { VideoService } = require('../lib/video/service');
const { StyleStore } = require('../lib/video/styles');
const { SfxLibrary, SfxError } = require('../lib/video/sfx-library');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-emos-'));
const settle = () => new Promise((r) => setTimeout(r, 30));

function harness({ answer, fetchFails = [], renders = false } = {}) {
  const events = [];
  const asked = [];
  const prepared = [];
  const fetched = [];
  const ffmpeg = {
    async probe(f) { return /\.png|\.download/.test(f) && fetched.length ? { duration: 0.04, video: { width: 512, height: 512 }, audio: null } : { duration: 10, video: { width: 1080, height: 1920 }, audio: { codec: 'aac' } }; },
    async require() { return { ffmpeg: 'ffmpeg.exe' }; },
    async run(exe, args) { fs.writeFileSync(args[args.length - 1], 'PNG'); return { code: 0 }; },
  };
  const lib = new SfxLibrary({
    dir: tmp(), ffmpeg,
    fetchFn: async (u, dest) => { fetched.push(u); if (fetchFails.some((x) => u.includes(x))) throw new SfxError('เว็บตอบไม่ได้', 'NET'); fs.writeFileSync(dest, 'x'); return dest; },
  });
  const file = path.join(tmp(), 'a.mp4');
  fs.writeFileSync(file, 'x');
  const svc = new VideoService({
    registry: new MediaRegistry(), ffmpeg, sfxLibrary: lib, sfxDir: tmp(),
    analyzer: { async analyze() { return { silences: [], transcript: { model: 'm', segments: [{ start: 0, end: 4, text: 'ไฟลุกแล้ว' }, { start: 5, end: 9, text: 'ชอบมาก' }] }, summary: {}, warnings: [] }; } },
    styles: new StyleStore({ file: path.join(tmp(), 's.json') }),
    ask: async (o) => { asked.push(o); return typeof answer === 'function' ? answer(o) : answer; },
    hf: renders ? { prepare(id, spec) { prepared.push(spec); return tmp(); }, async render(dir, o) { fs.writeFileSync(o.out, 'mp4'); return o.out; } } : null,
    emit: (c, p) => events.push([c, p]),
  });
  const done = () => new Promise((resolve) => {
    const t = setInterval(() => {
      const last = events.filter(([c]) => c === 'video:sfx').pop();
      if (last && !last[1].running) { clearInterval(t); resolve(last[1].result); }
    }, 5);
  });
  return { svc, lib, events, asked, prepared, fetched, file, done };
}

test('emoji: a typed emoji is added to the library at once, without asking Claude', async () => {
  const h = harness({ answer: () => assert.fail('no question needed') });
  await h.svc.importFiles([h.file]);
  await settle();
  assert.strictEqual(h.svc.startEmoji({ query: ' 🔥 ' }).auto, false);
  const r = await h.done();
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.emoji, true);
  assert.deepStrictEqual(h.fetched, ['https://fonts.gstatic.com/s/e/notoemoji/latest/1f525/512.png']);
  const snap = h.svc.snapshot();
  assert.strictEqual(snap.images.length, 1);
  assert.deepStrictEqual(snap.sounds, [], 'a picture is not a sound');
  assert.strictEqual(snap.overlays.length, 0, 'typing one only fills the library');
  const list = h.svc.imageList();
  assert.match(list[0].url, /^app:\/\/jarvis\/media\//);
  assert.match(list[0].license, /Apache/);
  assert.strictEqual(JSON.stringify(h.svc.snapshot()).includes(os.tmpdir()), false);
});

test('emoji: a word makes Claude choose; asking for the whole clip puts them on the timeline in one undo step', async () => {
  const h = harness({ answer: (o) => (/ผู้ใช้อยากได้อิโมจิ/.test(o.prompt) ? '{"picks":[{"emoji":"😂","title":"ขำ"}]}' : '{"picks":[{"at":1,"emoji":"🔥","title":"ไฟ"},{"at":6,"emoji":"😍","title":"รัก"},{"at":6.5,"emoji":"💯"}]}') });
  await h.svc.importFiles([h.file]);
  await settle();
  h.svc.startEmoji({ query: 'หัวเราะ' });
  assert.strictEqual((await h.done()).ok, true);
  assert.strictEqual(h.asked.length, 1);
  assert.strictEqual(h.asked[0].webTools, undefined, 'no web search is needed: the picture address is built from the code');
  assert.strictEqual(h.svc.snapshot().overlays.length, 0);
  const before = h.svc.history.past.length;
  h.svc.startEmoji({});
  const r = await h.done();
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.assigned, 2, 'the one half a second after another is dropped');
  assert.match(h.asked[1].prompt, /0: ไฟลุกแล้ว/);
  assert.match(h.asked[1].prompt, /5: ชอบมาก/);
  const ov = h.svc.snapshot().overlays;
  assert.deepStrictEqual(ov.map((o) => [o.kind, o.start, o.x, o.y]), [['emoji', 1, 80, 24], ['emoji', 6, 20, 28]]);
  assert.ok(ov.every((o) => /^dl-[0-9a-f]{8}$/.test(o.image)));
  assert.strictEqual(h.svc.history.past.length, before + 1);
  h.svc.history.undo();
  assert.strictEqual(h.svc.snapshot().overlays.length, 0);
});

test('emoji: nothing to read, nothing usable, a failed download, cancel', async () => {
  const noText = harness({ answer: '{}' });
  noText.svc.sources.clear();
  assert.throws(() => noText.svc.startEmoji({}), /ยังไม่มีคลิป/);
  const bad = harness({ answer: 'ขอโทษ' });
  await bad.svc.importFiles([bad.file]);
  await settle();
  bad.svc.startEmoji({});
  assert.match((await bad.done()).error, /JSON/);
  const none = harness({ answer: '{"picks":[{"at":1,"emoji":"no emoji here"}]}' });
  await none.svc.importFiles([none.file]);
  await settle();
  none.svc.startEmoji({});
  assert.match((await none.done()).error, /ไม่ได้เลือกอิโมจิที่ใช้ได้/);
  const down = harness({ answer: '{}', fetchFails: ['/1f525/'] });
  await down.svc.importFiles([down.file]);
  await settle();
  down.svc.startEmoji({ query: '🔥' });
  assert.match((await down.done()).error, /โหลดภาพอิโมจิไม่สำเร็จ/);
  const slow = harness({ answer: () => new Promise(() => {}) });
  await slow.svc.importFiles([slow.file]);
  await settle();
  slow.svc.startEmoji({});
  setTimeout(() => slow.svc.cancelSfx(), 10);
  assert.strictEqual((await slow.done()).cancelled, true);
  assert.throws(() => { slow.svc.startEmoji({ query: '🔥' }); slow.svc.startEmoji({ query: '😂' }); }, /กำลังทำงานอยู่/);
});

test('emoji: the picture reaches the render, and removing it from the library removes its animations', async () => {
  const h = harness({ answer: '{}', renders: true });
  await h.svc.importFiles([h.file]);
  await settle();
  h.svc.startEmoji({ query: '🔥' });
  await h.done();
  const id = h.svc.imageList()[0].id;
  h.svc.edit({ op: 'overlay-add', overlay: { kind: 'emoji', image: id, x: 50, y: 50, size: 20, start: 1, end: 3 } });
  h.svc.edit({ op: 'overlay-add', overlay: { kind: 'title', text: 'อยู่ต่อ', start: 4, end: 6 } });
  h.svc.startRender({});
  await new Promise((r) => { const t = setInterval(() => { const l = h.events.filter(([c]) => c === 'video:render').pop(); if (l && !l[1].running) { clearInterval(t); r(); } }, 5); });
  const spec = h.prepared[0];
  assert.ok(spec.extra.some((x) => x.name === `img-${id}.png`));
  assert.match(spec.html, new RegExp(`<img src="assets/img-${id}\\.png"`));
  h.svc.removeSound(id);
  const s = h.svc.snapshot();
  assert.deepStrictEqual(s.overlays.map((o) => o.kind), ['title'], 'the emoji animation went with its picture');
  assert.deepStrictEqual(s.images, []);
  h.svc.history.undo();
  assert.strictEqual(h.svc.snapshot().overlays.length, 2, 'undo brings the animation back (its picture is gone: it shows nothing)');
});
