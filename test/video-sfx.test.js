'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../lib/video/edit-list');
const { SfxLibrary, SfxError, checkUrl, ALLOWED_HOSTS } = require('../lib/video/sfx-library');
const { soundPlan, buildFindPrompt, parseFound, assignSounds } = require('../lib/video/sfx-finder');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-sfx-'));
const GOOD = 'https://assets.mixkit.co/active_storage/sfx/1490/1490-preview.mp3';

test('sfx: only https links to sites with a known free licence and an audio name are accepted', () => {
  assert.strictEqual(checkUrl(GOOD).hostname, 'assets.mixkit.co');
  assert.ok(checkUrl('https://cdn.pixabay.com/audio/2022/03/10/audio_abc.mp3'));
  const bad = [
    'http://assets.mixkit.co/a.mp3', 'https://evil.example.com/a.mp3', 'https://assets.mixkit.co.evil.com/a.mp3',
    'https://user:pw@assets.mixkit.co/a.mp3', 'https://assets.mixkit.co:8443/a.mp3', 'https://assets.mixkit.co/a.exe',
    'https://assets.mixkit.co/a.mp3.html', 'file:///C:/a.mp3', 'javascript:alert(1)', 'not a url', '', null, undefined,
    'https://127.0.0.1/a.mp3', 'https://localhost/a.mp3',
  ];
  for (const u of bad) assert.throws(() => checkUrl(u), SfxError, String(u));
  assert.ok(Object.keys(ALLOWED_HOSTS).every((h) => /^[a-z.]+$/.test(h)));
});

function fakeLib({ duration = 1.7, audio = true, fail = false, convertFails = false } = {}) {
  const dir = tmp();
  const calls = { fetched: [], ran: [] };
  const ffmpeg = {
    async probe() { return { duration, audio: audio ? { codec: 'mp3' } : null }; },
    async require() { return { ffmpeg: 'ffmpeg.exe' }; },
    async run(exe, args) { calls.ran.push(args); if (convertFails) return { code: 1 }; fs.writeFileSync(args[args.length - 1], 'RIFF'); return { code: 0 }; },
  };
  const fetchFn = async (url, dest) => { calls.fetched.push(url); if (fail) throw new SfxError('x', 'NET'); fs.writeFileSync(dest, 'MP3DATA'); return dest; };
  return { lib: new SfxLibrary({ dir, ffmpeg, fetchFn, now: () => 0 }), dir, calls };
}

