'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSkill, readSkill, SkillError, MAX_SKILL } = require('../lib/video/skills');
const { StyleStore } = require('../lib/video/styles');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-skill-'));

const SKILL = `---
name: "รีวิวอาหารแบบมือโปร"
description: ตัดเร็ว เปิดด้วยจานเด่น
pace: fast
target: 45
---

# Food review

ตัดตรงเป็นหลัก ไม่ใส่เอฟเฟกต์ถ้าไม่มีเหตุผล
`;

test('skill: frontmatter gives name, pace and target; the body is the instructions', () => {
  const s = parseSkill(SKILL.replace(/\n/g, '\r\n'));
  assert.deepStrictEqual([s.name, s.description, s.pace, s.targetSec], ['รีวิวอาหารแบบมือโปร', 'ตัดเร็ว เปิดด้วยจานเด่น', 'fast', 45]);
  assert.match(s.prompt, /^# Food review\n\nตัดตรงเป็นหลัก/);
  const plain = parseSkill('# สอนทำกาแฟ\n\nเล่าเป็นขั้นตอน');
  assert.deepStrictEqual([plain.name, plain.pace, plain.targetSec], ['สอนทำกาแฟ', 'normal', 0]);
  assert.strictEqual(parseSkill('เนื้อหา', 'my-skill').name, 'my-skill');
  assert.strictEqual(parseSkill('---\npace: ช้า\ntarget: 9999\n---\nx', 'a').pace, 'slow');
  assert.strictEqual(parseSkill('---\ntarget: 9999\n---\nx', 'a').targetSec, 0, 'out of range target is ignored');
  assert.throws(() => parseSkill('เนื้อหา'), /ต้องมีชื่อ/);
  assert.throws(() => parseSkill('---\nname: a\n---\n   '), /ไม่มีเนื้อหา/);
  assert.throws(() => parseSkill('# a\nbin\u0000ary'), SkillError);
});

test('skill: reads SKILL.md with its text references; other files and huge ones are refused', () => {
  const dir = tmp();
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, SKILL);
  fs.mkdirSync(path.join(dir, 'references'));
  fs.writeFileSync(path.join(dir, 'references', 'b-captions.md'), 'ซับสั้น อ่านง่าย');
  fs.writeFileSync(path.join(dir, 'references', 'a-pace.txt'), 'จังหวะ');
  fs.writeFileSync(path.join(dir, 'references', 'run.js'), 'require("child_process")');
  const s = readSkill(file);
  assert.strictEqual(s.refs, 2);
  assert.ok(s.prompt.indexOf('a-pace.txt') < s.prompt.indexOf('b-captions.md'));
  assert.ok(!s.prompt.includes('child_process'), 'scripts are never read');
  assert.throws(() => readSkill('SKILL.md'), /\.md/);
  assert.throws(() => readSkill(path.join(dir, 'x.exe')), /\.md/);
  const big = path.join(tmp(), 'SKILL.md');
  fs.writeFileSync(big, `# big\n${'ก'.repeat(MAX_SKILL + 10)}`);
  assert.throws(() => readSkill(big), /ใหญ่เกินไป|ยาวเกินไป/);
});

test('skill: uploading adds it to the list; the same name again replaces it', () => {
  const store = new StyleStore({ file: path.join(tmp(), 'styles.json') });
  const a = store.importSkill(parseSkill(SKILL));
  assert.deepStrictEqual([a.skill, a.builtin, a.pace, a.targetSec], [true, false, 'fast', 45]);
  const b = store.importSkill(parseSkill(SKILL.replace('ตัดตรง', 'ตัดตรงทุกครั้ง')));
  assert.strictEqual(b.id, a.id);
  assert.match(store.get(a.id).prompt, /ตัดตรงทุกครั้ง/);
  assert.strictEqual(store.list().filter((x) => x.skill).length, 1);
  const edited = store.save({ id: a.id, name: a.name, prompt: 'ใหม่', pace: 'slow', targetSec: 0 });
  assert.strictEqual(edited.skill, true, 'editing keeps it an uploaded skill');
  assert.strictEqual(new StyleStore({ file: store.file }).get(a.id).description, 'ตัดเร็ว เปิดด้วยจานเด่น');
});
