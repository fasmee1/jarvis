'use strict';
// MediaPipe model files, downloaded once into userData/vision and handed to
// the renderer as ArrayBuffers (modelAssetBuffer), so no network at runtime.

const fs = require('fs');
const path = require('path');
const { download } = require('./download');

const MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  gesture: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
};

class VisionAssets {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.installing = null;
  }

  file(name) {
    return path.join(this.dataDir, path.basename(new URL(MODELS[name]).pathname));
  }

  status() {
    const s = {};
    for (const n of Object.keys(MODELS)) s[n] = fs.existsSync(this.file(n));
    return { models: s, ready: s.face && s.hand, installing: !!this.installing };
  }

  install(onProgress = () => {}) {
    if (!this.installing) {
      this.installing = (async () => {
        for (const n of Object.keys(MODELS)) {
          if (fs.existsSync(this.file(n))) continue;
          onProgress({ step: n });
          await download(MODELS[n], this.file(n), { onProgress: (p) => onProgress({ step: n, ...p }) });
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
    const f = this.file(name);
    if (!fs.existsSync(f)) throw Object.assign(new Error('ยังไม่ได้ดาวน์โหลดโมเดล ' + name), { code: 'NO_MODEL' });
    return fs.readFileSync(f);
  }
}

VisionAssets.MODEL_NAMES = Object.keys(MODELS);

module.exports = { VisionAssets, MODELS };