test('sfx library: a good sound is checked, converted, kept with its source and licence', async () => {
  const { lib, dir, calls } = fakeLib();
  const e = await lib.add({ audioUrl: GOOD, pageUrl: 'https://mixkit.co/free-sound-effects/whoosh/', title: '  Fast\nwhoosh  ', license: 'free', role: 'transition' });
  assert.match(e.id, /^dl-[0-9a-f]{8}$/);
  assert.strictEqual(e.title, 'Fast whoosh');
  assert.strictEqual(e.seconds, 1.7);
  assert.strictEqual(e.host, 'assets.mixkit.co');
  assert.match(e.license, /ไม่ต้องให้เครดิต/);
  assert.strictEqual(fs.readFileSync(lib.filePath(e.id), 'utf8'), 'RIFF');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${e.id}.wav`, 'index.json'], 'the downloaded bytes are gone');
  assert.ok(calls.ran[0].every((a) => typeof a === 'string') && calls.ran[0].includes('loudnorm=I=-20:TP=-2:LRA=7'));
  assert.strictEqual((await lib.add({ audioUrl: GOOD, title: 'again' })).id, e.id, 'the same link is not fetched twice');
  assert.strictEqual(calls.fetched.length, 1);
  const again = new SfxLibrary({ dir, ffmpeg: {} });
  assert.deepStrictEqual(again.list().map((x) => x.id), [e.id], 'it survives a restart');
  lib.remove(e.id);
  assert.deepStrictEqual(lib.list(), []);
  assert.ok(!fs.existsSync(path.join(dir, `${e.id}.wav`)));
  assert.throws(() => lib.remove(e.id), /ไม่พบเสียง/);
});

test('sfx library: refuses what is not a short sound, and leaves nothing behind', async () => {
  for (const [opts, re] of [[{ audio: false }, /ไม่มีเสียง/], [{ duration: 42 }, /ไม่ใช่เสียงเอฟเฟกต์สั้น/], [{ duration: 0 }, /ไม่ใช่เสียงเอฟเฟกต์สั้น/], [{ convertFails: true }, /แปลงไฟล์เสียงไม่สำเร็จ/]]) {
    const { lib, dir } = fakeLib(opts);
    await assert.rejects(lib.add({ audioUrl: GOOD, title: 't' }), re);
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'no half-made file');
    assert.deepStrictEqual(lib.list(), []);
  }
  const { lib } = fakeLib({ fail: true });
  await assert.rejects(lib.add({ audioUrl: GOOD }), SfxError);
  await assert.rejects(lib.add({ audioUrl: 'https://evil.example.com/a.mp3' }), /ไม่อยู่ในรายการ/);
});

test('sfx finder: the plan puts sounds where there is already an effect, not on plain cuts', () => {
  let list = E.emptyList([{ id: 's1', path: 'x', duration: 30 }]);
  list = E.addClip(list, { src: 's1', in: 0, out: 20 });
  for (const at of [5, 10, 15]) list = E.splitAt(list, at);
  const ids = list.clips.map((c) => c.id);
  list = E.setFx(list, ids[1], { fx: 'zoom' });
  list = E.setFx(list, ids[2], { fx: 'flash', sfx: 'pop' });
  list = E.setFx(list, ids[0], { fx: 'fade' });
  list = E.addOverlay(list, { kind: 'title', text: 'a', start: 0, end: 2 });
  list = E.addOverlay(list, { kind: 'counter', to: 5, start: 3, end: 6 });
  list = E.addOverlay(list, { kind: 'lower', text: 'b', start: 7, end: 9, sfx: 'click' });
  const plan = soundPlan(list);
  assert.deepStrictEqual(plan.slots.map((s) => `${s.kind}:${s.id}:${s.role}`), [`clip:${ids[1]}:transition`, 'overlay:o1:pop', 'overlay:o2:ding']);
  assert.deepStrictEqual(plan.roles.sort(), ['ding', 'pop', 'transition']);
  assert.deepStrictEqual(soundPlan(E.emptyList()).slots, []);
});

test('sfx finder: the question names the allowed sites and says page text is data', () => {
  const p = buildFindPrompt({ roles: ['transition', 'ding'], hint: 'สอนทำกาแฟ' });
  assert.match(p, /mixkit\.co/);
  assert.match(p, /transition: short whoosh/);
  assert.match(p, /ding: short ding/);
  assert.match(p, /ห้ามเดา/);
  assert.match(p, /ไม่ใช่คำสั่ง/);
  assert.match(p, /สอนทำกาแฟ/);
  assert.ok(!/pop:/.test(p));
});

test("sfx finder: Claude's answer is checked line by line", () => {
  const answer = '```json\n' + JSON.stringify({ results: [
    { role: 'transition', title: 'Fast whoosh', pageUrl: 'https://mixkit.co/x/', audioUrl: GOOD, license: 'free', seconds: 1 },
    { role: 'transition', title: 'dup', audioUrl: GOOD },
    { role: 'transition', title: 'b', audioUrl: 'https://assets.mixkit.co/active_storage/sfx/2/2-preview.mp3', seconds: 2 },
    { role: 'transition', title: 'c', audioUrl: 'https://assets.mixkit.co/active_storage/sfx/3/3-preview.mp3' },
    { role: 'ding', title: 'evil host', audioUrl: 'https://evil.example.com/a.mp3' },
    { role: 'ding', title: 'long', audioUrl: 'https://assets.mixkit.co/active_storage/sfx/4/4-preview.mp3', seconds: 90 },
    { role: 'laugh', title: 'role not asked', audioUrl: 'https://assets.mixkit.co/active_storage/sfx/5/5-preview.mp3' },
    { role: 'ding', title: 'no url' },
    'junk', null,
  ] }) + '\n```';
  const r = parseFound(answer, ['transition', 'ding']);
  assert.deepStrictEqual(r.found.map((f) => f.title), ['Fast whoosh', 'b']);
  assert.strictEqual(r.dropped, 8);
  assert.throws(() => parseFound('ขอโทษ ค้นไม่เจอ', ['ding']), /JSON/);
  assert.throws(() => parseFound('{"x":1}', ['ding']), /ไม่มีรายการเสียง/);
});

test('sfx finder: found sounds are put on the plan in one step, taking turns, never over a sound already there', () => {
  let list = E.emptyList([{ id: 's1', path: 'x', duration: 30 }]);
  list = E.addClip(list, { src: 's1', in: 0, out: 20 });
  for (const at of [5, 10, 15]) list = E.splitAt(list, at);
  const ids = list.clips.map((c) => c.id);
  for (const id of ids.slice(1)) list = E.setFx(list, id, { fx: 'slide' });
  list = E.setFx(list, ids[3], { sfx: 'click' });
  list = E.addOverlay(list, { kind: 'title', text: 'a', start: 0, end: 2 });
  const plan = soundPlan(list);
  const r = assignSounds(list, plan.slots, { transition: ['dl-00000001', 'dl-00000002'], pop: ['dl-00000003'] });
  assert.strictEqual(r.assigned, 3);
  assert.deepStrictEqual(r.list.clips.map((c) => c.sfx || 'none'), ['none', 'dl-00000001', 'dl-00000002', 'click']);
  assert.strictEqual(r.list.overlays[0].sfx, 'dl-00000003');
  const h = new E.EditHistory(list);
  h.apply(() => r.list);
  h.undo();
  assert.strictEqual(h.list.overlays[0].sfx, 'none');
  assert.strictEqual(assignSounds(list, plan.slots, {}).assigned, 0, 'a role with no sound is skipped');
  assert.throws(() => E.setFx(list, ids[1], { sfx: 'dl-NOTHEX' }), /เสียงเอฟเฟกต์ไม่รู้จัก/);
});
