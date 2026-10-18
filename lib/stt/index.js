'use strict';
// STT provider switcher (main process). 'webspeech' runs in the renderer, so
// main only reports it; whisper and azure transcribe PCM sent over IPC.

const fs = require('fs');
const path = require('path');
const { WhisperProvider } = require('./whisper');
const { AzureProvider } = require('./azure');
const { rms } = require('./wav');

const MIN_RMS = 0.004; // below this the clip is effectively silence

function safeStorage() {
  try {
    return require('electron').safeStorage;
  } catch {
    return null;
  }
}

class SttService {
  constructor({ dataDir, tempDir }) {
    this.dataDir = dataDir;
    this.keyFile = path.join(dataDir, 'azure.key');
    this.whisper = new WhisperProvider({ dataDir, tempDir });
    this.azure = new AzureProvider({ getKey: () => this.getAzureKey(), region: '' });
    this.provider = 'whisper';
    this.installing = null;
  }

  configure(s) {
    this.provider = s.sttProvider;
    this.whisper.model = s.whisperModel;
    this.azure.region = s.azureRegion;
  }

  getAzureKey() {
    if (process.env.AZURE_SPEECH_KEY) return process.env.AZURE_SPEECH_KEY;
    try {
      const ss = safeStorage();
      const buf = fs.readFileSync(this.keyFile);
      return ss && ss.isEncryptionAvailable() ? ss.decryptString(buf) : '';
    } catch {
      return '';
    }
  }

  setAzureKey(key) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!key) {
      fs.rmSync(this.keyFile, { force: true });
      return;
    }
    const ss = safeStorage();
    if (!ss || !ss.isEncryptionAvailable()) throw new Error('เครื่องนี้เข้ารหัส key ด้วย safeStorage ไม่ได้ — ใช้ตัวแปรแวดล้อม AZURE_SPEECH_KEY แทน');
    fs.writeFileSync(this.keyFile, ss.encryptString(key));
  }

  status() {
    return {
      provider: this.provider,
      whisper: this.whisper.status(),
      azure: this.azure.status(),
      installing: !!this.installing,
    };
  }

  install(onProgress) {
    if (!this.installing) {
      this.installing = this.whisper
        .install(onProgress)
        .then((s) => ({ ok: true, status: s }), (err) => ({ ok: false, error: err.message }))
        .finally(() => { this.installing = null; });
    }
    return this.installing;
  }

  async transcribe(pcm) {
    if (rms(pcm) < MIN_RMS) return '';
    if (this.provider === 'azure') return this.azure.transcribe(pcm);
    if (this.provider === 'whisper') return this.whisper.transcribe(pcm);
    throw Object.assign(new Error('provider นี้ทำงานในหน้าจอ ไม่ใช่ใน main'), { code: 'RENDERER_PROVIDER' });
  }

  dispose() {}
}

module.exports = { SttService, MIN_RMS };
