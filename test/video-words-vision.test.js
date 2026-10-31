'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { alignWords, isKeyWord, phrases, validWords, thaiWords } = require('../lib/video/words');
const { mapCaptions, splitLines, buildProject } = require('../lib/video/hf-project');
const frames = require('../lib/video/frames');
const { skillRules } = require('../lib/video/skills');
const { parseReview, buildReviewPrompt, buildGraphicsPrompt } = require('../lib/video/hf-graphics');
const { findLocalSound } = require('../lib/video/sfx-library');
const { buildAskArgs } = require('../lib/video/ask-claude');

test('words: Thai words are split by meaning, not by spaces', () => {
  const w = thaiWords('สวัสดีครับ ทุกคน');
  assert.ok(w.length >= 3);
  assert.strictEqual(w.join('').replace(/\s+/g, ''), 'สวัสดีครับทุกคน');
});

test('words: estimated timing covers the line end to end, in order', () => {
  const r = alignWords('อยากสร้างแอปด้วย AI', 2, 4);
  assert.strictEqual(r.timing, 'estimated');
  assert.strictEqual(r.words[0].start, 2);
  assert.strictEqual(r.words[r.words.length - 1].end, 4);
  for (let i = 1; i < r.words.length; i++) assert.ok(r.words[i].start >= r.words[i - 1].start);
});

test('words: trustworthy token times are used, untrustworthy ones are not', () => {
  const toks = [{ text: 'ab', start: 1.0 }, { text: 'cd', start: 1.5 }, { text: ' ef', start: 2.2 }];
  const good = alignWords('abcd ef', 1, 3, toks);
  assert.strictEqual(good.timing, 'tokens');
  assert.strictEqual(good.words.at(-1).start, 2.2);
  // all the same time (the model repeats one) → spread by letters instead
  const bad = alignWords('abcd ef', 1, 3, [{ text: 'ab', start: 1.1 }, { text: 'cd', start: 1.1 }, { text: ' ef', start: 1.1 }]);
  assert.strictEqual(bad.timing, 'estimated');
  // tokens that do not spell the text → not used
  assert.strictEqual(alignWords('abcd ef', 1, 3, [{ text: 'xx', start: 1 }, { text: 'yy', start: 2 }]).timing, 'estimated');
});

test('words: key words and phrases', () => {
  for (const k of ['AI', 'CODE', 'error', 'API', '2025', 'Claude']) assert.ok(isKeyWord(k), k);
  for (const k of ['สร้าง', 'and', '']) assert.ok(!isKeyWord(k), k);
  const ws = Array.from({ length: 9 }, (_, i) => ({ text: 'ab ', start: i, end: i + 1 }));
  for (const g of phrases(ws, { maxWords: 4, maxChars: 16 })) assert.ok(g.length <= 4);
  assert.strictEqual(phrases(ws).flat().length, 9);
});

test('words: stored words are used only while they still match the line', () => {
  const seg = { start: 1, end: 2, text: 'ab cd', words: [{ text: 'ab ', start: 1, end: 1.5 }, { text: 'cd', start: 1.5, end: 2 }] };
  assert.ok(validWords(seg));
  assert.strictEqual(validWords({ ...seg, text: 'ab xx' }), null, 'text edited by hand');
  assert.strictEqual(validWords({ ...seg, end: 3 }), null, 'time dragged');
});

test('captions: words follow the cut and the speed', () => {
  const clips = [{ id: 'c1', src: 's1', in: 10, out: 14, speed: 2 }];
  const segs = { s1: [{ start: 10, end: 14, text: 'ab cd', words: [{ text: 'ab ', start: 10, end: 12 }, { text: 'cd', start: 12, end: 14 }] }] };
  const [cap] = mapCaptions(clips, segs);
  assert.deepStrictEqual(cap.words.map((w) => [w.start, w.end]), [[0, 1], [1, 2]]);
  const lines = splitLines(cap, 22);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].words.length, 2);
});

