'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ffmpeg, PINNED, parseProbe, parseRate, checkInput } = require('../lib/video/ffmpeg');

const EXE = (n) => (process.platform === 'win32' ? `${n}.exe` : n);

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jv-ff-test-'));
}

/** A folder holding fake ffmpeg + ffprobe files. */
function fakeBin(withProbe = true) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, EXE('ffmpeg')), '');
  if (withProbe) fs.writeFileSync(path.join(dir, EXE('ffprobe')), '');
  return dir;
}

test('parseRate', () => {
  assert.strictEqual(parseRate('30/1'), 30);
  assert.strictEqual(parseRate('30000/1001'), 29.97);
  assert.strictEqual(parseRate('0/0'), null);
  assert.strictEqual(parseRate('abc'), null);
});

test('parseProbe: phone clip turned 90° reports the size as seen on screen', () => {
  const info = parseProbe({
    format: { duration: '12.5', size: '1000' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001', side_data_list: [{ rotation: -90 }] },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
    ],
  });
  assert.deepStrictEqual(info, {
    duration: 12.5,
    video: { codec: 'h264', width: 1080, height: 1920, rotation: 270, fps: 29.97 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
    size: 1000,
  });
});

test('parseProbe: audio only, cover art ignored, duration from stream', () => {
  const info = parseProbe(JSON.stringify({
    format: {},
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } },
      { codec_type: 'audio', codec_name: 'mp3', duration: '3.2' },
    ],
  }));
  assert.strictEqual(info.video, null);
  assert.strictEqual(info.duration, 3.2);
  assert.strictEqual(parseProbe({}).duration, null);
});

test('checkInput: needs an absolute path to an existing file', () => {
  assert.throws(() => checkInput('clip.mp4'), /ที่อยู่เต็ม/);
  assert.throws(() => checkInput(path.join(tmp(), 'missing.mp4')), /ไม่พบไฟล์/);
  const f = path.join(tmp(), 'a.mp4');
  fs.writeFileSync(f, '');
  assert.strictEqual(checkInput(f), path.resolve(f));
});

test('custom path: exe or folder accepted, bad paths explained', () => {
  const bin = fakeBin();
  const at = (p) => new Ffmpeg({ dataDir: tmp(), getCustomPath: () => p, deps: { env: { PATH: '' } } }).locate();
  assert.strictEqual(at(path.join(bin, EXE('ffmpeg'))).source, 'custom');
  assert.strictEqual(at(bin).ffprobe, path.join(bin, EXE('ffprobe')));
  assert.throws(() => at('ffmpeg.exe'), /ที่อยู่เต็ม/);
  assert.throws(() => at(path.join(bin, 'notepad.exe')), /ต้องชื่อ/);
  assert.throws(() => at(path.join(tmp(), EXE('ffmpeg'))), /ไม่พบ ffmpeg/);
  assert.throws(() => at(path.join(fakeBin(false), EXE('ffmpeg'))), /ffprobe/);
});

test('lookup order: custom > installed > PATH; relative PATH entries skipped', () => {
  const sys = fakeBin();
  const dataDir = tmp();
  const env = { PATH: ['relative\\bin', '', sys].join(process.platform === 'win32' ? ';' : ':') };
  const f = new Ffmpeg({ dataDir, deps: { env } });
  assert.strictEqual(f.locate().source, 'system');
  const inst = path.join(dataDir, 'ffmpeg', 'x', 'bin');
  fs.mkdirSync(inst, { recursive: true });
  fs.writeFileSync(path.join(inst, EXE('ffmpeg')), '');
  fs.writeFileSync(path.join(inst, EXE('ffprobe')), '');
  assert.strictEqual(f.locate().source, 'installed');
  const custom = fakeBin();
  assert.strictEqual(new Ffmpeg({ dataDir, getCustomPath: () => custom, deps: { env } }).locate().source, 'custom');
  assert.strictEqual(new Ffmpeg({ dataDir: tmp(), deps: { env: { PATH: '' } } }).locate(), null);
});

