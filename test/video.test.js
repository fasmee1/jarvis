'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/video/edit-list');
const { BUILTIN_STYLES, PACES, cutParams, builtin } = require('../lib/video/presets');
const getPreset = (id) => cutParams(builtin(id));
const { autoEdit, keepRanges } = require('../lib/video/auto-edit');
const F = require('../lib/video/ffmpeg-args');

const SRC = { id: 's1', path: 'C:/clips/a.mp4', duration: 60 };
const base = () => E.addClip(E.emptyList([SRC]), { src: 's1', in: 0, out: 10 });

test('presets: four built-in styles with a prompt, a known pace and a target length', () => {
  assert.deepStrictEqual(BUILTIN_STYLES.map((s) => s.id), ['viral', 'educational', 'vlog', 'promo']);
  for (const s of BUILTIN_STYLES) {
    assert.ok(s.name && s.prompt.length > 40 && PACES[s.pace] && s.targetSec > 0, s.id);
  }
  assert.strictEqual(builtin('nope'), null);
  assert.strictEqual(builtin('constructor'), null);
});

test('presets: cut params follow the pace; 0 length means no limit', () => {
  assert.deepStrictEqual(cutParams({ id: 'u1', pace: 'slow', targetSec: 45 }), { id: 'u1', silenceMs: 1200, padMs: 250, minKeepMs: 1000, speed: 1, targetSec: 45 });
  assert.strictEqual(cutParams({ pace: 'fast', targetSec: 0 }).targetSec, Infinity);
  assert.strictEqual(cutParams({ pace: 'weird' }).silenceMs, PACES.normal.silenceMs);
  assert.strictEqual(cutParams(null).id, 'normal');
});

test('edit-list: split keeps total length and does not touch the source', () => {
  const a = base();
  const b = E.splitAt(a, 4);
  assert.strictEqual(b.clips.length, 2);
  assert.strictEqual(b.clips[0].out, 4);
  assert.strictEqual(b.clips[1].in, 4);
  assert.strictEqual(E.totalLength(b), 10);
  assert.strictEqual(a.clips.length, 1); // input list unchanged
  assert.throws(() => E.splitAt(a, 0), E.EditError);
  assert.throws(() => E.splitAt(a, 10), E.EditError);
});

test('edit-list: split respects speed', () => {
  const l = E.setSpeed(base(), 'c1', 2); // 10s of source plays in 5s
  const s = E.splitAt(l, 1); // 1s of timeline = 2s of source
  assert.strictEqual(s.clips[0].out, 2);
});

test('edit-list: trim, remove (no gap), move, setSpeed, validation', () => {
  let l = E.splitAt(base(), 5);
  l = E.trim(l, 'c1', { in: 1 });
  assert.strictEqual(E.totalLength(l), 9);
  l = E.remove(l, 'c1');
  assert.strictEqual(l.clips.length, 1);
  assert.strictEqual(E.totalLength(l), 5);
  assert.throws(() => E.trim(l, 'c2', { out: 100 }), E.EditError); // past source end
  assert.throws(() => E.setSpeed(l, 'c2', 9), E.EditError);
  assert.throws(() => E.remove(l, 'zzz'), E.EditError);
  let m = E.addClip(base(), { src: 's1', in: 20, out: 25 });
  m = E.move(m, 'c2', 0);
  assert.deepStrictEqual(m.clips.map((c) => c.id), ['c2', 'c1']);
  assert.deepStrictEqual(E.validate(m), []);
});

test('edit-list: history undo/redo, failed edit leaves history alone', () => {
  const h = new E.EditHistory(base());
  h.apply(E.splitAt, 4);
  h.apply(E.remove, 'c1');
  assert.strictEqual(h.list.clips.length, 1);
  assert.throws(() => h.apply(E.remove, 'nope'), E.EditError);
  assert.strictEqual(h.past.length, 2);
  h.undo(); h.undo();
  assert.strictEqual(h.list.clips.length, 1);
  assert.strictEqual(h.list.clips[0].out, 10);
  h.redo();
  assert.strictEqual(h.list.clips.length, 2);
  h.undo();
  h.apply(E.setSpeed, 'c1', 1.5);
  assert.strictEqual(h.redo(), null); // new edit clears redo
  assert.strictEqual(h.undo().clips[0].speed, 1);
  assert.strictEqual(new E.EditHistory().undo(), null);
});

