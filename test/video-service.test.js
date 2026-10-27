'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MediaRegistry, checkMediaFile, parseRange } = require('../lib/video/media');
const { VideoService } = require('../lib/video/service');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-svc-test-'));
function file(name, bytes = 'x') {
  const f = path.join(tmp(), name);
  fs.writeFileSync(f, bytes);
  return f;
}

test('media: only real video/audio files with a full path', () => {
  assert.throws(() => checkMediaFile('clip.mp4'), /ที่อยู่เต็ม/);
  assert.throws(() => checkMediaFile(file('a.exe')), /รองรับเฉพาะ/);
  assert.throws(() => checkMediaFile(file('notes.txt')), /รองรับเฉพาะ/);
  assert.throws(() => checkMediaFile(path.join(tmp(), 'gone.mp4')), /ไม่พบไฟล์/);
  const dir = path.join(tmp(), 'folder.mp4');
  fs.mkdirSync(dir);
  assert.throws(() => checkMediaFile(dir), /ไม่พบไฟล์/);
  const f = file('A Clip.MOV');
  assert.strictEqual(checkMediaFile(f), path.resolve(f));
});

test('media: range header parsing', () => {
  assert.strictEqual(parseRange(undefined, 100), null);
  assert.deepStrictEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepStrictEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepStrictEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepStrictEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepStrictEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.strictEqual(parseRange('bytes=100-', 100), 'invalid');
  assert.strictEqual(parseRange('bytes=20-10', 100), 'invalid');
  assert.strictEqual(parseRange('bytes=-0', 100), 'invalid');
  assert.strictEqual(parseRange('bytes=0-1,5-6', 100), null); // multi-range: whole file instead
  assert.strictEqual(parseRange('items=0-1', 100), null);
});

test('media: random token URL, same file same token, unknown tokens refused', () => {
  const r = new MediaRegistry();
  const f = file('clip.mp4', '0123456789');
  const a = r.add(f);
  assert.match(a.url, /^app:\/\/jarvis\/media\/[0-9a-f]{32}$/);
  assert.ok(!a.url.includes('clip'));
  assert.strictEqual(r.add(f).token, a.token);
  assert.strictEqual(a.kind, 'video');
  assert.strictEqual(r.add(file('song.mp3')).kind, 'audio');
  assert.strictEqual(r.get('../etc'), null);
  assert.strictEqual(r.get('0'.repeat(32)), null);
});

test('media: serves whole file, ranges with 206, bad ranges with 416, unknown with 404', async () => {
  const r = new MediaRegistry();
  const { token } = r.add(file('clip.mp4', '0123456789'));
  const whole = r.respond(`/media/${token}`, new Headers());
  assert.strictEqual(whole.status, 200);
  assert.strictEqual(whole.headers.get('content-type'), 'video/mp4');
  assert.strictEqual(whole.headers.get('accept-ranges'), 'bytes');
  assert.strictEqual(await whole.text(), '0123456789');
  const part = r.respond(`/media/${token}`, new Headers({ Range: 'bytes=2-5' }));
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers.get('content-range'), 'bytes 2-5/10');
  assert.strictEqual(part.headers.get('content-length'), '4');
  assert.strictEqual(await part.text(), '2345');
  const bad = r.respond(`/media/${token}`, { range: 'bytes=50-' });
  assert.strictEqual(bad.status, 416);
  assert.strictEqual(bad.headers.get('content-range'), 'bytes */10');
  assert.strictEqual(r.respond('/media/' + 'a'.repeat(32), new Headers()).status, 404);
  assert.strictEqual(r.respond(`/media/${token}/../x`, new Headers()).status, 404);
  assert.strictEqual(r.respond('/renderer/app.js', new Headers()).status, 404);
});

