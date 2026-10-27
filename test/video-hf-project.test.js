'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { canvasFor, mapCaptions, splitLines, buildProject } = require('../lib/video/hf-project');

const clip = (id, src, from, out, speed = 1) => ({ id, src, in: from, out, speed });

test('canvas follows the first picture', () => {
  assert.deepStrictEqual(canvasFor([{ video: { width: 720, height: 1280 } }]), { width: 1080, height: 1920 });
  assert.deepStrictEqual(canvasFor([{ video: { width: 1920, height: 1080 } }]), { width: 1920, height: 1080 });
  assert.deepStrictEqual(canvasFor([{ video: { width: 1000, height: 1000 } }]), { width: 1080, height: 1080 });
  assert.deepStrictEqual(canvasFor([{ video: null }]), { width: 1080, height: 1920 });
});

test('captions follow the cuts and the speed', () => {
  const clips = [clip('c1', 's1', 10, 14), clip('c2', 's1', 0, 4, 2)]; // 10–14 first, then 0–4 at 2×
  const segs = { s1: [{ start: 0, end: 2, text: 'สอง' }, { start: 10.5, end: 12, text: 'หนึ่ง' }, { start: 13, end: 20, text: 'ถูกตัดครึ่ง' }] };
  const m = mapCaptions(clips, segs);
  assert.deepStrictEqual(m.map((x) => [x.start, x.end, x.text]), [[0.5, 2, 'หนึ่ง'], [4, 5, 'สอง']]);
  // 13–20 keeps only 1 of its 7 seconds: dropped, not shown half-missing
});

test('a long caption is cut between Thai words, timed by length', () => {
  const short = splitLines({ start: 1, end: 3, text: 'สวัสดีครับ' });
  assert.deepStrictEqual(short, [{ start: 1, end: 3, text: 'สวัสดีครับ' }]);
  const long = splitLines({ start: 0, end: 6, text: 'สวัสดีครับวันนี้ผมจะมาสอนวิธีทำกาแฟเย็นแบบง่ายๆ อย่างแรกเลยให้เตรียมกาแฟสองช้อน' }, 22);
  assert.ok(long.length >= 3);
  assert.ok(long.every((l) => l.text.replace(/\s/g, '').length <= 26), 'no line much longer than the limit');
  assert.strictEqual(long[0].start, 0);
  assert.ok(Math.abs(long[long.length - 1].end - 6) < 0.01, 'lines cover the whole time');
  assert.ok(long.every((l, i) => i === 0 || Math.abs(l.start - long[i - 1].end) < 0.01), 'back to back');
  assert.ok(!long.some((l) => /^(ครับ|ๆ)$/.test(l.text)), 'no stray tail');
  assert.deepStrictEqual(splitLines({ start: 0, end: 1, text: '   ' }), []);
});

