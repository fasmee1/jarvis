'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildSystemPrompt } = require('../lib/prompt');

test('prompt: asks which folder to work in before file / git commands', () => {
  const p = buildSystemPrompt();
  assert.match(p, /ยังไม่ได้ระบุโฟลเดอร์ทำงาน/);
  assert.match(p, /AskUserQuestion/);
  assert.match(p, /เลือกโฟลเดอร์ใหม่/);
  assert.match(p, /ไม่ต้องถามซ้ำ/);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SettingsStore } = require('../lib/settings');
const { JarvisCore } = require('../lib/jarvis-core');

test('folder picker: /code-review asks once per conversation, choice is remembered', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pick-'));
  const core = new JarvisCore({ settings: new SettingsStore(tmp()), tempDir: tmp(), ui: () => {}, appRoot: tmp(), logDir: tmp() });
  core.warm = () => {};
  const repo = tmp();
  fs.mkdirSync(path.join(repo, '.git'));
  const plain = tmp();
  core.settings.update({ addDirs: [repo] });
  core.setCwd(plain, { silent: true });
  assert.throws(() => core.send({ text: '/code-review' }), { code: 'PICK_FOLDER' });
  assert.deepStrictEqual(core.folderOptions().map((o) => [o.path, o.git, o.current]), [[path.resolve(plain), false, true], [path.resolve(repo), true, false]]);
  core.chooseFolder(repo);
  assert.strictEqual(core.folderChosen, true);
  assert.notEqual(core.cwd, plain);
  assert.throws(() => core.send({ text: '/code-review' }), (e) => e.code !== 'PICK_FOLDER');
  core.newSession({ silent: true });
  assert.strictEqual(core.folderChosen, false);
});

test('folder picker: a git folder given at launch needs no popup; other commands never do', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pick-'));
  const core = new JarvisCore({ settings: new SettingsStore(tmp()), tempDir: tmp(), ui: () => {}, appRoot: tmp(), logDir: tmp() });
  core.warm = () => {};
  const repo = tmp();
  fs.mkdirSync(path.join(repo, '.git'));
  core.setCwd(repo, { silent: true });
  assert.strictEqual(core.folderChosen, false);
  assert.strictEqual(core.needsFolderPick('/code-review'), false);
  core.setCwd(tmp(), { silent: true });
  assert.strictEqual(core.needsFolderPick('/code-review'), true);
  assert.strictEqual(core.needsFolderPick('/compact'), false);
  assert.strictEqual(core.needsFolderPick('hello'), false);
});

test('slash command cache is kept per project folder', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-slash-'));
  const logDir = tmp();
  const make = () => {
    const c = new JarvisCore({ settings: new SettingsStore(tmp()), tempDir: tmp(), ui: () => {}, appRoot: tmp(), logDir });
    c.warm = () => {};
    return c;
  };
  const a = tmp();
  const b = tmp();
  const core = make();
  core.setCwd(a, { silent: true });
  core._writeSlashCache(['only-in-a']);
  core.setCwd(b, { silent: true });
  assert.strictEqual(core.slashCache, null);
  core._writeSlashCache(['only-in-b']);
  const again = make();
  again.setCwd(a, { silent: true });
  assert.deepStrictEqual(again.slashCache, ['only-in-a']);
});

test('a never-run folder lists the commands every known folder shares', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-slash-'));
  const logDir = tmp();
  const core = new JarvisCore({ settings: new SettingsStore(tmp()), tempDir: tmp(), ui: () => {}, appRoot: tmp(), logDir });
  core.warm = () => {};
  core.setCwd(tmp(), { silent: true });
  core._writeSlashCache(['code-review', 'simplify', 'only-in-a']);
  core.setCwd(tmp(), { silent: true });
  core._writeSlashCache(['code-review', 'simplify', 'only-in-b']);
  core.setCwd(tmp(), { silent: true }); // freshly added folder, no init event yet
  const names = core.listCommands({ home: tmp() }).map((c) => c.name);
  assert.ok(names.includes('code-review') && names.includes('simplify'));
  assert.ok(!names.includes('only-in-a') && !names.includes('only-in-b'));
});
