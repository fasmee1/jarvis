'use strict';
// Credentials for the optional "Google Earth" 3D map mode (Google Photorealistic
// 3D Tiles): a Google Maps Platform key, or a Cesium ion token (ion serves the
// same tiles on a free plan). Env var first, else a safeStorage-encrypted file.
// Both are browser credentials: they are handed to the renderer, which sends them
// only to tile.googleapis.com / api.cesium.com.

const fs = require('fs');
const path = require('path');

const KINDS = {
  google: { env: 'GOOGLE_MAPS_API_KEY', file: 'google-maps.key' },
  ion: { env: 'CESIUM_ION_TOKEN', file: 'cesium-ion.key' },
};

function safeStorage() {
  try {
    return require('electron').safeStorage;
  } catch {
    return null;
  }
}

class MapsKey {
  /** kind: 'google' (default) | 'ion' */
  constructor({ dataDir, kind = 'google' }) {
    if (!KINDS[kind]) throw new Error('unknown key kind');
    this.env = KINDS[kind].env;
    this.file = path.join(dataDir, KINDS[kind].file);
  }

  get() {
    if (process.env[this.env]) return process.env[this.env];
    try {
      const ss = safeStorage();
      const buf = fs.readFileSync(this.file);
      return ss && ss.isEncryptionAvailable() ? ss.decryptString(buf) : '';
    } catch {
      return '';
    }
  }

  set(key) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!key) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    const ss = safeStorage();
    if (!ss || !ss.isEncryptionAvailable()) throw new Error(`เครื่องนี้เข้ารหัส key ด้วย safeStorage ไม่ได้ — ใช้ตัวแปรแวดล้อม ${this.env} แทน`);
    fs.writeFileSync(this.file, ss.encryptString(key));
  }
}

module.exports = { MapsKey };