test('word style: each word is its own element, shown at its time; key words are cyan', () => {
  const spec = {
    clips: [{ id: 'c1', src: 's1', in: 0, out: 4, speed: 1 }],
    sources: { s1: { file: 'assets/s1.mp4', kind: 'video', audio: true } },
    captions: [{ start: 0, end: 2, text: 'สร้าง AI', words: [{ text: 'สร้าง ', start: 0, end: 0.9 }, { text: 'AI', start: 0.9, end: 2 }] }],
    canvas: { width: 1080, height: 1920 },
    captionStyle: 'word',
  };
  const { html } = buildProject(spec);
  assert.match(html, /id="w-0-0" class="w">สร้าง</);
  assert.match(html, /id="w-0-1" class="w k">AI</);
  assert.match(html, /tl\.fromTo\("#w-0-1"[^;]*, 0\.9\);/);
  assert.match(html, /#12C8F5/);
  assert.match(html, /tl\.fromTo\("#w-0-0"[^;]*color: "#ffe14d"/, 'the word being said is highlighted');
  assert.doesNotMatch(html, /tl\.fromTo\("#w-0-1"[^;]*color: "#ffe14d"/, 'key words keep their cyan');
  // a line with no word times still gets one element per word
  const est = buildProject({ ...spec, captions: [{ start: 0, end: 2, text: 'สร้างแอปด้วย AI' }] }).html;
  assert.ok((est.match(/class="w( k)?"/g) || []).length >= 3);
});

test('frames: ffmpeg arguments, spread times, timeline to source', () => {
  const a = frames.frameArgs(path.resolve('/x/a.mp4'), 3.456, path.resolve('/t/o.jpg'));
  assert.ok(a.includes('-frames:v') && a.includes('3.46'));
  assert.throws(() => frames.frameArgs('a.mp4', 1, 'o.jpg'), /ที่อยู่/);
  assert.throws(() => frames.frameArgs(path.resolve('/x/a.mp4'), -1, 'o.jpg'), /เวลา/);
  assert.deepStrictEqual(frames.spreadTimes(10, 2), [2.5, 7.5]);
  assert.strictEqual(frames.spreadTimes(0, 3).length, 0);
  assert.strictEqual(frames.spreadTimes(100, 99).length, frames.MAX_FRAMES);
  const clips = [{ src: 'a', in: 10, out: 14, speed: 2 }, { src: 'b', in: 0, out: 3, speed: 1 }];
  assert.deepStrictEqual(frames.timelineToSource(clips, 1), { src: 'a', at: 12 });
  assert.deepStrictEqual(frames.timelineToSource(clips, 3), { src: 'b', at: 1 });
  assert.strictEqual(frames.timelineToSource(clips, 9), null);
});

test('frames: extractFrames reads each picture and removes the temp folder; a failed picture is skipped', async () => {
  const seen = [];
  const ff = {
    async require() { return { ffmpeg: 'ffmpeg' }; },
    async run(exe, args) {
      const out = args[args.length - 1];
      seen.push(path.dirname(out));
      if (args.includes('3')) return { code: 1 };
      fs.writeFileSync(out, Buffer.from([1, 2, 3]));
      return { code: 0 };
    },
  };
  const r = await frames.extractFrames(ff, [{ label: 'one', path: path.resolve('/x/a.mp4'), at: 1 }, { label: 'bad', path: path.resolve('/x/a.mp4'), at: 3 }], {});
  assert.deepStrictEqual(r.map((x) => x.label), ['one']);
  assert.strictEqual(r[0].data, Buffer.from([1, 2, 3]).toString('base64'));
  assert.ok(!fs.existsSync(seen[0]), 'temp folder removed');
  const c = frames.imageContent(r, 'intro', 'outro');
  assert.deepStrictEqual(c.map((b) => b.type), ['text', 'text', 'image', 'text']);
  assert.strictEqual(c[2].source.media_type, 'image/jpeg');
});

test('skill rules: no zoom and the sounds the skill names', () => {
  const skill = '- ห้ามเพิ่ม Zoom เข้าออก เพราะผู้ใช้จัดการไว้แล้ว\n- ใช้เสียง `Downloads/keyboard-typing-noise` ตามไฟล์ที่มีอยู่จริง\n';
  const r = skillRules(skill);
  assert.strictEqual(r.noZoom, true);
  assert.deepStrictEqual(r.localSounds, ['keyboard-typing-noise']);
  assert.deepStrictEqual(skillRules('ใช้ Scale-in สำหรับคำสำคัญ'), { noZoom: false, localSounds: [] });
  assert.strictEqual(skillRules('Do not zoom the video').noZoom, true);
});

test('local sounds are found by name inside one folder only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-dl-'));
  try {
    fs.writeFileSync(path.join(dir, 'keyboard-typing-noise.mp3'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    assert.strictEqual(findLocalSound(dir, 'keyboard-typing-noise'), path.join(dir, 'keyboard-typing-noise.mp3'));
    assert.strictEqual(findLocalSound(dir, 'Keyboard-Typing'), path.join(dir, 'keyboard-typing-noise.mp3'));
    assert.strictEqual(findLocalSound(dir, 'notes'), null, 'not an audio file');
    assert.strictEqual(findLocalSound(dir, '..\\secret'), null);
    assert.strictEqual(findLocalSound(dir, '../x'), null);
    assert.strictEqual(findLocalSound(path.join(dir, 'nope'), 'a'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('review: problems are read; an unreadable answer counts as nothing found', () => {
  const r = parseReview('```json\n{"ok":false,"problems":[{"graphic":"ป้ายชื่อ","issue":"ทับหน้า","fix":"ย้ายไปซ้าย"},{"issue":""}],"summary":"x"}\n```');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.problems, [{ graphic: 'ป้ายชื่อ', issue: 'ทับหน้า', fix: 'ย้ายไปซ้าย' }]);
  assert.strictEqual(parseReview('ดูดีแล้ว').ok, true);
  assert.strictEqual(parseReview('{"ok":true,"problems":[]}').ok, true);
  const p = buildReviewPrompt({ skill: { name: 'S', prompt: 'p' }, graphics: [{ name: 'ป้าย', start: 1, end: 3 }], canvas: { width: 1080, height: 1920 } });
  assert.match(p, /"ป้าย" · 1\.0–3\.0/);
});

test('graphics prompt tells Claude about the pictures and the no-zoom rule only when they apply', () => {
  const base = { skill: { name: 'S', prompt: 'p' }, lines: [], duration: 10, canvas: { width: 1080, height: 1920 } };
  assert.doesNotMatch(buildGraphicsPrompt(base), /แนบภาพ|ห้ามซูม/);
  const p = buildGraphicsPrompt({ ...base, looked: 6, rules: { noZoom: true } });
  assert.match(p, /แนบภาพ 6 ภาพ/);
  assert.match(p, /ห้ามซูมภาพวิดีโอ/);
});

test('ask: pictures go in as message content, the tools stay off', () => {
  const args = buildAskArgs({});
  assert.ok(args.includes('--tools') && args[args.indexOf('--tools') + 1] === '');
});

// ---- the whole cut: pictures in, skill rules kept, review after the render ----
const { VideoService } = require('../lib/video/service');
const { MediaRegistry } = require('../lib/video/media');
const { StyleStore } = require('../lib/video/styles');
const { SfxLibrary } = require('../lib/video/sfx-library');

test('cut: JARVIS looks at pictures, keeps the skill rules, reviews the render and fixes a graphic once', async () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-vis-'));
  const downloads = tmp();
  fs.writeFileSync(path.join(downloads, 'keyboard-typing-noise.mp3'), 'x');
  const clipFile = path.join(tmp(), 'a.mp4');
  fs.writeFileSync(clipFile, 'x');
  const graphic = (name, left) => ({
    name, start: 1, end: 4,
    markup: '<div class="t">{{title}}</div>', css: `.t{position:absolute;top:20%;left:${left}%;font-size:80px;color:#fff}`,
    vars: [{ id: 'title', label: 'หัวข้อ', type: 'text', value: 'อย่างแรก' }],
    tweens: [{ sel: '.t', at: 0, dur: 0.4, from: { y: 40, opacity: 0 }, to: { y: 0, opacity: 1 } }],
  });
  const asked = [];
  const ask = async (o) => {
    asked.push(o);
    if (/ผู้ตรวจงานตัดต่อ/.test(o.prompt)) return JSON.stringify({ ok: false, problems: [{ graphic: 'ป้ายชื่อ', issue: 'ทับหน้าคน', fix: 'ย้ายไปขวา' }, { graphic: 'ซับ', issue: 'ชิดขอบ', fix: '' }] });
    if (/ไม่ผ่านการตรวจของแอป/.test(o.prompt)) return JSON.stringify({ graphics: [graphic('ป้ายชื่อ', 60)] });
    if (/HyperFrames/.test(o.prompt)) return JSON.stringify({ graphics: [graphic('ป้ายชื่อ', 6)] });
    return '{"clips":[{"piece":"p1"},{"piece":"p2"}],"summary":"ตามลำดับ"}';
  };
  const ffmpeg = {
    async probe() { return { duration: 10, video: { width: 1080, height: 1920 }, audio: {} }; },
    async require() { return { ffmpeg: 'ffmpeg.exe' }; },
    async run(exe, args) { fs.writeFileSync(args[args.length - 1], 'JPEGDATA'); return { code: 0, stderr: '' }; },
  };
  const analyzer = {
    async analyze() {
      return { silences: [{ start: 4, end: 7 }], transcript: { model: 'small', segments: [{ start: 0, end: 4, text: 'สวัสดีครับ' }, { start: 7, end: 10, text: 'อย่างแรก' }] }, summary: { duration: 10 }, warnings: [] };
    },
  };
  const styles = new StyleStore({ file: path.join(tmp(), 'styles.json') });
  const skill = styles.importSkill({ name: 'สกิลทดสอบ', description: '', prompt: '- ห้ามเพิ่ม Zoom เข้าออก\n- ใช้เสียง `Downloads/keyboard-typing-noise` ตอนข้อความขึ้น', pace: 'normal', targetSec: 0 });
  const prepared = [];
  const events = [];
  const svc = new VideoService({
    registry: new MediaRegistry(), ffmpeg, analyzer, styles, ask, downloadsDir: downloads,
    sfxLibrary: new SfxLibrary({ dir: path.join(tmp(), 'lib'), ffmpeg }),
    hf: { prepare(id, spec) { prepared.push(spec); return tmp(); }, async render(dir, o) { fs.writeFileSync(o.out, 'mp4'); return o.out; } },
    emit: (ch, p) => events.push([ch, p]),
  });
  await svc.importFiles([clipFile]);
  await new Promise((r) => setTimeout(r, 20));
  svc.startCut({ styleId: skill.id, captionStyle: 'word' });
  const cut = await new Promise((resolve) => { const t = setInterval(() => { const l = events.filter(([c]) => c === 'video:cut').pop(); if (l && !l[1].running) { clearInterval(t); resolve(l[1]); } }, 5); });
  assert.strictEqual(cut.result.ok, true, cut.result.error);
  // 1. Claude was shown pictures (cut, graphics, review)
  const withPictures = asked.filter((o) => Array.isArray(o.content) && o.content.some((b) => b.type === 'image'));
  assert.strictEqual(withPictures.length, 3, "the cut, the graphics, and the review of the render");
  assert.match(asked[1].prompt, /ห้ามซูมภาพวิดีโอ/);
  assert.match(asked[1].prompt, /ห้ามทับหน้าและมือ/);
  // 2. the rules of the skill: no-zoom said, the named sound found in Downloads and put on the graphic
  assert.match(cut.result.done.join(' '), /ไม่ใส่เอฟเฟกต์ซูม/);
  assert.match(cut.result.done.join(' '), /ใส่เสียง เสียง keyboard-typing-noise/);
  const [ov] = svc.history.list.overlays;
  assert.match(ov.sfx, /^dl-[0-9a-f]{8}$/);
  // 3. the render, then the review, then one fix and one more render
  await new Promise((resolve) => { const t = setInterval(() => { const l = events.filter(([c]) => c === 'video:render').pop(); if (l && !l[1].running && prepared.length >= 2) { clearInterval(t); resolve(); } }, 5); });
  assert.strictEqual(prepared.length, 2, 'built again after the fix');
  assert.match(prepared[0].html, /left:6%/);
  assert.match(prepared[1].html, /left:60%/, 'the fixed graphic is in the second page');
  assert.match(prepared[1].html, /id="w-0-0"/, 'word-by-word subtitles');
  assert.ok(prepared[1].extra.some((e) => /^sfx-dl-/.test(e.name)), 'the local sound goes into the page');
  const last = svc.snapshot().lastRender;
  assert.strictEqual(last.ok, true);
  assert.match(last.review, /แก้กราฟิกให้ 1 ชิ้น/);
  assert.match(last.review, /ชิดขอบ/);
  assert.strictEqual(svc.history.list.overlays[0].sfx, ov.sfx, 'the sound survives the fix');
});

test('import and a skill cut only deal with pauses and graphics: no speech-to-text, no subtitles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-imp-'));
  const clip = path.join(dir, 'a.mp4');
  fs.writeFileSync(clip, 'x');
  const calls = [];
  const analyzer = {
    async analyze(p, o) {
      calls.push(o.transcribe);
      return { silences: [{ start: 4, end: 7 }], transcript: o.transcribe ? { model: 'm', segments: [{ start: 0, end: 4, text: 'สวัสดีครับ' }, { start: 7, end: 10, text: 'อย่างแรก' }] } : null, summary: {}, warnings: [] };
    },
  };
  const events = [];
  const svc = new VideoService({
    registry: new MediaRegistry(), analyzer, styles: new StyleStore({ file: path.join(dir, 's.json') }),
    ffmpeg: { async probe() { return { duration: 10, video: { width: 1080, height: 1920 }, audio: {} }; } },
    ask: async () => '{"clips":[{"piece":"p1"},{"piece":"p2"}],"summary":"x"}', emit: (c, p) => events.push([c, p]),
  });
  await svc.importFiles([clip]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls, [false], 'import: no speech-to-text');
  assert.strictEqual(svc.snapshot().sources[0].analysis.transcript, null);
  svc.startCut({ styleId: 'viral' });
  const cut = await new Promise((resolve) => { const t = setInterval(() => { const l = events.filter(([c]) => c === 'video:cut').pop(); if (l && !l[1].running) { clearInterval(t); resolve(l[1]); } }, 5); });
  assert.strictEqual(cut.result.ok, true, cut.result.error);
  assert.deepStrictEqual(calls, [false], 'the cut does not transcribe');
  assert.strictEqual(svc.snapshot().sources[0].analysis.transcript, null);
  assert.strictEqual(svc.snapshot().captions.length, 0, 'no subtitles unless the button was pressed');
});

test('the subtitles button transcribes, then JARVIS checks the words by itself; nothing to do is said', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-subs-'));
  const clip = path.join(dir, 'a.mp4');
  fs.writeFileSync(clip, 'x');
  const calls = [];
  const analyzer = { async analyze(p, o) { calls.push(o.transcribe); return { silences: [], transcript: o.transcribe ? { model: 'm', segments: [{ start: 0, end: 2, text: 'สวัสดี' }] } : null, summary: {}, warnings: [] }; } };
  const svc = new VideoService({
    registry: new MediaRegistry(), analyzer, styles: new StyleStore({ file: path.join(dir, 's.json') }), ask: async () => '{"fixes":[{"i":0,"text":"สวัสดีครับ"}]}',
    ffmpeg: { async probe() { return { duration: 5, video: { width: 1080, height: 1920 }, audio: {} }; } },
  });
  assert.throws(() => svc.makeSubtitles(), /ยังไม่มีคลิป/);
  await svc.importFiles([clip]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(svc.makeSubtitles(), { queued: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls, [false, true]);
  assert.strictEqual(svc.snapshot().sources[0].analysis.transcript.segments[0].text, 'สวัสดีครับ', 'JARVIS fixed the word');
  assert.strictEqual(svc.snapshot().lastSubs.changed, 1);
  assert.strictEqual(svc.snapshot().subs, null);
  assert.throws(() => svc.makeSubtitles(), /มีซับแล้ว/);
  svc.editCaption({ sourceId: 's1', i: 0, text: 'แก้แล้ว' });
  assert.strictEqual(svc.snapshot().sources[0].analysis.transcript.segments[0].text, 'แก้แล้ว');
});