test('auto-edit: cuts long pauses, keeps speech with padding', () => {
  const preset = { ...getPreset('viral'), targetSec: 1000, speed: 1 };
  const r = keepRanges(20, [{ start: 5, end: 8 }, { start: 10, end: 10.1 }], preset);
  assert.strictEqual(r.length, 2); // the 0.1s pause is shorter than silenceMs, so it stays
  assert.ok(Math.abs(r[0].end - 5.06) < 1e-9);
  assert.ok(Math.abs(r[1].start - 7.94) < 1e-9);
});

test('auto-edit: builds a valid list and respects target length', () => {
  const preset = { ...getPreset('viral'), targetSec: 12, speed: 1 };
  const { list, report } = autoEdit({ source: SRC, silences: [{ start: 10, end: 20 }, { start: 30, end: 40 }], preset });
  assert.deepStrictEqual(E.validate(list), []);
  assert.ok(E.totalLength(list) <= 12 + 1e-6);
  assert.strictEqual(report.truncated, true);
  assert.strictEqual(report.presetId, 'viral');
});

test('auto-edit: styles give different cuts on the same clip', () => {
  const silences = [{ start: 5, end: 5.6 }, { start: 15, end: 17 }];
  const viral = autoEdit({ source: SRC, silences, preset: { ...getPreset('viral'), targetSec: 1000 } });
  const edu = autoEdit({ source: SRC, silences, preset: { ...getPreset('educational'), targetSec: 1000 } });
  assert.ok(viral.list.clips.length > edu.list.clips.length);
});

test('auto-edit: rejects unknown duration', () => {
  assert.throws(() => autoEdit({ source: { id: 'x' }, preset: getPreset('vlog') }));
});

test('ffmpeg: atempo chain stays inside 0.5..2', () => {
  assert.strictEqual(F.atempoChain(1.5), 'atempo=1.500');
  assert.strictEqual(F.atempoChain(4), 'atempo=2.000,atempo=2.000');
  assert.ok(F.atempoChain(0.25).startsWith('atempo=0.500'));
});

test('ffmpeg: silence args are an array and parse works', () => {
  const a = F.buildSilenceDetectArgs('C:/clips/a.mp4');
  assert.ok(Array.isArray(a) && a.includes('silencedetect=noise=-30.000dB:d=0.250'));
  assert.throws(() => F.buildSilenceDetectArgs('a.mp4'));
  const log = '[silencedetect] silence_start: 1.5\n[silencedetect] silence_end: 3.25 | silence_duration: 1.75\n[silencedetect] silence_start: 58';
  assert.deepStrictEqual(F.parseSilence(log, 60), [{ start: 1.5, end: 3.25 }, { start: 58, end: 60 }]);
});

test('ffmpeg: export args are an array, path stays one argument', () => {
  const sp = { ...SRC, path: 'C:/my clips/a & b;rm.mp4' };
  let l = E.addClip(E.emptyList([sp]), { src: 's1', in: 0, out: 5 });
  l = E.addClip(l, { src: 's1', in: 10, out: 12, speed: 2 });
  const args = F.buildExportArgs({ list: l, output: 'C:/out/x.mp4' });
  assert.ok(Array.isArray(args));
  assert.ok(args.includes(sp.path));
  assert.strictEqual(args[args.length - 1], 'C:/out/x.mp4');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(graph.includes('concat=n=2:v=1:a=1[v][a]'));
  assert.ok(graph.includes('scale=1080:1920'));
  assert.throws(() => F.buildExportArgs({ list: E.emptyList([sp]), output: 'C:/o.mp4' }));
  assert.throws(() => F.buildExportArgs({ list: l, output: 'C:/o.mov' }));
  assert.throws(() => F.buildExportArgs({ list: l, output: 'C:/o.mp4', aspect: '2:1' }));
});

