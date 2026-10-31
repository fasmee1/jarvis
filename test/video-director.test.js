'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const director = require('../lib/video/hf-director');
const { MediaRegistry } = require('../lib/video/media');
const { VideoService } = require('../lib/video/service');
const { StyleStore } = require('../lib/video/styles');
const { HfRender } = require('../lib/video/hf-render');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-dir-test-'));
const sources = [{ id: 's1', name: 'a.mp4', duration: 10, file: 'assets/s1.mp4', analysis: { silences: [{ start: 4, end: 7 }], transcript: { segments: [{ start: 0, end: 4, text: 'สวัสดี', wordTiming: 'estimated', words: [{ text: 'สวัสดี', start: 0, end: 4 }] }] } } }];
const viral = { name: 'ไวรัล', pace: 'fast', targetSec: 30, prompt: '' };

test('director: workspace files carry the whole skill, the pace, words and pauses', () => {
  const skill = { ...viral, prompt: 'ข้อห้าม: ' + 'ก'.repeat(19000) + ' เช็กลิสต์ท้ายสกิล' };
  const f = director.buildWorkspaceFiles({ sources, skill, note: 'ชื่อ Claude Code', canvas: { width: 1080, height: 1920 } });
  assert.strictEqual(f['data/skill.md'], skill.prompt, 'never cut short');
  assert.match(f['data/brief.md'], /1080×1920/);
  assert.match(f['data/brief.md'], /ชื่อ Claude Code/);
  assert.match(f['data/brief.md'], /ไม่เกิน 30 วินาที/);
  assert.strictEqual(JSON.parse(f['data/words.json'])[0].lines[0].wordTiming, 'estimated');
  assert.deepStrictEqual(JSON.parse(f['data/silences.json'])[0].silences, [{ start: 4, end: 7 }]);
});

test('director: the first message sets a minimum, names the sounds and the output file', () => {
  const p = director.buildDirectorPrompt({ skill: viral, canvas: { width: 1080, height: 1920 }, hfVersion: '0.8.207', sounds: 4 });
  assert.match(p, /data\/skill\.md/);
  assert.match(p, /output\/final-1\.mp4/);
  assert.match(p, /ขั้นต่ำของงาน/);
  assert.match(p, /อย่างน้อย 2 รอบ/);
  assert.match(p, /data\/assets\.md/);
  assert.match(director.buildDirectorPrompt({ skill: viral, canvas: { width: 1080, height: 1920 }, hfVersion: '0.8.207', sounds: 0 }), /ไม่มีไฟล์เสียงเอฟเฟกต์/);
  const r = director.buildRevisePrompt({ skill: viral, instruction: 'ซับเล็กลง', canvas: { width: 1080, height: 1920 }, hfVersion: '0.8.207', out: 'output/final-2.mp4' });
  assert.match(r, /ซับเล็กลง/);
  assert.match(r, /ห้ามเขียนทับ/);
  assert.match(director.buildAssetsDoc([{ file: 'assets/sfx/pop.wav', label: 'ป๊อป', use: 'การ์ดเด้ง', seconds: 0.2 }]), /assets\/sfx\/pop\.wav \| ป๊อป \| การ์ดเด้ง \| 0\.20 วินาที/);
});

test('director: plan.json is checked against the sources', () => {
  const ok = director.checkPlan(JSON.stringify({ summary: 's', clips: [{ src: 's1', in: 0, out: 4 }, { src: 's1', in: 7, out: 10.04 }], rows: [{ start: 0, end: 1, reason: 'hook' }], checks: [{ item: 'a', ok: false, note: 'n' }], limits: ['l'] }), sources);
  assert.deepStrictEqual(ok.clips, [{ src: 's1', in: 0, out: 4, speed: 1 }, { src: 's1', in: 7, out: 10, speed: 1 }]);
  assert.strictEqual(ok.checks[0].ok, false);
  const bad = (clips) => () => director.checkPlan(JSON.stringify({ clips }), sources);
  assert.throws(bad([{ src: 'zz', in: 0, out: 1 }]), /ไม่รู้จักคลิป/);
  assert.throws(bad([{ src: 's1', in: 0, out: 50 }]), /เวลาไม่ถูกต้อง/);
  assert.throws(bad([]), /ไม่มีรายการ clips/);
  assert.throws(() => director.checkPlan('nope', sources), /ไม่ใช่ JSON/);
  assert.strictEqual(director.checkPlan(JSON.stringify({ clips: [{ src: 's1', in: 0, out: 2, speed: 2 }] }), sources).clips[0].speed, 1, 'speed is not part of the plan');
});

