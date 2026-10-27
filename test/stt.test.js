'use strict';
// STT service: a slow, accurate model (e.g. Thonburian medium) is used only for the
// final transcript; the wake-word check and live previews use the fast model, so
// hands-free doesn't stall for half a minute.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SttService } = require('../lib/stt');

function service(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-stt-'));
  fs.mkdirSync(path.join(dir, 'models'));
  for (const m of models) fs.writeFileSync(path.join(dir, 'models', `ggml-${m}.bin`), 'x');
  const s = new SttService({ dataDir: dir, tempDir: dir });
  s.configure({ sttProvider: 'whisper', whisperModel: 'thonburian-medium', azureRegion: '' });
  const used = [];
  s.whisper.transcribe = async (_pcm, o = {}) => { used.push(o.model || s.whisper.model); return 'ok'; };
  return { s, used };
}

// loud enough to pass the silence check
const pcm = Buffer.alloc(16000 * 2);
for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 8000 : -8000, i);

test('final transcript uses the chosen model; wake check and previews use the fast one', async () => {
  const { s, used } = service(['small', 'thonburian-medium']);
  await s.transcribe(pcm);
  await s.transcribe(pcm, { fast: true });
  await s.transcribe(pcm, { partial: true });
  assert.deepStrictEqual(used, ['thonburian-medium', 'small', 'small']);
});

test('no fast model downloaded: everything uses the chosen model', async () => {
  const { s, used } = service(['thonburian-medium']);
  await s.transcribe(pcm, { fast: true });
  assert.deepStrictEqual(used, ['thonburian-medium']);
});

test('typhoon: posts a WAV to the OpenAI-compatible endpoint with the key', async () => {
  const { TyphoonProvider, ENDPOINT, MODEL } = require('../lib/stt/typhoon');
  const realFetch = global.fetch;
  let call;
  global.fetch = async (url, init) => { call = { url, init }; return new Response(JSON.stringify({ text: '  เปิด   เพลง ' }), { status: 200 }); };
  try {
    const p = new TyphoonProvider({ getKey: () => 'k123' });
    assert.strictEqual(await p.transcribe(pcm), 'เปิด เพลง');
    assert.strictEqual(call.url, ENDPOINT);
    assert.strictEqual(call.init.headers.Authorization, 'Bearer k123');
    assert.strictEqual(call.init.body.get('model'), MODEL);
    const file = call.init.body.get('file');
    assert.strictEqual(file.size, 44 + pcm.length);
  } finally {
    global.fetch = realFetch;
  }
});

test('typhoon: no key, bad key and rate limit give clear errors', async () => {
  const { TyphoonProvider } = require('../lib/stt/typhoon');
  await assert.rejects(new TyphoonProvider({ getKey: () => '' }).transcribe(pcm), { code: 'NO_TYPHOON_KEY' });
  const realFetch = global.fetch;
  try {
    for (const [status, code] of [[401, 'TYPHOON_AUTH'], [429, 'TYPHOON_RATE_LIMIT']]) {
      global.fetch = async () => new Response('{}', { status });
      await assert.rejects(new TyphoonProvider({ getKey: () => 'k' }).transcribe(pcm), { code });
    }
  } finally {
    global.fetch = realFetch;
  }
});

test('service routes finals to typhoon; live previews stay local-only', async () => {
  const { s } = service(['small']);
  s.configure({ sttProvider: 'typhoon', whisperModel: 'small', azureRegion: '' });
  s.typhoon.transcribe = async () => 'จาก typhoon';
  assert.strictEqual(await s.transcribe(pcm), 'จาก typhoon');
  assert.strictEqual(await s.transcribe(pcm, { partial: true }), null);
  assert.strictEqual(s.status().typhoon.provider, 'typhoon');
});

test('whisper: clips use the Thai medium model when it is downloaded, voice commands keep the chosen one', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { WhisperProvider } = require('../lib/stt/whisper');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-wh-'));
  const w = new WhisperProvider({ dataDir: dir, tempDir: dir });
  assert.strictEqual(w.fileModel(), 'small', 'not downloaded yet');
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.writeFileSync(w.modelPath('thonburian-medium'), 'x');
  assert.strictEqual(w.fileModel(), 'thonburian-medium');
  assert.strictEqual(w.model, 'small', 'the voice-command model is unchanged');
  w.model = 'large-v3-turbo';
  assert.strictEqual(w.fileModel(), 'large-v3-turbo', 'an explicit bigger choice wins');
});
