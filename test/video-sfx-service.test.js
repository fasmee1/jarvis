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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-sfxs-'));
const url = (n) => `https://assets.mixkit.co/active_storage/sfx/${n}/${n}-preview.mp3`;
const settle = () => new Promise((r) => setTimeout(r, 30));

function harness({ answer, fetchFails = [], renders = false } = {}) {
  const events = [];
  const asked = [];
  const prepared = [];
  const ffmpeg = {
    async probe() { return { duration: 10, video: { width: 1080, height: 1920 }, audio: { codec: 'aac' } }; },
    async require() { return { ffmpeg: 'ffmpeg.exe' }; },
    async run(exe, args) { fs.writeFileSync(args[args.length - 1], 'RIFF'); return { code: 0 }; },
  };
  const lib = new SfxLibrary({
    dir: tmp(), ffmpeg,
    fetchFn: async (u, dest) => { if (fetchFails.some((x) => u.includes(x))) throw new SfxError('เว็บตอบไม่ได้', 'NET'); fs.writeFileSync(dest, 'MP3'); return dest; },
  });
  const file = path.join(tmp(), 'a.mp4');
  fs.writeFileSync(file, 'x');
  const svc = new VideoService({
    registry: new MediaRegistry(), ffmpeg, sfxLibrary: lib, sfxDir: tmp(),
    analyzer: { async analyze() { return { silences: [], transcript: { model: 'm', segments: [{ start: 0, end: 4, text: 'สอนทำกาแฟ' }] }, summary: {}, warnings: [] }; } },
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
  return { svc, lib, events, asked, prepared, file, done };
}

const reply = (results) => '```json\n' + JSON.stringify({ results }) + '\n```';

test('sounds: a search by words fetches what Claude suggests, only from allowed sites, and keeps the sound', async () => {
  const h = harness({ answer: reply([
    { role: 'custom', title: 'Box open', pageUrl: 'https://mixkit.co/free-sound-effects/box/', audioUrl: url(11), license: 'free, no attribution' },
    { role: 'custom', title: 'Evil', audioUrl: 'https://evil.example.com/x.mp3' },
  ]) });
  await h.svc.importFiles([h.file]);
  await settle();
  assert.throws(() => h.svc.startSfxSearch({ query: '' }), /ยังไม่มีเอฟเฟกต์ภาพหรืออนิเมชั่น/);
  const r = h.svc.startSfxSearch({ query: '  เสียง\nเปิดกล่อง  ' });
  assert.strictEqual(r.auto, false);
  assert.strictEqual(h.svc.snapshot().sfx.label, 'ค้นหาเสียง "เสียง เปิดกล่อง"');
  assert.throws(() => h.svc.startSfxSearch({ query: 'อีกอัน' }), /กำลังหาเสียงอยู่/);
  const res = await h.done();
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.added, ['Box open']);
  assert.strictEqual(h.asked[0].webTools, true, 'the web is only open for this question');
  assert.match(h.asked[0].prompt, /sound effect: เสียง เปิดกล่อง/);
  const snap = h.svc.snapshot();
  assert.deepStrictEqual(snap.sounds.map((x) => x.label), ['Box open']);
  const list = await h.svc.soundList();
  const whoosh = list.find((x) => x.id === 'whoosh');
  assert.ok(whoosh && !whoosh.custom);
  assert.match(whoosh.url, /^app:\/\/jarvis\/media\//, 'built-in sounds can be played in the preview too');
  assert.strictEqual(whoosh.lead, 0.12);
  assert.strictEqual(list.find((x) => x.id === 'none').url, undefined);
  const mine = list.find((x) => x.custom);
  assert.match(mine.url, /^app:\/\/jarvis\/media\//);
  assert.match(mine.license, /ไม่ต้องให้เครดิต/);
  assert.strictEqual(JSON.stringify(snap).includes(os.tmpdir()), false, 'no disk path in the snapshot');
});

test('sounds: "choose for the whole clip" searches only the roles the timeline needs, and assigns in one undo step', async () => {
  const h = harness({ answer: reply([
    { role: 'transition', title: 'Whoosh A', audioUrl: url(21) },
    { role: 'transition', title: 'Whoosh B', audioUrl: url(22) },
    { role: 'pop', title: 'Pop', audioUrl: url(23) },
  ]) });
  await h.svc.importFiles([h.file]);
  await settle();
  h.svc.edit({ op: 'split', at: 3 });
  h.svc.edit({ op: 'split', at: 6 });
  const ids = h.svc.snapshot().clips.map((c) => c.id);
  h.svc.edit({ op: 'fx', id: ids[1], fx: 'zoom' });
  h.svc.edit({ op: 'fx', id: ids[2], fx: 'slide' });
  h.svc.edit({ op: 'overlay-add', overlay: { kind: 'title', text: 'หัวข้อ', start: 0, end: 2 } });
  const undoBefore = h.svc.history.past.length;
  h.svc.startSfxSearch({});
  const res = await h.done();
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.auto, true);
  assert.strictEqual(res.assigned, 3);
  assert.match(h.asked[0].prompt, /transition: short whoosh/);
  assert.match(h.asked[0].prompt, /pop: short pop/);
  assert.ok(!/ding:/.test(h.asked[0].prompt), 'no counter, no ding');
  assert.match(h.asked[0].prompt, /สอนทำกาแฟ/, 'the clip is described to the search');
  const snap = h.svc.snapshot();
  const [a, b] = snap.sounds.filter((x) => /Whoosh/.test(x.label)).map((x) => x.id);
  assert.deepStrictEqual(snap.clips.map((c) => c.sfx || 'none'), ['none', a, b]);
  assert.strictEqual(snap.overlays[0].sfx, snap.sounds.find((x) => x.label === 'Pop').id);
  assert.strictEqual(h.svc.history.past.length, undoBefore + 1, 'one undo step for all of it');
  h.svc.history.undo();
  assert.deepStrictEqual(h.svc.snapshot().clips.map((c) => c.sfx || 'none'), ['none', 'none', 'none']);
  // asking again: the library already has those roles, so nothing is searched
  h.svc.history.redo();
  h.svc.edit({ op: 'fx', id: ids[2], sfx: 'none' });
  h.svc.startSfxSearch({});
  const again = await h.done();
  assert.strictEqual(again.ok, true, again.error);
  assert.strictEqual(h.asked.length, 1, 'no second web search');
  assert.strictEqual(again.assigned, 1);
});

test('sounds: failures are said plainly; one bad link does not lose the good ones; cancel stops', async () => {
  const bad = harness({ answer: 'ขอโทษ ค้นไม่ได้' });
  await bad.svc.importFiles([bad.file]);
  await settle();
  bad.svc.startSfxSearch({ query: 'whoosh' });
  const r1 = await bad.done();
  assert.strictEqual(r1.ok, false);
  assert.match(r1.error, /JSON/);

  const none = harness({ answer: reply([{ role: 'custom', title: 'x', audioUrl: 'https://evil.example.com/a.mp3' }]) });
  await none.svc.importFiles([none.file]);
  await settle();
  none.svc.startSfxSearch({ query: 'whoosh' });
  assert.match((await none.done()).error, /ไม่เจอเสียงที่ใบอนุญาตชัดเจน/);

  const part = harness({ answer: reply([{ role: 'custom', title: 'Good', audioUrl: url(31) }, { role: 'custom', title: 'Down', audioUrl: url(32) }]), fetchFails: ['/32/'] });
  await part.svc.importFiles([part.file]);
  await settle();
  part.svc.startSfxSearch({ query: 'pop' });
  const r3 = await part.done();
  assert.strictEqual(r3.ok, true);
  assert.deepStrictEqual(r3.added, ['Good']);
  assert.match(r3.failed[0], /Down: เว็บตอบไม่ได้/);

  const slow = harness({ answer: () => new Promise(() => {}) });
  await slow.svc.importFiles([slow.file]);
  await settle();
  slow.svc.startSfxSearch({ query: 'whoosh' });
  setTimeout(() => slow.svc.cancelSfx(), 10);
  assert.strictEqual((await slow.done()).cancelled, true);
  assert.strictEqual(slow.svc.snapshot().sfx, null);
});

test('sounds: a downloaded sound reaches the render; removing it clears where it was used', async () => {
  const h = harness({ answer: reply([{ role: 'custom', title: 'Box', audioUrl: url(41) }]), renders: true });
  await h.svc.importFiles([h.file]);
  await settle();
  h.svc.startSfxSearch({ query: 'box' });
  await h.done();
  const id = h.svc.snapshot().sounds[0].id;
  h.svc.edit({ op: 'split', at: 5 });
  h.svc.edit({ op: 'fx', id: h.svc.snapshot().clips[1].id, fx: 'fade', sfx: id });
  h.svc.edit({ op: 'overlay-add', overlay: { kind: 'title', text: 'x', start: 1, end: 3, sfx: id } });
  h.svc.startRender({});
  await new Promise((r) => { const t = setInterval(() => { const l = h.events.filter(([c]) => c === 'video:render').pop(); if (l && !l[1].running) { clearInterval(t); r(); } }, 5); });
  const spec = h.prepared[0];
  assert.deepStrictEqual(spec.extra.map((x) => x.name), [`sfx-${id}.wav`]);
  assert.match(spec.html, new RegExp(`<audio id="sfx-1" src="assets/sfx-${id}\\.wav" data-start="5" data-duration="1\\.7"`.replace('1\\.7', '[0-9.]+')));
  assert.match(spec.html, /<audio id="ovsfx-0"/);
  h.svc.removeSound(id);
  const s = h.svc.snapshot();
  assert.deepStrictEqual(s.sounds, []);
  assert.strictEqual(s.clips[1].sfx, 'none');
  assert.strictEqual(s.overlays[0].sfx, 'none');
  assert.throws(() => h.svc.removeSound(id), /ไม่พบไฟล์นี้ในคลัง/);
});