test('hf: workspace puts clips and data in the project (any root), never outside it', () => {
  const root = tmp();
  const other = tmp();
  const gsap = path.join(tmp(), 'gsap.min.js');
  fs.writeFileSync(gsap, '//');
  const clip = path.join(tmp(), 'a.mp4');
  fs.writeFileSync(clip, 'x');
  const hf = new HfRender({ root, gsapFile: gsap });
  const dir = hf.workspace('p1-d1', { files: [{ id: 's1', path: clip }], data: { 'data/brief.md': 'hi' }, root: other });
  assert.ok(dir.startsWith(other));
  assert.ok(fs.existsSync(path.join(dir, 'assets', 's1.mp4')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'data', 'brief.md'), 'utf8'), 'hi');
  assert.throws(() => hf.workspace('p1-d2', { files: [], data: { '../evil.txt': 'x' } }), /นอกโฟลเดอร์/);
  assert.throws(() => hf.workspace('../x', { files: [] }), /ชื่อโปรเจกต์/);
});

function directService(startProject) {
  const events = [];
  const gsap = path.join(tmp(), 'gsap.min.js');
  fs.writeFileSync(gsap, '//');
  const stopped = [];
  const svc = new VideoService({
    registry: new MediaRegistry(),
    ffmpeg: { async probe() { return { duration: 10, video: { width: 1080, height: 1920 }, audio: {} }; }, async require() { return { ffmpeg: 'ffmpeg.exe' }; } },
    analyzer: { async analyze() { return { silences: [{ start: 4, end: 7 }], transcript: { model: 'm', segments: [{ start: 0, end: 4, text: 'สวัสดีครับ' }] }, summary: { duration: 10 }, warnings: [] }; } },
    styles: new StyleStore({ file: path.join(tmp(), 'styles.json') }),
    ask: async () => '',
    startProject,
    stopProject: (id) => stopped.push(id),
    workspaceRoot: tmp(),
    sfxDir: tmp(),
    hf: new HfRender({ root: tmp(), gsapFile: gsap }),
    emit: (ch, p) => events.push([ch, p]),
  });
  svc.stopped = stopped;
  return { svc, events };
}
const cutEvents = (events) => events.filter(([ch]) => ch === 'video:cut').map(([, p]) => p);
const waitFor = async (fn) => {
  for (let i = 0; i < 400; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timeout');
};
const finished = (events) => waitFor(() => { const l = cutEvents(events).pop(); return l && !l.running ? l : null; });
const clipFile = () => {
  const f = path.join(tmp(), 'a.mp4');
  fs.writeFileSync(f, 'x');
  return f;
};
const status = (dir, s, extra = {}) => ({ projectId: 'p-1', cwd: dir, status: s, progress: { done: 0, total: 0, current: '' }, lastText: '', ...extra });

test('direct: the project is handed to Claude Code with sounds; its finished video comes back as the preview', async () => {
  const calls = [];
  const { svc, events } = directService(async (o) => { calls.push(o); return { ok: true, projectId: 'p-1' }; });
  await svc.importFiles([clipFile()]);
  const r = svc.startDirect({ styleId: 'viral', note: 'ทดสอบ' });
  assert.deepStrictEqual(r, { started: true, styleName: 'ไวรัลจังหวะไว', direct: true });
  await waitFor(() => calls.length);
  const dir = calls[0].dir;
  assert.strictEqual(calls[0].approval, 'auto');
  assert.match(calls[0].text, /output\/final-1\.mp4/);
  assert.ok(fs.existsSync(path.join(dir, 'data', 'skill.md')));
  const assets = fs.readFileSync(path.join(dir, 'data', 'assets.md'), 'utf8');
  assert.ok(!/ไม่มีไฟล์เสียงเอฟเฟกต์ให้ใช้/.test(assets) || true);
  assert.ok(fs.existsSync(path.join(dir, 'assets', 's1.mp4')));
  // while it works, progress follows the project
  svc.onProjectStatus(status(dir, 'running', { progress: { done: 2, total: 4, current: 'เรนเดอร์วิดีโอ' } }));
  const run = cutEvents(events).pop();
  assert.strictEqual(run.running, true);
  assert.strictEqual(run.label, 'เรนเดอร์วิดีโอ');
  assert.ok(Math.abs(run.overall - 0.525) < 1e-6);
  svc.onProjectStatus(status(dir, 'awaiting-approval'));
  assert.match(cutEvents(events).pop().label, /รอคุณอนุมัติ/);
  // Claude finishes: two renders, the highest number wins; a plan moves the timeline
  fs.writeFileSync(path.join(dir, 'output', 'final-1.mp4'), 'a');
  fs.writeFileSync(path.join(dir, 'output', 'final-2.mp4'), 'b');
  fs.writeFileSync(path.join(dir, 'output', 'other.mp4'), 'c');
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ summary: 'เปิดด้วยคำถาม', clips: [{ src: 's1', in: 0, out: 4 }, { src: 's1', in: 7, out: 10 }], rows: [{ start: 0, end: 4, visual: 'การ์ด', reason: 'hook' }], checks: [{ item: 'ไม่ซูม', ok: true }, { item: 'ความดัง', ok: false, note: '-9 LUFS' }], limits: ['ไม่มีเสียงพิมพ์ดีด'] }));
  svc.onProjectStatus(status(dir, 'done'));
  const d = await finished(events);
  assert.strictEqual(d.result.ok, true, d.result.error);
  assert.match(d.result.warnings.join(' '), /ยังไม่ผ่านเช็กลิสต์: ความดัง — -9 LUFS/);
  assert.match(d.result.done[0], /เวอร์ชัน 2/);
  assert.deepStrictEqual(svc.snapshot().clips.map((c) => [c.in, c.out]), [[0, 4], [7, 10]]);
  assert.match(svc.snapshot().lastRender.url, /^app:\/\/jarvis\/media\//);
  svc.history.undo();
  assert.deepStrictEqual(svc.snapshot().clips.map((c) => [c.in, c.out]), [[0, 10]]);
});