test('effects: ids, tweens and sound commands', () => {
  const fxm = require('../lib/video/effects');
  assert.ok(fxm.isFx('flash') && !fxm.isFx('explode') && !fxm.isFx('__proto__') && !fxm.isFx('toString'));
  assert.ok(fxm.isSfx('whoosh') && !fxm.isSfx('constructor'));
  assert.deepStrictEqual(fxm.fxTween('none', { video: 'm-c1', flash: 'fx-0', at: 3 }), []);
  assert.deepStrictEqual(fxm.fxTween('nope', { video: 'm-c1', flash: 'fx-0', at: 3 }), []);
  assert.match(fxm.fxTween('zoom', { video: 'm-c1', flash: 'fx-0', at: 3.0004 })[0], /^tl\.fromTo\("#m-c1", \{ scale: 1\.2 \}.*, 3\);$/);
  assert.match(fxm.fxTween('flash', { video: 'm-c1', flash: 'fx-2', at: 1 })[0], /"#fx-2"/);
  assert.strictEqual(fxm.sfxLead('whoosh'), 0.12);
  assert.strictEqual(fxm.sfxLead('pop'), 0);
  assert.strictEqual(fxm.sfxLead('none'), 0);
  for (const id of ['whoosh', 'pop', 'ding', 'click']) {
    const args = fxm.sfxArgs(id, 'C:/t/x.wav');
    assert.ok(args.every((a) => typeof a === 'string') && args[args.length - 1] === 'C:/t/x.wav' && args.includes('-y'));
  }
  assert.throws(() => fxm.sfxArgs('none', 'x.wav'), /ไม่รู้จัก/);
  assert.throws(() => fxm.sfxArgs('rm -rf', 'x.wav'), /ไม่รู้จัก/);
});

test('edit-list: effects are set per clip or for every cut, validated, undoable; a split comes in plain', () => {
  const E2 = require('../lib/video/edit-list');
  let list = E2.emptyList([{ id: 's1', path: 'x', duration: 20 }]);
  list = E2.addClip(list, { src: 's1', in: 0, out: 10 });
  assert.throws(() => E2.applyOp(list, { op: 'fx-all', fx: 'flash' }), /อย่างน้อย 2 ช่วง/);
  list = E2.splitAt(list, 5);
  list = E2.applyOp(list, { op: 'fx', id: list.clips[0].id, fx: 'fade', sfx: 'pop' });
  assert.strictEqual(list.clips[0].fx, 'fade');
  const again = E2.splitAt(list, 2);
  assert.strictEqual(again.clips[0].fx, 'fade', 'the first half keeps it');
  assert.strictEqual(again.clips[1].fx, 'none');
  assert.strictEqual(again.clips[1].sfx, 'none');
  assert.throws(() => E2.applyOp(list, { op: 'fx', id: list.clips[0].id, fx: 'explode' }), /เอฟเฟกต์ภาพไม่รู้จัก/);
  assert.throws(() => E2.applyOp(list, { op: 'fx', id: list.clips[0].id, sfx: '__proto__' }), /เสียงเอฟเฟกต์ไม่รู้จัก/);
  const all = E2.applyOp(list, { op: 'fx-all', fx: 'zoom', sfx: 'ding' });
  assert.deepStrictEqual(all.clips.map((c) => c.fx), ['fade', 'zoom'], 'the first clip has no cut before it');
  const only = E2.applyOp(all, { op: 'fx-all', sfx: 'none' });
  assert.deepStrictEqual(only.clips.map((c) => c.fx), ['fade', 'zoom'], 'only what is passed changes');
  assert.strictEqual(only.clips[1].sfx, 'none');
  const h = new E2.EditHistory(list);
  h.apply(E2.applyOp, { op: 'fx-all', fx: 'blur' });
  assert.strictEqual(h.list.clips[1].fx, 'blur');
  h.undo();
  assert.strictEqual(h.list.clips[1].fx, 'none', 'undo puts back what it was');
});