/** A service with fake ffmpeg and analyzer; the analyzer can be held open to test cancel/queue. */
function service({ duration = 10, hold = false, fail = null } = {}) {
  const events = [];
  const started = [];
  let release = null;
  const analyzer = {
    async analyze(p, { signal, onProgress }) {
      started.push(path.basename(p));
      onProgress({ stage: 'audio', label: 'ดึงเสียงจากคลิป', fraction: 0.5, overall: 0.1 });
      if (hold) {
        await new Promise((resolve, reject) => {
          release = resolve;
          signal.addEventListener('abort', () => reject(Object.assign(new Error('ยกเลิกแล้ว'), { code: 'ABORTED' })));
        });
      }
      if (fail) throw new Error(fail);
      return { silences: [{ start: 1, end: 2 }], transcript: { model: 'small', segments: [] }, summary: { duration }, warnings: [], source: { path: p } };
    },
  };
  const ffmpeg = { async probe(p) { if (p.includes('broken')) throw new Error('อ่านข้อมูลไฟล์ไม่ได้'); return { duration, video: { width: 1080, height: 1920 }, audio: {} }; } };
  const svc = new VideoService({ registry: new MediaRegistry(), ffmpeg, analyzer, emit: (ch, p) => events.push([ch, p]) });
  return { svc, events, started, release: () => release && release() };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('service: import puts each clip on the timeline and analyses it', async () => {
  const { svc, events, started } = service();
  const a = file('a.mp4');
  const r = await svc.importFiles([a, file('b.mov'), file('c.txt'), path.join(tmp(), 'broken.mp4')]);
  assert.deepStrictEqual(r.added, ['s1', 's2']);
  assert.deepStrictEqual(r.rejected.map((x) => x.name), ['c.txt', 'broken.mp4']);
  await settle();
  assert.deepStrictEqual(started, ['a.mp4', 'b.mov']); // one after the other
  const snap = svc.snapshot();
  assert.strictEqual(snap.duration, 20);
  assert.deepStrictEqual(snap.clips.map((c) => [c.src, c.in, c.out]), [['s1', 0, 10], ['s2', 0, 10]]);
  assert.deepStrictEqual(snap.sources[0].analysis.silences, [{ start: 1, end: 2 }]);
  assert.strictEqual(JSON.stringify(snap).includes(a), false, 'no disk path in snapshots');
  assert.strictEqual(JSON.stringify(snap).includes('"path"'), false);
  assert.ok(events.some(([ch, p]) => ch === 'video:progress' && p.running && p.label === 'ดึงเสียงจากคลิป'));
  assert.deepStrictEqual(events.filter(([ch]) => ch === 'video:progress').pop()[1], { running: false, queued: 0 });
  assert.deepStrictEqual((await svc.importFiles([a])).rejected[0].reason, 'นำเข้าไว้แล้ว');
});

test('service: cancel stops the running analysis and the queue', async () => {
  const { svc, started } = service({ hold: true });
  await svc.importFiles([file('a.mp4'), file('b.mp4')]);
  await settle();
  assert.deepStrictEqual(started, ['a.mp4']);
  assert.strictEqual(svc.snapshot().job.sourceId, 's1');
  svc.cancel();
  await settle();
  const snap = svc.snapshot();
  assert.strictEqual(snap.job, null);
  assert.strictEqual(snap.sources[0].analyzeError, 'ยกเลิกแล้ว');
  assert.deepStrictEqual(started, ['a.mp4'], 'queued clip not started after cancel');
  svc.analyze('s2');
  await settle();
  assert.deepStrictEqual(started, ['a.mp4', 'b.mp4']);
  assert.deepStrictEqual(svc.analyze('s2'), { queued: true }); // already running: not queued twice
  assert.strictEqual(svc.queue.length, 0);
  assert.throws(() => svc.analyze('s9'), /ไม่พบคลิป/);
});

test('service: a failed analysis is shown on the clip, the next one still runs', async () => {
  const { svc, started } = service({ fail: 'ดึงเสียงจากคลิปไม่สำเร็จ' });
  await svc.importFiles([file('a.mp4'), file('b.mp4')]);
  await settle();
  assert.deepStrictEqual(started, ['a.mp4', 'b.mp4']);
  assert.strictEqual(svc.snapshot().sources[0].analyzeError, 'ดึงเสียงจากคลิปไม่สำเร็จ');
  assert.strictEqual(svc.snapshot().sources[0].analysis, null);
});

test('service: reset clears everything', async () => {
  const { svc } = service();
  await svc.importFiles([file('a.mp4')]);
  await settle();
  svc.reset();
  assert.deepStrictEqual(svc.snapshot().sources, []);
  assert.strictEqual(svc.snapshot().duration, 0);
});

// ---- style cut ----
const { StyleStore } = require('../lib/video/styles');

function cutService({ ask, hold = false } = {}) {
  const events = [];
  const asked = [];
  let release = null;
  const analyzer = {
    async analyze() {
      if (hold) await new Promise((r) => { release = r; });
      return {
        silences: [{ start: 4, end: 7 }],
        transcript: { model: 'small', segments: [{ start: 0, end: 4, text: 'สวัสดีครับ' }, { start: 7, end: 10, text: 'อย่างแรก' }] },
        summary: { duration: 10 },
        warnings: [],
      };
    },
  };
  const ffmpeg = { async probe() { return { duration: 10, video: { width: 1080, height: 1920 }, audio: {} }; } };
  const styles = new StyleStore({ file: path.join(tmp(), 'styles.json') });
  const svc = new VideoService({
    registry: new MediaRegistry(), ffmpeg, analyzer, styles,
    ask: async (o) => { asked.push(o); return ask(o); },
    emit: (ch, p) => events.push([ch, p]),
  });
  return { svc, events, asked, release: () => release && release() };
}

const cutDone = (events) => new Promise((resolve) => {
  const t = setInterval(() => {
    const last = events.filter(([ch]) => ch === 'video:cut').pop();
    if (last && !last[1].running) { clearInterval(t); resolve(last[1]); }
  }, 5);
});

test('cut: JARVIS plan replaces the timeline in one undoable step', async () => {
  const { svc, events, asked } = cutService({ ask: async () => '```json\n{"clips":[{"piece":"p2"},{"piece":"p1","to":3}],"summary":"เปิดด้วยประโยคหลัก"}\n```' });
  await svc.importFiles([file('a.mp4')]);
  const r = svc.startCut({ styleId: 'educational', note: '  ตัดเอ่อออก  ' });
  assert.deepStrictEqual(r, { started: true, styleName: 'สอน/ให้ความรู้' });
  const done = await cutDone(events);
  assert.strictEqual(done.result.ok, true);
  assert.strictEqual(done.result.byClaude, true);
  assert.strictEqual(done.result.summary, 'เปิดด้วยประโยคหลัก');
  assert.match(asked[0].prompt, /ตัดเอ่อออก/);
  assert.match(asked[0].prompt, /"สวัสดีครับ"/);
  assert.ok(asked[0].system && asked[0].signal);
  const snap = svc.snapshot();
  assert.deepStrictEqual(snap.clips.map((c) => [c.in, c.out]), [[6.85, 10], [0, 3]]);
  assert.strictEqual(new Set(snap.clips.map((c) => c.id)).size, 2);
  assert.ok(!snap.clips.some((c) => c.id === 'c1'), 'new ids, not reused from before the cut');
  assert.strictEqual(snap.cut, null);
  assert.strictEqual(snap.lastCut.ok, true);
  const stages = events.filter(([ch, p]) => ch === 'video:cut' && p.running).map(([, p]) => p.stage);
  assert.deepStrictEqual([...new Set(stages)], ['wait', 'prepare', 'think', 'apply']);
  svc.history.undo();
  assert.deepStrictEqual(svc.snapshot().clips.map((c) => [c.in, c.out]), [[0, 10]]);
});

test('cut: when JARVIS cannot answer, a basic cut is made and said so', async () => {
  const { svc, events } = cutService({ ask: async () => 'ขอโทษครับ' });
  await svc.importFiles([file('a.mp4')]);
  svc.startCut({ styleId: 'viral' });
  const done = await cutDone(events);
  assert.strictEqual(done.result.ok, true);
  assert.strictEqual(done.result.byClaude, false);
  assert.match(done.result.warnings.join(' '), /ตัดแบบพื้นฐาน/);
  assert.ok(svc.snapshot().clips.length >= 2, 'pause at 4–7 cut out');
});

test('cut: waits for the analysis first; cancel leaves the timeline alone', async () => {
  const { svc, events, asked, release } = cutService({ hold: true, ask: () => new Promise(() => {}) });
  await svc.importFiles([file('a.mp4')]);
  svc.startCut({ styleId: 'vlog' });
  await settle();
  assert.strictEqual(svc.snapshot().cut.stage, 'wait');
  assert.strictEqual(asked.length, 0, 'JARVIS is not asked before the clip is understood');
  assert.throws(() => svc.startCut({ styleId: 'vlog' }), /กำลังตัดต่ออยู่/);
  release();
  await settle();
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(svc.snapshot().cut.stage, 'think');
  svc.cancelCut();
  const done = await cutDone(events);
  assert.deepStrictEqual(done.result, { ok: false, cancelled: true, styleName: 'วล็อกชิล' });
  assert.deepStrictEqual(svc.snapshot().clips.map((c) => [c.in, c.out]), [[0, 10]]);
});

test('cut: refuses with nothing to cut or an unknown style', async () => {
  const { svc } = cutService({ ask: async () => '' });
  assert.throws(() => svc.startCut({ styleId: 'viral' }), /ยังไม่มีคลิป/);
  await svc.importFiles([file('a.mp4')]);
  assert.throws(() => svc.startCut({ styleId: 'nope' }), /ไม่พบแนว/);
});

test('edit: split, trim, speed, move, remove through the service; undo each', async () => {
  const { svc } = service();
  await svc.importFiles([file('a.mp4'), file('b.mov')]); // two 10 s clips
  let s = svc.edit({ op: 'split', at: 4 });
  assert.deepStrictEqual(s.clips.map((c) => [c.src, c.in, c.out]), [['s1', 0, 4], ['s1', 4, 10], ['s2', 0, 10]]);
  assert.strictEqual(s.canUndo, true);
  const id = s.clips[1].id;
  s = svc.edit({ op: 'trim', id, in: 5 });
  assert.deepStrictEqual([s.clips[1].in, s.clips[1].out], [5, 10]);
  s = svc.edit({ op: 'speed', id, speed: 2 });
  assert.strictEqual(s.duration, 4 + 2.5 + 10);
  s = svc.edit({ op: 'move', id, to: 0 });
  assert.strictEqual(s.clips[0].id, id);
  s = svc.edit({ op: 'remove', id });
  assert.strictEqual(s.clips.length, 2);
  svc.history.undo();
  assert.strictEqual(svc.snapshot().clips.length, 3);
});

test('edit: a bad edit throws a Thai message and changes nothing', async () => {
  const { svc } = service();
  await svc.importFiles([file('a.mp4')]);
  const before = JSON.stringify(svc.snapshot().clips);
  assert.throws(() => svc.edit({ op: 'split', at: 0 }), /ตัดไม่ได้/);
  assert.throws(() => svc.edit({ op: 'trim', id: 'c1', out: 0.05 }), /สั้นเกินไป/);
  assert.throws(() => svc.edit({ op: 'trim', id: 'c1', out: 99 }), /เกินความยาว/);
  assert.throws(() => svc.edit({ op: 'speed', id: 'c1', speed: 9 }), /ความเร็ว/);
  assert.throws(() => svc.edit({ op: 'remove', id: 'nope' }), /ไม่พบคลิป/);
  assert.throws(() => svc.edit({ op: 'explode' }), /ไม่รู้จัก/);
  assert.strictEqual(JSON.stringify(svc.snapshot().clips), before);
  assert.strictEqual(svc.snapshot().canUndo, true, 'only the import is in the history');
  assert.strictEqual(svc.history.past.length, 1);
});

test('captions: edit by hand, restore, and a Claude fix that spares hand edits', async () => {
  const { svc } = cutService({ ask: async () => '{"fixes":[{"i":0,"text":"สวัสดีครับ Claude"},{"i":1,"text":"แก้โดย Claude"}]}' });
  await svc.importFiles([file('a.mp4')]);
  await settle();
  const segs = () => svc.snapshot().sources[0].analysis.transcript.segments;
  assert.deepStrictEqual(segs().map((g) => g.i), [0, 1], 'every line carries its index');
  const heard = segs()[1].text;
  svc.editCaption({ sourceId: 's1', i: 1, text: '  แก้เอง   ครับ ' });
  assert.strictEqual(segs()[1].text, 'แก้เอง ครับ');
  assert.strictEqual(segs()[1].edited, true);
  assert.throws(() => svc.editCaption({ sourceId: 's1', i: 1, text: ' ' }), /ว่างไม่ได้/);
  assert.throws(() => svc.editCaption({ sourceId: 's1', i: 99, text: 'x' }), /ไม่พบประโยค/);
  const r = await svc.fixCaptions({ sourceId: 's1', hint: 'สอน Claude Code' });
  assert.strictEqual(r.changed, 1, 'the hand-edited line is left alone');
  assert.strictEqual(segs()[0].text, 'สวัสดีครับ Claude');
  assert.strictEqual(segs()[1].text, 'แก้เอง ครับ');
  svc.restoreCaption({ sourceId: 's1', i: 1 });
  assert.strictEqual(segs()[1].text, heard);
  assert.strictEqual(segs()[1].edited, undefined);
  assert.strictEqual(svc.snapshot().fix, null);
});

// ---- the video with subtitles (HyperFrames is faked) ----
function renderService({ render } = {}) {
  const events = [];
  const prepared = [];
  const out = tmp();
  const hf = {
    prepare(id, spec) { prepared.push({ id, ...spec }); return out; },
    async render(dir, o) { return render ? render(dir, o) : (fs.writeFileSync(o.out, 'mp4'), o.out); },
  };
  const analyzer = {
    async analyze() {
      return { silences: [], transcript: { model: 'm', segments: [{ start: 0, end: 4, text: 'สวัสดีครับ วันนี้มาสอน' }, { start: 6, end: 9, text: 'ประโยคสอง' }] }, summary: {}, warnings: [] };
    },
  };
  const ffmpeg = { async probe() { return { duration: 10, video: { width: 1080, height: 1920 }, audio: { codec: 'aac' } }; } };
  const svc = new VideoService({ registry: new MediaRegistry(), ffmpeg, analyzer, styles: new StyleStore({ file: path.join(tmp(), 's.json') }), ask: async () => '', hf, emit: (ch, p) => events.push([ch, p]) });
  return { svc, events, prepared };
}
const renderDone = (events) => new Promise((resolve) => {
  const t = setInterval(() => {
    const last = events.filter(([ch]) => ch === 'video:render').pop();
    if (last && !last[1].running) { clearInterval(t); resolve(last[1]); }
  }, 5);
});

test('render: builds the page from the edit list and the fixed transcript, then plays the new file', async () => {
  const { svc, events, prepared } = renderService();
  await svc.importFiles([file('a.mp4')]);
  await settle();
  svc.editCaption({ sourceId: 's1', i: 1, text: 'แก้แล้วครับ' });
  svc.edit({ op: 'split', at: 5 });
  const r = svc.startRender({ captionStyle: 'pop', quality: 'draft' });
  assert.strictEqual(r.started, true);
  assert.strictEqual(svc.snapshot().render.label, 'เตรียมโปรเจกต์');
  const done = await renderDone(events);
  assert.strictEqual(done.result.ok, true);
  assert.match(done.result.url, /^app:\/\/jarvis\/media\//);
  assert.strictEqual(done.result.duration, 10);
  assert.strictEqual(prepared.length, 1);
  assert.match(prepared[0].html, /แก้แล้วครับ/);
  assert.match(prepared[0].html, /back\.out/, 'the chosen subtitle style');
  assert.match(prepared[0].html, /data-media-start="5"/, 'the cut is in the page');
  assert.deepStrictEqual(prepared[0].files.map((f) => f.id), ['s1']);
  assert.strictEqual(svc.snapshot().lastRender.ok, true);
  // a second render gets a different file (the browser must not show the old one)
  svc.startRender({ captionStyle: 'classic', quality: 'draft' });
  const again = await renderDone(events);
  assert.strictEqual(again.result.ok, true);
  assert.notStrictEqual(again.result.url, done.result.url);
});

test('render: progress, failure and cancel are reported; busy and empty are refused', async () => {
  let release;
  const slow = renderService({ render: (dir, o) => new Promise((resolve, reject) => { o.onProgress(0.4, 'capture'); release = () => resolve(o.out); o.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { code: 'ABORTED' }))); }) });
  assert.throws(() => slow.svc.startRender({}), /ยังไม่มีคลิป/);
  await slow.svc.importFiles([file('a.mp4')]);
  await settle();
  slow.svc.startRender({});
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(slow.svc.snapshot().render.fraction, 0.4);
  assert.strictEqual(slow.svc.snapshot().render.label, 'วาดภาพและซับทีละเฟรม');
  assert.throws(() => slow.svc.startRender({}), /กำลังสร้างวิดีโออยู่/);
  slow.svc.cancelRender();
  const c = await renderDone(slow.events);
  assert.strictEqual(c.result.cancelled, true);

  const bad = renderService({ render: async () => { throw new Error('HyperFrames สร้างวิดีโอไม่สำเร็จ'); } });
  await bad.svc.importFiles([file('a.mp4')]);
  await settle();
  bad.svc.startRender({});
  const f = await renderDone(bad.events);
  assert.strictEqual(f.result.ok, false);
  assert.match(f.result.error, /ไม่สำเร็จ/);
  assert.strictEqual(bad.svc.snapshot().render, null);
});
