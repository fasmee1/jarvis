'use strict';
// STT provider switcher (main process). 'webspeech' runs in the renderer, so
// main only reports it; whisper, azure and typhoon transcribe PCM sent over IPC.

const fs = require('fs');
const path = require('path');
const { WhisperProvider } = require('./whisper');
const { AzureProvider } = require('./azure');
const { TyphoonProvider } = require('./typhoon');
const { rms } = require('./wav');
const { buildWhisperPrompt, parseCorrections, applyCorrections } = require('./vocab');

const MIN_RMS = 0.004; // below this the clip is effectively silence
const KEY_ENV = { azure: 'AZURE_SPEECH_KEY', typhoon: 'TYPHOON_API_KEY' };

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
    this.whisper = new WhisperProvider({ dataDir, tempDir });
    this.azure = new AzureProvider({ getKey: () => this.getKey('azure'), region: '' });
    this.typhoon = new TyphoonProvider({ getKey: () => this.getKey('typhoon') });
    this.provider = 'whisper';
    this.installing = null;
    this.vocab = [];
    this.project = '';
    this.corrections = [];
  }

  /** Project folder name: added to the whisper prompt since it is often spoken. */
  setProject(name) {
    this.project = String(name || '');
    this.whisper.prompt = buildWhisperPrompt(this.vocab, this.project);
  }

  configure(s) {
    this.provider = s.sttProvider;
    this.whisper.model = s.whisperModel;
    this.azure.region = s.azureRegion;
    this.vocab = s.sttVocabulary || [];
    this.corrections = parseCorrections(s.sttCorrections || []);
    this.whisper.prompt = buildWhisperPrompt(this.vocab, this.project);
  }

  keyFile(name) {
    return path.join(this.dataDir, `${name}.key`);
  }

  /** API key for a cloud provider: env var first, else the safeStorage-encrypted file. */
  getKey(name) {
    const env = KEY_ENV[name];
    if (env && process.env[env]) return process.env[env];
    try {
      const ss = safeStorage();
      const buf = fs.readFileSync(this.keyFile(name));
      return ss && ss.isEncryptionAvailable() ? ss.decryptString(buf) : '';
    } catch {
      return '';
    }
  }

  setKey(name, key) {
    if (!KEY_ENV[name]) throw new Error('unknown provider');
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!key) {
      fs.rmSync(this.keyFile(name), { force: true });
      return;
    }
    const ss = safeStorage();
    if (!ss || !ss.isEncryptionAvailable()) throw new Error(`เครื่องนี้เข้ารหัส key ด้วย safeStorage ไม่ได้ — ใช้ตัวแปรแวดล้อม ${KEY_ENV[name]} แทน`);
    fs.writeFileSync(this.keyFile(name), ss.encryptString(key));
  }

  status() {
    return {
      provider: this.provider,
      whisper: this.whisper.status(),
      azure: this.azure.status(),
      typhoon: this.typhoon.status(),
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

  /**
   * partial: a live preview while the user is still speaking (hands-free). Only
   * for local whisper; skipped (null) while anything else is transcribing, and
   * killed as soon as a final transcription starts, so it never delays one.
   */
  async transcribe(pcm, { partial = false, fast = false } = {}) {
    // side jobs (live previews, the wake-word check) use a fast model: with a slow
    // one (Thonburian medium ≈ 2.5× small) they held hands-free up for ~30 s
    if (partial) {
      if (this.provider !== 'whisper' || this.finals > 0 || this.partial) return null;
      if (rms(pcm) < MIN_RMS) return '';
      const ac = new AbortController();
      this.partial = ac;
      try {
        const text = await this.whisper.transcribe(pcm, { signal: ac.signal, threads: 4, model: this.whisper.fastModel() });
        return applyCorrections(text, this.corrections);
      } catch (err) {
        if (err.code === 'ABORTED') return null;
        throw err;
      } finally {
        if (this.partial === ac) this.partial = null;
      }
    }
    if (this.partial) this.partial.abort();
    this.finals = (this.finals || 0) + 1;
    try {
      if (rms(pcm) < MIN_RMS) return '';
      // the wake check (fast) gets the raw text: it only looks for the wake word
      if (fast && this.provider === 'whisper') return await this.whisper.transcribe(pcm, { model: this.whisper.fastModel() });
      let text;
      if (this.provider === 'azure') text = await this.azure.transcribe(pcm);
      else if (this.provider === 'typhoon') text = await this.typhoon.transcribe(pcm);
      else if (this.provider === 'whisper') text = await this.whisper.transcribe(pcm);
      else throw Object.assign(new Error('provider นี้ทำงานในหน้าจอ ไม่ใช่ใน main'), { code: 'RENDERER_PROVIDER' });
      return applyCorrections(text, this.corrections);
    } finally {
      this.finals--;
    }
  }

  dispose() {}
}

module.exports = { SttService, MIN_RMS };