test('project: effects become tweens, a flash layer and sounds placed just before the cut', () => {
  const { buildProject } = require('../lib/video/hf-project');
  const clips = [
    { id: 'c1', src: 's1', in: 0, out: 3, speed: 1, fx: 'fade' },
    { id: 'c2', src: 's1', in: 5, out: 8, speed: 1, fx: 'flash', sfx: 'whoosh' },
    { id: 'c3', src: 'a1', in: 0, out: 2, speed: 1, fx: 'zoom', sfx: 'ding' },
  ];
  const { html } = buildProject({
    clips,
    sources: { s1: { file: 'assets/s1.mp4', kind: 'video', audio: true }, a1: { file: 'assets/a1.mp3', kind: 'audio', audio: true } },
    canvas: { width: 1080, height: 1920 },
    sfxFiles: { whoosh: 'assets/sfx-whoosh.wav' },
  });
  assert.match(html, /tl\.fromTo\("#m-c1", \{ opacity: 0 \}/);
  assert.match(html, /<div id="fx-1" class="clip fx-flash" data-start="3" data-duration="0\.3"/);
  assert.match(html, /<audio id="sfx-1" src="assets\/sfx-whoosh\.wav" data-start="2\.88"/);
  assert.ok(!/#m-c3/.test(html), 'no picture effect on an audio clip');
  assert.ok(!/sfx-2/.test(html), 'a sound without a file plays nothing');
});

test('effects out: ids, tweens, split keeps the way out at the end, set for every cut but the last', () => {
  const fxm = require('../lib/video/effects');
  const E3 = require('../lib/video/edit-list');
  assert.ok(fxm.isFxOut('fade') && !fxm.isFxOut('flash') && !fxm.isFxOut('toString'));
  assert.deepStrictEqual(fxm.fxOutTween('none', { video: 'm-c1', end: 5 }), []);
  assert.match(fxm.fxOutTween('fade', { video: 'm-c1', end: 5 })[0], /^tl\.to\("#m-c1", \{ opacity: 0, duration: 0\.4.*, 4\.6\);$/);
  assert.match(fxm.fxOutTween('zoom', { video: 'm-c1', end: 0.2 })[0], /, 0\);$/, 'never before time 0');
  let list = E3.emptyList([{ id: 's1', path: 'x', duration: 20 }]);
  list = E3.addClip(list, { src: 's1', in: 0, out: 10 });
  list = E3.applyOp(list, { op: 'fx', id: list.clips[0].id, fxOut: 'slide' });
  const cut = E3.splitAt(list, 4);
  assert.strictEqual(cut.clips[0].fxOut, 'none', 'the first half no longer ends the clip');
  assert.strictEqual(cut.clips[1].fxOut, 'slide', 'the second half does');
  assert.throws(() => E3.applyOp(list, { op: 'fx', id: list.clips[0].id, fxOut: 'flash' }), /เอฟเฟกต์ตอนออกไม่รู้จัก/);
  const three = E3.splitAt(cut, 7);
  const all = E3.applyOp(three, { op: 'fx-all', fx: 'zoom', fxOut: 'fade' });
  assert.deepStrictEqual(all.clips.map((c) => c.fx || 'none'), ['none', 'zoom', 'zoom']);
  assert.deepStrictEqual(all.clips.map((c) => c.fxOut), ['fade', 'fade', 'slide'], 'the last clip keeps its own way out');
  const { buildProject } = require('../lib/video/hf-project');
  const { html } = buildProject({ clips: all.clips, sources: { s1: { file: 'assets/s1.mp4', kind: 'video', audio: true } }, canvas: { width: 1080, height: 1920 } });
  assert.match(html, /tl\.to\("#m-c1", \{ opacity: 0, duration: 0\.4/);
});

test('overlays: add, update, remove are checked, numbered and undoable', () => {
  const E4 = require('../lib/video/edit-list');
  let list = E4.emptyList([{ id: 's1', path: 'x', duration: 20 }]);
  list = E4.addClip(list, { src: 's1', in: 0, out: 10 });
  list = E4.applyOp(list, { op: 'overlay-add', overlay: { kind: 'title', text: '  ข้อ 1   ห้ามพลาด ', start: 1, end: 4 } });
  list = E4.applyOp(list, { op: 'overlay-add', overlay: { kind: 'lower', text: 'ฟัซมี', text2: 'ผู้สร้าง', start: 4, end: 7 } });
  list = E4.applyOp(list, { op: 'overlay-add', overlay: { kind: 'counter', text: 'ผู้ติดตาม', to: 12500, suffix: '+', start: 5, end: 9 } });
  assert.deepStrictEqual(list.overlays.map((o) => o.id), ['o1', 'o2', 'o3']);
  assert.strictEqual(list.overlays[0].text, 'ข้อ 1 ห้ามพลาด');
  assert.deepStrictEqual([list.overlays[2].from, list.overlays[2].to, list.overlays[2].suffix], [0, 12500, '+']);
  assert.strictEqual(list.overlays[0].text2, '', 'only a name tag has a second line');
  const upd = E4.applyOp(list, { op: 'overlay-update', id: 'o1', overlay: { text: 'เปลี่ยนแล้ว', end: 5 } });
  assert.deepStrictEqual([upd.overlays[0].text, upd.overlays[0].start, upd.overlays[0].end], ['เปลี่ยนแล้ว', 1, 5]);
  assert.strictEqual(E4.applyOp(upd, { op: 'overlay-remove', id: 'o2' }).overlays.length, 2);
  const again = E4.applyOp(E4.applyOp(list, { op: 'overlay-remove', id: 'o3' }), { op: 'overlay-add', overlay: { kind: 'title', text: 'ใหม่', start: 0, end: 1 } });
  assert.strictEqual(again.overlays[2].id, 'o4', 'ids are never reused');
  const bad = (o) => () => E4.applyOp(list, { op: 'overlay-add', overlay: o });
  assert.throws(bad({ kind: 'confetti', text: 'x', start: 0, end: 2 }), /ชนิดอนิเมชั่น/);
  assert.throws(bad({ kind: 'title', text: '  ', start: 0, end: 2 }), /ว่างไม่ได้/);
  assert.throws(bad({ kind: 'title', text: 'ก'.repeat(61), start: 0, end: 2 }), /ยาวเกินไป/);
  assert.throws(bad({ kind: 'title', text: 'x', start: -1, end: 2 }), /เวลาอนิเมชั่น/);
  assert.throws(bad({ kind: 'title', text: 'x', start: 1, end: 1.2 }), /อย่างน้อย 0\.5/);
  assert.throws(bad({ kind: 'title', text: 'x', start: 0, end: 31 }), /ไม่เกิน 30/);
  assert.throws(bad({ kind: 'counter', text: '', start: 0, end: 2 }), /ตัวเลข/);
  assert.throws(bad({ kind: 'counter', to: 1e12, start: 0, end: 2 }), /พันล้าน/);
  assert.throws(() => E4.applyOp(list, { op: 'overlay-update', id: 'zzz', overlay: {} }), /ไม่พบอนิเมชั่น/);
  assert.throws(() => E4.applyOp(list, { op: 'overlay-remove', id: 'zzz' }), /ไม่พบอนิเมชั่น/);
  const h = new E4.EditHistory(list);
  h.apply(E4.applyOp, { op: 'overlay-remove', id: 'o1' });
  assert.strictEqual(h.list.overlays.length, 2);
  h.undo();
  assert.strictEqual(h.list.overlays.length, 3);
});

test('project: overlays become a title pill, a name tag and a counting number; text is escaped', () => {
  const { buildProject } = require('../lib/video/hf-project');
  const overlays = [
    { id: 'o1', kind: 'title', text: 'a <b> & "q"', start: 1, end: 4 },
    { id: 'o2', kind: 'lower', text: 'ฟัซมี', text2: 'ผู้สร้าง', start: 4, end: 8 },
    { id: 'o3', kind: 'counter', text: 'ผู้ติดตาม', from: 0, to: 12500, suffix: '+', start: 5, end: 9 },
    { id: 'o4', kind: 'title', text: 'past the end', start: 20, end: 25 },
    { id: 'o5', kind: 'title', text: 'cut by the end', start: 9.9, end: 14 },
  ];
  const { html } = buildProject({ clips: [{ id: 'c1', src: 's1', in: 0, out: 10, speed: 1 }], sources: { s1: { file: 'assets/s1.mp4', kind: 'video', audio: true } }, canvas: { width: 1080, height: 1920 }, overlays });
  assert.match(html, /<div id="ov-0" class="clip ov ov-title" data-start="1" data-duration="3" data-track-index="12"><span>a &lt;b&gt; &amp; &quot;q&quot;<\/span>/);
  assert.match(html, /<div class="ov-name">ฟัซมี<\/div><div class="ov-role">ผู้สร้าง<\/div>/);
  assert.match(html, /<div id="ov-2-n">0\+<\/div><div class="ov-label">ผู้ติดตาม<\/div>/);
  assert.match(html, /const st2 = \{ v: 0 \}; tl\.to\(st2, \{ v: 12500, duration: 2,/);
  assert.ok(!/past the end/.test(html) && !/cut by the end/.test(html), 'outside the video, or too short to see');
  assert.ok(!/<ov/.test(html));
});