test('project: clips keep their cut, offset and speed; captions ride on top; text is escaped', () => {
  const clips = [clip('c1', 's1', 10, 14), clip('c2', 's1', 0, 4, 2), clip('c3', 's2', 0, 3)];
  const { html, duration } = buildProject({
    clips,
    sources: { s1: { file: 'assets/s1.mp4', kind: 'video', audio: true }, s2: { file: 'assets/s2.mp3', kind: 'audio', audio: true } },
    captions: [{ start: 0.5, end: 2, text: 'a <b> & "q"' }],
    canvas: { width: 1080, height: 1920 },
  });
  assert.strictEqual(duration, 9); // 4 + 2 + 3
  assert.match(html, /<video id="m-c1" class="clip" src="assets\/s1\.mp4" data-start="0" data-duration="4" data-media-start="10" data-track-index="0" data-has-audio="true"/);
  assert.match(html, /id="m-c2"[^>]*data-start="4" data-duration="2" data-media-start="0"[^>]*data-playback-rate="2"/);
  assert.match(html, /<audio id="m-c3" class="clip" src="assets\/s2\.mp3" data-start="6"/);
  assert.ok(!/crossorigin/.test(html));
  assert.match(html, /a &lt;b&gt; &amp; &quot;q&quot;/);
  assert.match(html, /data-composition-id="main" data-start="0" data-duration="9" data-width="1080" data-height="1920"/);
  assert.match(html, /window\.__timelines\["main"\] = tl/);
  assert.match(html, /tl\.fromTo\("#cap-0"/);
});

test('project: silent footage is muted, styles differ, an empty list still renders a page', () => {
  const base = { clips: [clip('c1', 's1', 0, 2)], sources: { s1: { file: 'assets/s1.mp4', kind: 'video', audio: false } }, canvas: { width: 1920, height: 1080 }, captions: [{ start: 0, end: 1, text: 'x' }] };
  assert.match(buildProject(base).html, /muted playsinline/);
  assert.match(buildProject({ ...base, captionStyle: 'pop' }).html, /back\.out/);
  assert.match(buildProject({ ...base, captionStyle: 'bar' }).html, /rgba\(0,0,0,\.62\)/);
  assert.strictEqual(buildProject({ ...base, clips: [], captions: [] }).duration, 0);
});

// ---- the runner (HyperFrames itself is faked) ----
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { HfRender, HfError, parseProgress, assetName } = require('../lib/video/hf-render');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-hf-'));

test('hf: progress lines and asset names', () => {
  assert.deepStrictEqual(parseProgress('@hf-progress {"code":"compile","pct":5}'), { fraction: 0.05, code: 'compile' });
  assert.strictEqual(parseProgress('  █░░  5%  Compiling'), null);
  assert.strictEqual(parseProgress('@hf-progress {nope'), null);
  assert.strictEqual(parseProgress('@hf-progress {"pct":250}').fraction, 1);
  assert.strictEqual(assetName('s1', 'D:/คลิป สวย/My Clip.MP4'), 's1.mp4');
});

test('hf: prepare puts the page, gsap and the clips in one folder; originals are not touched', () => {
  const root = tmp();
  const src = path.join(tmp(), 'orig.mp4');
  fs.writeFileSync(src, 'video-bytes');
  const gsap = path.join(tmp(), 'gsap.min.js');
  fs.writeFileSync(gsap, '/*gsap*/');
  const hf = new HfRender({ root, gsapFile: gsap });
  const dir = hf.prepare('p1', { html: '<html></html>', files: [{ id: 's1', path: src }] });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<html></html>');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'assets', 's1.mp4'), 'utf8'), 'video-bytes');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'assets', 'gsap.min.js'), 'utf8'), '/*gsap*/');
  assert.strictEqual(fs.readFileSync(src, 'utf8'), 'video-bytes');
  hf.prepare('p1', { html: '<html>2</html>', files: [{ id: 's1', path: src }] }); // again: fine
  assert.strictEqual(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<html>2</html>');
  assert.throws(() => hf.prepare('../evil', { html: '', files: [] }), /ชื่อโปรเจกต์/);
});

function fakeSpawn(behave) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 0;
    child.kill = () => {};
    if (cmd.endsWith('node.exe') || cmd.endsWith('node')) setImmediate(() => behave(child, args));
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('hf: render passes plain array args, no telemetry, follows progress, resolves with the file', async () => {
  const dir = tmp();
  const out = path.join(dir, 'o.mp4');
  const spawnFn = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('noise\n@hf-progress {"code":"compile","pct":5}\n@hf-prog'));
    child.stderr.emit('data', Buffer.from('ress {"code":"encode","pct":90}\n'));
    fs.writeFileSync(out, 'mp4');
    child.emit('close', 0);
  });
  const seen = [];
  const hf = new HfRender({ root: dir, gsapFile: '', spawnFn });
  assert.strictEqual(await hf.render(dir, { out, onProgress: (f, c) => seen.push([f, c]) }), out);
  assert.deepStrictEqual(seen, [[0.05, 'compile'], [0.9, 'encode']]);
  const call = spawnFn.calls.find((c) => /node(\.exe)?$/.test(c.cmd));
  assert.ok(call.args.every((a) => typeof a === 'string'));
  assert.ok(call.args.includes('render') && call.args.includes('hyperframes@0.8.207'));
  assert.strictEqual(call.opts.env.HYPERFRAMES_NO_TELEMETRY, '1');
  assert.strictEqual(call.opts.env.DO_NOT_TRACK, '1');
  assert.strictEqual(call.opts.windowsHide, true);
  assert.notStrictEqual(call.opts.shell, true);
});

test('hf: a failed render says why; cancel stops it; bad arguments are refused', async () => {
  const dir = tmp();
  const out = path.join(dir, 'o.mp4');
  const bad = new HfRender({ root: dir, gsapFile: '', spawnFn: fakeSpawn((child) => { child.stderr.emit('data', Buffer.from('boom: no frames\n')); child.emit('close', 3); }) });
  await assert.rejects(bad.render(dir, { out }), (e) => e instanceof HfError && e.code === 'RENDER' && /boom: no frames/.test(e.message));
  const ac = new AbortController();
  const slow = new HfRender({ root: dir, gsapFile: '', spawnFn: fakeSpawn((child) => { setTimeout(() => ac.abort(), 5); setTimeout(() => child.emit('close', 1), 30); }) });
  await assert.rejects(slow.render(dir, { out, signal: ac.signal }), (e) => e.code === 'ABORTED');
  assert.throws(() => slow.render(dir, { out: 'rel.mp4' }), /ที่อยู่เต็ม/);
  assert.throws(() => slow.render(dir, { out: path.join(dir, 'a.mov') }), /\.mp4/);
  assert.throws(() => slow.render(dir, { out, quality: 'x; rm' }), /คุณภาพ/);
});
