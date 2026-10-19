'use strict';
// Voice coding helpers: whisper vocabulary prompt, the "heard=meant" correction
// dictionary, and coding mode (auto-on in code projects, voice toggle, prompt prefix).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildWhisperPrompt, parseCorrections, applyCorrections, DEFAULT_CORRECTIONS } = require('../lib/stt/vocab');
const { SttService } = require('../lib/stt');
const { SettingsStore } = require('../lib/settings');
const { JarvisCore, parseCodingModeCommand, isCodeProject } = require('../lib/jarvis-core');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-coding-'));

test('whisper prompt: project first, ASCII only, no duplicates, length-capped', () => {
  assert.strictEqual(buildWhisperPrompt(['Claude Code', 'จาร์วิส', 'claude code', 'npm test'], 'mee-jarvis'), 'mee-jarvis, Claude Code, npm test');
  assert.strictEqual(buildWhisperPrompt([], ''), '');
  const long = buildWhisperPrompt(Array.from({ length: 100 }, (_, i) => `word${i}xxxxxxxx`));
  assert.ok(long.length <= 400 && long.length > 300);
});

test('corrections: longest match wins, case-insensitive, no re-matching', () => {
  const rules = parseCorrections(['ดาวิส=จาร์วิส', 'ดาวิสต์=จาร์วิส', 'bad line', '=x', 'foo=FOO', 'a=a']);
  assert.deepStrictEqual(rules.map((r) => r[0]), ['ดาวิสต์', 'ดาวิส', 'foo']);
  assert.strictEqual(applyCorrections('ดาวิสต์ เปิด Foo', rules), 'จาร์วิส เปิด FOO');
  assert.strictEqual(applyCorrections('ใช้ควักโค้ดแก้ไฟล์', parseCorrections(DEFAULT_CORRECTIONS)), 'ใช้Claude Codeแก้ไฟล์');
  assert.strictEqual(applyCorrections('', rules), '');
});

test('STT service: corrections on finals and previews, not the wake check; prompt reaches whisper', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'models'));
  fs.writeFileSync(path.join(dir, 'models', 'ggml-small.bin'), 'x');
  const s = new SttService({ dataDir: dir, tempDir: dir });
  s.configure({ sttProvider: 'whisper', whisperModel: 'small', azureRegion: '', sttVocabulary: ['Claude Code'], sttCorrections: ['ควักโค้ด=Claude Code'] });
  s.setProject('mee-jarvis');
  const prompts = [];
  s.whisper.transcribe = async (_pcm, o = {}) => { prompts.push(o.prompt ?? s.whisper.prompt); return 'เปิดควักโค้ด'; };
  const pcm = Buffer.alloc(16000 * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 8000 : -8000, i);
  assert.strictEqual(await s.transcribe(pcm), 'เปิดClaude Code');
  assert.strictEqual(await s.transcribe(pcm, { partial: true }), 'เปิดClaude Code');
  assert.strictEqual(await s.transcribe(pcm, { fast: true }), 'เปิดควักโค้ด');
  assert.strictEqual(prompts[0], 'mee-jarvis, Claude Code');
});

test('settings: vocabulary and corrections have defaults and are validated', () => {
  const st = new SettingsStore(tmp());
  assert.ok(st.get().sttVocabulary.includes('Claude Code'));
  assert.ok(st.get().sttCorrections.some((l) => l.startsWith('ควักโค้ด=')));
  assert.strictEqual(st.update({ sttCorrections: ['x'.repeat(200)] }).ok, false);
  assert.strictEqual(st.update({ sttVocabulary: ['React'] }).ok, true);
});

test('coding mode voice command', () => {
  assert.strictEqual(parseCodingModeCommand('เปิดโหมดโค้ด'), true);
  assert.strictEqual(parseCodingModeCommand('เปิด โหมดเขียนโค้ด ครับ'), true);
  assert.strictEqual(parseCodingModeCommand('ปิดโหมดโค้ดหน่อย'), false);
  assert.strictEqual(parseCodingModeCommand('เปิดโหมดโค้ดแล้วแก้ไฟล์ main.js'), null);
  assert.strictEqual(parseCodingModeCommand('สวัสดี'), null);
});

test('coding mode: auto-on in a code project, prompt sent once with the next message', () => {
  const proj = tmp();
  const plain = tmp();
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  assert.strictEqual(isCodeProject(proj), true);
  assert.strictEqual(isCodeProject(plain), false);

  const settings = new SettingsStore(tmp());
  const events = [];
  const cwds = [];
  const core = new JarvisCore({ settings, tempDir: tmp(), ui: (k, d) => events.push([k, d]), appRoot: tmp(), logDir: tmp(), onCwd: (d) => cwds.push(d) });
  core.warm = () => {};
  core.setCwd(proj);
  assert.strictEqual(core.codingMode, true);
  assert.deepStrictEqual(cwds, [path.resolve(proj)]);

  const sent = [];
  core.ensureSession = () => ({ busy: false });
  core._startTurn = (content) => { sent.push(content.at(-1).text); return 't'; };
  core.send({ text: 'แก้บั๊กหน่อย' });
  core.send({ text: 'อีกเรื่อง' });
  assert.match(sent[0], /^\[JARVIS: เปิดโหมดโค้ด/);
  assert.strictEqual(sent[1], 'อีกเรื่อง');

  // voice toggle: handled locally, nothing sent to Claude
  assert.strictEqual(core.send({ text: 'ปิดโหมดโค้ด' }), null);
  assert.strictEqual(core.codingMode, false);
  core.send({ text: 'ต่อ' });
  assert.match(sent[2], /^\[JARVIS: ปิดโหมดโค้ดแล้ว/);

  core.setCwd(plain);
  assert.strictEqual(core.codingMode, false);
});
