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
