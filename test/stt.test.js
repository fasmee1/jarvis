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
