'use strict';
// Per-site permission answers for the Web Viewer (userData/web-permissions.json).
// Nothing is stored until the user picks "จำไว้" (remember) on the prompt.

const fs = require('fs');
const path = require('path');

const ASKABLE = ['media:video', 'media:audio', 'geolocation', 'notifications', 'clipboard-read'];

class WebPermissions {
  constructor(dir) {
    this.file = path.join(dir, 'web-permissions.json');
    this.data = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') this.data = raw;
    } catch { /* first run */ }
  }

  /** @returns {boolean|undefined} stored answer for origin + permission key */
  get(origin, key) {
    const o = this.data[origin];
    return o && typeof o[key] === 'boolean' ? o[key] : undefined;
  }

  set(origin, key, allow) {
    if (!ASKABLE.includes(key) || !/^https?:\/\/[^/]+$/.test(origin)) return;
    (this.data[origin] ||= {})[key] = !!allow;
    this._save();
  }

  clear() {
    this.data = {};
    this._save();
  }

  _save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1)); } catch { /* best effort */ }
  }
}

/** Electron permission request → the keys we ask about (empty = deny without asking). */
function permissionKeys(permission, details = {}) {
  if (permission === 'media') {
    const types = Array.isArray(details.mediaTypes) && details.mediaTypes.length ? details.mediaTypes : ['video', 'audio'];
    return types.filter((t) => t === 'video' || t === 'audio').map((t) => `media:${t}`);
  }
  if (permission === 'geolocation' || permission === 'notifications' || permission === 'clipboard-read') return [permission];
  return [];
}

const LABELS = {
  'media:video': 'กล้อง',
  'media:audio': 'ไมโครโฟน',
  geolocation: 'ตำแหน่งที่ตั้ง',
  notifications: 'การแจ้งเตือน',
  'clipboard-read': 'อ่านคลิปบอร์ด',
};

module.exports = { WebPermissions, permissionKeys, LABELS, ASKABLE };