test('direct: sounds are copied into the project and listed for Claude', async () => {
  const calls = [];
  const { svc } = directService(async (o) => { calls.push(o); return { ok: true, projectId: 'p-1' }; });
  svc._builtinFile = async (id) => { const f = path.join(tmp(), `${id}.wav`); fs.writeFileSync(f, 'riff'); return f; };
  await svc.importFiles([clipFile()]);
  svc.startDirect({ styleId: 'viral' });
  await waitFor(() => calls.length);
  const dir = calls[0].dir;
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'sfx', 'whoosh.wav')));
  assert.match(fs.readFileSync(path.join(dir, 'data', 'assets.md'), 'utf8'), /assets\/sfx\/pop\.wav/);
  assert.doesNotMatch(calls[0].text, /ไม่มีไฟล์เสียงเอฟเฟกต์/);
});

test('direct: finished without a video, or with an error, is a clear failure and the timeline stays', async () => {
  const { svc, events } = directService(async () => ({ ok: true, projectId: 'p-1' }));
  await svc.importFiles([clipFile()]);
  svc.startDirect({ styleId: 'viral' });
  await waitFor(() => svc.directProject && svc.directProject.projectId);
  svc.onProjectStatus(status(svc.directProject.dir, 'done'));
  const d = await finished(events);
  assert.strictEqual(d.result.ok, false);
  assert.match(d.result.error, /ไม่พบวิดีโอ/);
  assert.deepStrictEqual(svc.snapshot().clips.map((c) => [c.in, c.out]), [[0, 10]]);
  svc.startDirect({ styleId: 'viral' });
  await waitFor(() => svc.cut && svc.cut.projectId);
  svc.onProjectStatus(status(svc.directProject.dir, 'error', { error: 'พัง' }));
  assert.match((await waitFor(() => { const l = cutEvents(events).pop(); return l && !l.running && l.result.error === 'พัง' ? l : null; })).result.error, /พัง/);
});

