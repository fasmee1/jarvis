'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TtsUsage } = require('../lib/tts/usage');
const { GeminiTts, pcmToWav } = require('../lib/tts/gemini');
const { HybridTts } = require('../lib/tts/hybrid');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tts-usage-')), 'u.json');
const CONFIG = { ttsGemini: true, geminiModel: '', geminiVoice: '', geminiStyle: '', geminiDailyCap: 3 };

function audioResponse(bytes = 4, mime = 'audio/L16;codec=pcm;rate=24000') {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: mime, data: Buffer.alloc(bytes, 1).toString('base64') } }] } }] }) };
}

test('usage counts per day and month, and resets on a new day / month', () => {
  const file = tmpFile();
  let now = new Date(2026, 9, 30, 10);
  const u = new TtsUsage({ file, now: () => now });
  u.record('gemini', 100);
  u.record('gemini', 50);
  assert.deepStrictEqual(u.snapshot('gemini'), { day: { requests: 2, chars: 150 }, month: { requests: 2, chars: 150 } });
  now = new Date(2026, 9, 31, 9); // next day, same month
  assert.deepStrictEqual(u.snapshot('gemini'), { day: { requests: 0, chars: 0 }, month: { requests: 2, chars: 150 } });
  u.record('gemini', 10);
  now = new Date(2026, 10, 1, 9); // next month
  assert.deepStrictEqual(u.snapshot('gemini'), { day: { requests: 0, chars: 0 }, month: { requests: 0, chars: 0 } });
});

test('usage survives a restart and ignores a corrupt file', () => {
  const file = tmpFile();
  const now = () => new Date(2026, 9, 30, 10);
  new TtsUsage({ file, now }).record('gemini', 7);
  assert.strictEqual(new TtsUsage({ file, now }).snapshot('gemini').month.chars, 7);
  fs.writeFileSync(file, '{not json');
  assert.strictEqual(new TtsUsage({ file, now }).snapshot('gemini').month.chars, 0);
});

test('pcmToWav writes a valid 24 kHz mono 16-bit header', () => {
  const wav = pcmToWav(Buffer.alloc(100), 24000);
  assert.strictEqual(wav.length, 144);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(4), 136);
  assert.strictEqual(wav.readUInt32LE(24), 24000);
  assert.strictEqual(wav.readUInt16LE(34), 16);
  assert.strictEqual(wav.readUInt32LE(40), 100);
});

test('synthesize returns WAV, sends the key in a header and counts the text length', async () => {
  const usage = new TtsUsage({ file: tmpFile() });
  let seen;
  const g = new GeminiTts({
    getKey: () => 'KEY', getConfig: () => CONFIG, usage,
    fetchImpl: async (url, init) => { seen = { url, init }; return audioResponse(); },
  });
  const wav = await g.synthesize('สวัสดีครับ');
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(seen.init.headers['x-goog-api-key'], 'KEY');
  assert.ok(!seen.url.includes('KEY'), 'key must not be in the URL');
  assert.ok(JSON.parse(seen.init.body).contents[0].parts[0].text.endsWith('สวัสดีครับ'));
  assert.strictEqual(usage.snapshot('gemini').day.chars, 'สวัสดีครับ'.length);
});

test('available() is false without a key, when disabled, or over the daily cap', async () => {
  const usage = new TtsUsage({ file: tmpFile() });
  let key = '';
  let cfg = CONFIG;
  const g = new GeminiTts({ getKey: () => key, getConfig: () => cfg, usage, fetchImpl: async () => audioResponse() });
  assert.strictEqual(g.available(), false); // no key
  key = 'K';
  assert.strictEqual(g.available(), true);
  cfg = { ...CONFIG, ttsGemini: false };
  assert.strictEqual(g.available(), false); // disabled
  cfg = CONFIG;
  for (let i = 0; i < 3; i++) await g.synthesize('x');
  assert.strictEqual(g.available(), false); // 3 of 3 used today
  cfg = { ...CONFIG, geminiDailyCap: 0 };
  assert.strictEqual(g.available(), true); // 0 = no cap
});

test('429 starts a growing cooldown and the failed request is not counted', async () => {
  let t = 1_000_000;
  const usage = new TtsUsage({ file: tmpFile() });
  const g = new GeminiTts({ getKey: () => 'K', getConfig: () => CONFIG, usage, now: () => t, fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(g.synthesize('x'), { code: 'GEMINI_RATE_LIMIT' });
  assert.strictEqual(g.available(), false);
  t += 60_001;
  assert.strictEqual(g.available(), true); // first cooldown: 1 minute
  await assert.rejects(g.synthesize('x'), { code: 'GEMINI_RATE_LIMIT' });
  t += 60_001;
  assert.strictEqual(g.available(), false); // second one is 2 minutes
  assert.strictEqual(usage.snapshot('gemini').day.requests, 0);
});

test('hybrid uses Gemini first, then falls back to Edge when Gemini fails or is unavailable', async () => {
  const calls = [];
  const edge = { voices: async () => [], synthesize: async () => { calls.push('edge'); return Buffer.from('mp3'); }, dispose() {} };
  const fallback = { voices: async () => [], synthesize: async () => { calls.push('winrt'); return Buffer.from('wav'); }, dispose() {} };
  let ok = true;
  const gemini = {
    available: () => true,
    synthesize: async () => { if (!ok) throw new Error('boom'); calls.push('gemini'); return Buffer.from('g'); },
  };
  const h = new HybridTts({ edge, fallback, gemini });
  await h.synthesize('a', { voice: 'th-TH-NiwatNeural' });
  ok = false;
  await h.synthesize('b', { voice: 'th-TH-NiwatNeural' });
  assert.deepStrictEqual(calls, ['gemini', 'edge']);
  // an explicitly chosen Windows voice skips Gemini
  await h.synthesize('c', { voice: 'Microsoft Pattara' });
  assert.deepStrictEqual(calls, ['gemini', 'edge', 'winrt']);
});
