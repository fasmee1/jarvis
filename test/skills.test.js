'use strict';
// "/" menu: finding Claude Code skills/commands on disk, and filtering them as you type.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listSkills, parseFrontMatter } = require('../lib/skills');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skills-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-proj-'));
  const c = path.join(home, '.claude');
  write(path.join(c, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: >\n  Ship the app\n  to prod\n---\n# Deploy\n');
  write(path.join(c, 'skills', 'hidden', 'SKILL.md'), '---\nname: hidden\nuser-invocable: false\ndescription: x\n---\n');
  write(path.join(c, 'skills', 'nofm', 'SKILL.md'), '# Title\n\nFirst real line.\n');
  write(path.join(c, 'commands', 'review.md'), '---\ndescription: "Review the diff"\n---\nbody');
  write(path.join(c, 'commands', 'git', 'pr.md'), 'Open a PR');
  const plug = path.join(home, 'plug');
  write(path.join(plug, 'skills', 'make', 'SKILL.md'), '---\nname: make\ndescription: Make a video\n---\n');
  const off = path.join(home, 'off');
  write(path.join(off, 'skills', 'nope', 'SKILL.md'), '---\nname: nope\n---\n');
  write(path.join(c, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'vid@market': [{ installPath: plug }], 'off@market': [{ installPath: off }] },
  }));
  write(path.join(c, 'settings.json'), JSON.stringify({ enabledPlugins: { 'vid@market': true, 'off@market': false } }));
  write(path.join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Project deploy\n---\n');
  return { home, cwd };
}

test('front matter: plain, quoted and folded values', () => {
  const fm = parseFrontMatter('---\nname: a\ndescription: >\n  one\n  two\nother: "q"\n---\nx');
  assert.deepStrictEqual(fm, { name: 'a', description: 'one two', other: 'q' });
  assert.deepStrictEqual(parseFrontMatter('no front matter'), {});
});

test('lists personal, project and enabled plugin skills', () => {
  const { home, cwd } = fixture();
  const items = listSkills({ home, cwd });
  const by = Object.fromEntries(items.map((x) => [x.name, x]));
  assert.deepStrictEqual(Object.keys(by), ['deploy', 'git:pr', 'nofm', 'review', 'vid:make']);
  assert.strictEqual(by.deploy.source, 'project'); // project wins over the personal one
  assert.strictEqual(by.deploy.description, 'Project deploy');
  assert.strictEqual(by.nofm.description, 'First real line.');
  assert.strictEqual(by.review.description, 'Review the diff');
  assert.strictEqual(by['vid:make'].source, 'plugin');
});

test('missing ~/.claude gives an empty list', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-empty-'));
  assert.deepStrictEqual(listSkills({ home }), []);
});

test('filter and query for the menu', async () => {
  const { filterCommands, slashQuery } = await import('../renderer/ui/slash-menu.js');
  const items = [
    { name: 'hyperframes:make', description: '' },
    { name: 'make-video', description: '' },
    { name: 'review', description: 'make it better' },
    { name: 'xmake', description: '' },
  ];
  assert.deepStrictEqual(filterCommands(items, 'make').map((x) => x.name), ['make-video', 'hyperframes:make', 'xmake', 'review']);
  assert.strictEqual(filterCommands(items, '').length, 4);
  assert.strictEqual(slashQuery('/rev', 4), 'rev');
  assert.strictEqual(slashQuery('/review now', 11), null);
  assert.strictEqual(slashQuery('hello', 5), null);
  assert.strictEqual(slashQuery('/', 1), '');
});