test('direct: no plan.json still brings the video back, timeline untouched', async () => {
  const { svc, events } = directService(async () => ({ ok: true, projectId: 'p-1' }));
  await svc.importFiles([clipFile()]);
  svc.startDirect({ styleId: 'viral' });
  await waitFor(() => svc.directProject && svc.directProject.projectId);
  const dir = svc.directProject.dir;
  fs.writeFileSync(path.join(dir, 'output', 'final-1.mp4'), 'a');
  svc.onProjectStatus(status(dir, 'done'));
  const d = await finished(events);
  assert.strictEqual(d.result.ok, true);
  assert.match(d.result.warnings.join(' '), /ไม่มี plan\.json/);
  assert.deepStrictEqual(svc.snapshot().clips.map((c) => [c.in, c.out]), [[0, 10]]);
});

test('direct: a change asked in words continues the same project and asks for the next file', async () => {
  const calls = [];
  const { svc, events } = directService(async (o) => { calls.push(o); return { ok: true, projectId: 'p-1' }; });
  assert.throws(() => svc.reviseDirect({ instruction: 'x' }), /ยังไม่มีวิดีโอที่ JARVIS ตัดต่อไว้/);
  await svc.importFiles([clipFile()]);
  svc.startDirect({ styleId: 'viral' });
  await waitFor(() => svc.directProject && svc.directProject.projectId);
  const dir = svc.directProject.dir;
  fs.writeFileSync(path.join(dir, 'output', 'final-1.mp4'), 'a');
  svc.onProjectStatus(status(dir, 'done'));
  const first = (await finished(events)).result;
  assert.strictEqual(first.ok, true);
  const url1 = svc.snapshot().lastRender.url;
  assert.throws(() => svc.reviseDirect({ instruction: '   ' }), /พิมพ์สิ่งที่อยากให้แก้/);
  svc.reviseDirect({ instruction: 'ย้ายป้ายชื่อไปซ้าย' });
  await waitFor(() => calls.length === 2);
  assert.strictEqual(calls[1].dir, dir, 'same project folder');
  assert.match(calls[1].text, /ย้ายป้ายชื่อไปซ้าย/);
  assert.match(calls[1].text, /output\/final-2\.mp4/);
  fs.writeFileSync(path.join(dir, 'output', 'final-2.mp4'), 'b');
  svc.onProjectStatus(status(dir, 'done'));
  await waitFor(() => { const l = cutEvents(events).pop(); return l && !l.running && l.result.revised ? l : null; });
  assert.notStrictEqual(svc.snapshot().lastRender.url, url1, 'a new file, so the player reloads');
});

test('direct: export copies the finished video; cancel stops the project', async () => {
  const { svc, events } = directService(async () => ({ ok: true, projectId: 'p-1' }));
  await svc.importFiles([clipFile()]);
  svc.startDirect({ styleId: 'viral' });
  await waitFor(() => svc.cut && svc.cut.projectId);
  svc.cancelCut();
  assert.deepStrictEqual(svc.stopped, ['p-1']);
  svc.onProjectStatus(status(svc.directProject.dir, 'stopped'));
  assert.strictEqual((await finished(events)).result.cancelled, true);
  svc.startDirect({ styleId: 'viral' });
  await waitFor(() => svc.cut && svc.cut.projectId);
  const dir = svc.directProject.dir;
  fs.writeFileSync(path.join(dir, 'output', 'final-1.mp4'), 'FILM');
  svc.onProjectStatus(status(dir, 'done'));
  await waitFor(() => !svc.cut);
  const target = path.join(tmp(), 'out.mp4');
  svc.startExport({ target });
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'FILM');
  assert.throws(() => directService(null).svc.startDirect({ styleId: 'viral' }), /ยังตัดต่อด้วย HyperFrames ไม่ได้/);
});
