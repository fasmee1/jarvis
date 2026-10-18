'use strict';
// openWakeWord ONNX models for hands-free mode, downloaded once into
// userData/handsfree and handed to the renderer as ArrayBuffers. Wake word
// detection then runs fully on-device; no audio leaves the machine for it.
// Models: openWakeWord v0.5.1 (code Apache-2.0; pre-trained models CC BY-NC-SA 4.0).

const fs = require('fs');
const path = require('path');
const { download } = require('./download');

const BASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/';
const MODELS = {
  mel: { file: 'melspectrogram.onnx', size: 1087958 },
  emb: { file: 'embedding_model.onnx', size: 1326578 },
  wake: { file: 'hey_jarvis_v0.1.onnx', size: 1271370 },
  vad: { file: 'silero_vad.onnx', size: 1807522 },
};

class WakeAssets {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.installing = null;
  }

  file(name) {
    return path.join(this.dataDir, MODELS[name].file);
  }

  has(name) {
    try {
      return fs.statSync(this.file(name)).size === MODELS[name].size;
    } catch {
      return false;
    }
  }

  status() {
    const models = {};
    for (const n of Object.keys(MODELS)) models[n] = this.has(n);
    return { models, ready: models.mel && models.emb && models.wake, installing: !!this.installing };
  }

  install(onProgress = () => {}) {
    if (!this.installing) {
      this.installing = (async () => {
        for (const n of Object.keys(MODELS)) {
          if (this.has(n)) continue;
          onProgress({ step: MODELS[n].file });
          await download(BASE + MODELS[n].file, this.file(n), { onProgress: (p) => onProgress({ step: MODELS[n].file, ...p }) });
          if (!this.has(n)) {
            fs.rmSync(this.file(n), { force: true });
            throw new Error(`ไฟล์ ${MODELS[n].file} ไม่ถูกต้อง (ขนาดไม่ตรง)`);
          }
        }
        return { ok: true, status: this.status() };
      })()
        .catch((err) => ({ ok: false, error: err.message }))
        .finally(() => { this.installing = null; });
    }
    return this.installing;
  }

  read(name) {
    if (!MODELS[name]) throw new Error('unknown model');
    if (!this.has(name)) throw Object.assign(new Error('ยังไม่ได้ดาวน์โหลดโมเดล ' + MODELS[name].file), { code: 'NO_MODEL' });
    return fs.readFileSync(this.file(name));
  }
}

WakeAssets.MODEL_NAMES = Object.keys(MODELS);

module.exports = { WakeAssets, MODELS };