test('status: nothing found, broken custom path, and a working tool', async () => {
  const none = new Ffmpeg({ dataDir: tmp(), deps: { env: { PATH: '' } } });
  const s0 = await none.status();
  assert.strictEqual(s0.ready, false);
  assert.strictEqual(s0.pinned, PINNED.version);
  const broken = await new Ffmpeg({ dataDir: tmp(), getCustomPath: () => 'x', deps: { env: { PATH: '' } } }).status();
  assert.match(broken.error, /ที่อยู่เต็ม/);
  const bin = fakeBin();
  const ok = new Ffmpeg({ dataDir: tmp(), getCustomPath: () => bin, deps: { env: { PATH: '' } } });
  ok.run = async () => ({ code: 0, stdout: 'ffmpeg version 7.1.1-test Copyright', stderr: '' });
  const s1 = await ok.status();
  assert.deepStrictEqual([s1.ready, s1.source, s1.version], [true, 'custom', '7.1.1-test']);
  const dead = new Ffmpeg({ dataDir: tmp(), getCustomPath: () => bin, deps: { env: { PATH: '' } } });
  dead.run = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  assert.match((await dead.status()).error, /เปิดใช้งานไม่ได้/);
  await assert.rejects(dead.require(), (e) => e.code === 'BAD_FFMPEG');
  await assert.rejects(none.require(), (e) => e.code === 'NO_FFMPEG');
});

function installer({ hash = PINNED.sha256, exe = true } = {}) {
  const dataDir = tmp();
  const calls = [];
  const f = new Ffmpeg({
    dataDir,
    deps: {
      env: { PATH: '' },
      download: async (url, dest) => { calls.push(url); fs.writeFileSync(dest, 'zip'); return dest; },
      hash: async () => hash,
      extractZip: async (zip, dest) => {
        const bin = path.join(dest, 'ffmpeg-7.1.1-essentials_build', 'bin');
        fs.mkdirSync(bin, { recursive: true });
        if (exe) fs.writeFileSync(path.join(bin, EXE('ffmpeg')), '');
        fs.writeFileSync(path.join(bin, EXE('ffprobe')), '');
      },
    },
  });
  f.run = async () => ({ code: 0, stdout: 'ffmpeg version 7.1.1-essentials_build', stderr: '' });
  return { f, dataDir, calls };
}

test('install: pinned url, one job at a time, nothing left behind', async () => {
  const { f, dataDir, calls } = installer();
  const steps = [];
  const a = f.install((p) => steps.push(p.step));
  assert.strictEqual(f.install(), a);
  const r = await a;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status.source, 'installed');
  assert.strictEqual(r.status.installing, false);
  assert.deepStrictEqual(calls, [PINNED.url]);
  assert.deepStrictEqual(fs.readdirSync(dataDir), ['ffmpeg']);
  assert.ok(steps.includes('ตรวจไฟล์') && steps.includes('แตกไฟล์'));
  assert.strictEqual((await f.install()).ok, true); // already there: no second download
  assert.strictEqual(calls.length, 1);
});

test('install: a wrong checksum is refused and cleaned up', async () => {
  const { f, dataDir } = installer({ hash: 'deadbeef' });
  const r = await f.install();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /checksum/);
  assert.deepStrictEqual(fs.readdirSync(dataDir), []);
  assert.strictEqual(f.installing, null);
});

test('install: a zip without ffmpeg is refused', async () => {
  const { f, dataDir } = installer({ exe: false });
  const r = await f.install();
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(fs.readdirSync(dataDir), []);
});

// run() is tested with node itself as the child process, so no ffmpeg is needed.
const node = process.execPath;

test('run: args must be strings; output and exit code come back', async () => {
  const f = new Ffmpeg({ dataDir: tmp() });
  assert.throws(() => f.run(node, '-v'), TypeError);
  assert.throws(() => f.run(node, [1]), TypeError);
  const seen = [];
  const r = await f.run(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], { onStderr: (d) => seen.push(d) });
  assert.deepStrictEqual([r.code, r.stdout, r.stderr], [3, 'out', 'err']);
  assert.deepStrictEqual(seen, ['err']);
});

test('run: an argument with spaces and shell characters stays one argument', async () => {
  const f = new Ffmpeg({ dataDir: tmp() });
  const tricky = 'a & b; echo "hi" | x %PATH%';
  const r = await f.run(node, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', tricky]);
  assert.deepStrictEqual(JSON.parse(r.stdout), [tricky]);
});

test('run: cancel and timeout stop the process', async () => {
  const f = new Ffmpeg({ dataDir: tmp() });
  const ac = new AbortController();
  const p = f.run(node, ['-e', 'setInterval(() => {}, 1000)'], { signal: ac.signal });
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(p, (e) => e.code === 'ABORTED');
  await assert.rejects(f.run(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 150 }), (e) => e.code === 'TIMEOUT');
  const done = new AbortController();
  done.abort();
  await assert.rejects(f.run(node, ['-e', '1'], { signal: done.signal }), (e) => e.code === 'ABORTED');
  await assert.rejects(f.run(path.join(tmp(), EXE('missing')), []), (e) => e.code === 'SPAWN');
});
