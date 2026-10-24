'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ProjectTools, detectChecks, summarizeOutput, firstError } = require('../lib/coding/project-tools');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pt-'));
}
const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', windowsHide: true });

function repo() {
  const d = tmp();
  g(d, 'init', '-q');
  g(d, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(d, 'b.txt'), 'bee\n');
  g(d, 'add', '.');
  g(d, 'commit', '-qm', 'init');
  return d;
}
const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');

test('detectChecks: npm scripts, default npm test ignored, other languages', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  assert.deepStrictEqual(detectChecks(d), { test: { command: 'npm test' }, check: { command: 'npm run lint' } });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', check: 'x' } }));
  assert.deepStrictEqual(detectChecks(d), { test: null, check: { command: 'npm run check' } });
  const r = tmp();
  fs.writeFileSync(path.join(r, 'Cargo.toml'), '');
  assert.deepStrictEqual(detectChecks(r), { test: { command: 'cargo test' }, check: { command: 'cargo check' } });
  assert.deepStrictEqual(detectChecks(tmp()), { test: null, check: null });
});

test('summarizeOutput / firstError understand common runners', () => {
  assert.deepStrictEqual(summarizeOutput('ok 1\n# pass 12\n# fail 2\n'), { passed: 12, failed: 2 });
  assert.deepStrictEqual(summarizeOutput('Tests:       1 failed, 5 passed, 6 total'), { passed: 5, failed: 1 });
  assert.deepStrictEqual(summarizeOutput('===== 3 passed, 1 failed in 0.52s ====='), { passed: 3, failed: 1 });
  assert.deepStrictEqual(summarizeOutput('test result: ok. 4 passed; 0 failed; 0 ignored'), { passed: 4, failed: 0 });
  assert.strictEqual(summarizeOutput('hello'), null);
  assert.strictEqual(firstError('# fail 0\nok 1\nnot ok 2 - adds numbers\n'), 'not ok 2 - adds numbers');
});

test('run: reports pass/fail, missing command, and cancel', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(\'# pass 3\')"', check: 'node -e "console.error(\'Error: boom\');process.exit(2)"' } }));
  const pt = new ProjectTools();
  const ok = await pt.run('test', d);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.counts, { passed: 3, failed: 0 });
  const bad = await pt.run('check', d);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.exitCode, 2);
  assert.match(bad.error, /boom/);
  await assert.rejects(pt.run('test', tmp()), /ไม่พบคำสั่งเทสต์/);

  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "setTimeout(()=>{},60000)"' } }));
  const p = pt.run('test', d);
  await assert.rejects(pt.run('test', d), /กำลังรันอยู่แล้ว/);
  setTimeout(() => pt.cancel(), 300);
  const c = await p;
  assert.strictEqual(c.cancelled, true);
  assert.strictEqual(c.ok, false);
  assert.strictEqual(pt.running, false);
});

test('diff shows the latest turn, else everything uncommitted', () => {
  const d = repo();
  const pt = new ProjectTools();
  fs.writeFileSync(path.join(d, 'b.txt'), 'bee\nuser edit\n'); // before any turn
  let r = pt.diff(d);
  assert.strictEqual(r.scope, 'uncommitted');
  assert.deepStrictEqual(r.files.map((f) => f.file), ['b.txt']);
  assert.ok(pt.snapshot(d));
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\n'); // "Claude" edits
  fs.writeFileSync(path.join(d, 'new.txt'), 'x\n');
  r = pt.diff(d);
  assert.strictEqual(r.scope, 'turn');
  assert.deepStrictEqual(r.files, [{ file: 'a.txt', add: 1, del: 0 }]);
  assert.deepStrictEqual(r.created, ['new.txt']);
  assert.match(r.patch, /\+two/);
  assert.throws(() => pt.diff(tmp()), /ไม่ใช่ git/);
});

test('undo restores the last turn only, keeps earlier user changes, trashes new files', async () => {
  const d = repo();
  const trashed = [];
  const pt = new ProjectTools({ trash: (p) => { trashed.push(path.basename(p)); fs.rmSync(p); } });
  fs.writeFileSync(path.join(d, 'b.txt'), 'bee\nuser edit\n'); // uncommitted, before the turn
  fs.writeFileSync(path.join(d, 'notes.txt'), 'mine\n'); // untracked, before the turn
  assert.strictEqual(pt.undoPreview(d).ok, false); // no snapshot yet
  pt.snapshot(d);
  assert.strictEqual(pt.undoPreview(d).ok, false); // nothing changed since
  // the turn: edit, delete, create, and stage a new file
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(d, 'b.txt'), 'claude edit\n');
  fs.rmSync(path.join(d, 'notes.txt'));
  fs.writeFileSync(path.join(d, 'gen.js'), '1');
  fs.writeFileSync(path.join(d, 'staged.js'), '2');
  g(d, 'add', 'staged.js', 'a.txt');
  const p = pt.undoPreview(d);
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.restore.sort(), ['a.txt', 'b.txt']);
  assert.deepStrictEqual(p.remove.sort(), ['gen.js', 'staged.js']);
  assert.strictEqual((await pt.undo(d, 'bogus')).ok, false);
  const r = await pt.undo(d, p.token);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(read(d, 'a.txt'), 'one\n');
  assert.strictEqual(read(d, 'b.txt'), 'bee\nuser edit\n'); // the user's own pre-turn edit survives
  assert.deepStrictEqual(trashed.sort(), ['gen.js', 'staged.js']);
  assert.ok(r.safety, 'state before undo is saved');
  assert.strictEqual(g(d, 'status', '--porcelain').trim(), 'M b.txt'); // a.txt unstaged again, staged.js gone
  // notes.txt was untracked: git can't bring it back, and undo says nothing about it
  assert.strictEqual(fs.existsSync(path.join(d, 'notes.txt')), false);
  assert.strictEqual(pt.undoPreview(d).ok, false);
});

test('undo goes to the newest snapshot that differs from now', async () => {
  const d = repo();
  const pt = new ProjectTools();
  pt.snapshot(d); // turn 1
  fs.writeFileSync(path.join(d, 'a.txt'), 'turn1\n');
  pt.snapshot(d); // turn 2 (changes nothing)
  pt.snapshot(d); // turn 3 (changes nothing) — same state, not stored twice
  assert.strictEqual(pt.snapshots.length, 2);
  const p = pt.undoPreview(d);
  assert.deepStrictEqual(p.restore, ['a.txt']);
  await pt.undo(d, p.token);
  assert.strictEqual(read(d, 'a.txt'), 'one\n');
  pt.reset();
  assert.strictEqual(pt.snapshots.length, 0);
});

test('diff splits the patch per file and gives a token for a turn', () => {
  const d = repo();
  const pt = new ProjectTools();
  pt.snapshot(d);
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(d, 'b.txt'), 'bee2\n');
  const r = pt.diff(d);
  assert.ok(r.token);
  assert.deepStrictEqual(Object.keys(r.patches).sort(), ['a.txt', 'b.txt']);
  assert.match(r.patches['a.txt'], /\+changed/);
  assert.ok(!r.patches['a.txt'].includes('bee2'));
});

test('undo of chosen files leaves the other changes and keeps the snapshot', async () => {
  const d = repo();
  const trashed = [];
  const pt = new ProjectTools({ trash: (p) => { trashed.push(path.basename(p)); fs.rmSync(p); } });
  pt.snapshot(d);
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed a\n');
  fs.writeFileSync(path.join(d, 'b.txt'), 'changed b\n');
  fs.writeFileSync(path.join(d, 'gen.js'), '1');
  const p = pt.undoPreview(d, ['a.txt']);
  assert.deepStrictEqual(p.restore, ['a.txt']);
  assert.deepStrictEqual(p.remove, []);
  assert.strictEqual(pt.undoPreview(d, ['nope.txt']).ok, false);
  const r = await pt.undo(d, p.token, ['a.txt']);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(read(d, 'a.txt'), 'one\n');
  assert.strictEqual(read(d, 'b.txt'), 'changed b\n'); // not chosen: stays
  assert.strictEqual(pt.snapshots.length, 1, 'snapshot kept while other files differ');
  // a created file can be undone on its own, then the last one clears the snapshot
  const g1 = await pt.undo(d, pt.undoPreview(d, ['gen.js']).token, ['gen.js']);
  assert.deepStrictEqual(g1.removed, ['gen.js']);
  assert.deepStrictEqual(trashed, ['gen.js']);
  await pt.undo(d, pt.undoPreview(d, ['b.txt']).token, ['b.txt']);
  assert.strictEqual(pt.snapshots.length, 0);
  assert.strictEqual(read(d, 'b.txt'), 'bee\n');
});
