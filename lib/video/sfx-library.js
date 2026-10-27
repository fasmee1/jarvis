'use strict';
// Sound effects the user (or JARVIS) fetched from the web, kept on disk for the video editor.
//
// Only a link that Claude suggested comes in, and nothing about it is trusted:
//   - the link must be https on a site whose licence the app knows (ALLOWED_HOSTS: free for
//     commercial use without credit); redirects may only stay on such sites
//   - the answer must be audio, small, and short (checked by ffprobe, not by the file name)
//   - the file is re-encoded to a plain WAV by ffmpeg; the downloaded bytes are never played,
//     opened or run by anything else, and are deleted
// Each sound keeps where it came from and what the licence said, so it can be shown to the user.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// host → the licence that site publishes for everything on it (checked by hand, 2026-10)
const ALLOWED_HOSTS = Object.freeze({
  'assets.mixkit.co': 'Mixkit Sound Effects Free License — ใช้ในงานเชิงพาณิชย์ได้ ไม่ต้องให้เครดิต',
  'cdn.pixabay.com': 'Pixabay Content License — ใช้ในงานเชิงพาณิชย์ได้ ไม่ต้องให้เครดิต',
});
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a)$/i;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_SECONDS = 10;
const MIN_SECONDS = 0.05;
const MAX_ENTRIES = 80;
const TIMEOUT_MS = 20000;

class SfxError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The url if it is one the app accepts for a download, else throws SfxError. */
function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new SfxError('ลิงก์เสียงไม่ถูกต้อง', 'URL');
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new SfxError('รับเฉพาะลิงก์ https ปกติ', 'URL');
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_HOSTS, u.hostname)) throw new SfxError(`เว็บ ${u.hostname} ไม่อยู่ในรายการที่ใบอนุญาตชัดเจน จึงไม่โหลด`, 'HOST');
  if (!AUDIO_EXT.test(u.pathname)) throw new SfxError('ลิงก์นี้ไม่ใช่ไฟล์เสียง', 'EXT');
  return u;
}

/** Downloads to `dest` (a temp file), refusing other hosts, big files and slow servers. */
function fetchAudio(url, dest, { signal, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let req = null;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) {
        try { if (req) req.destroy(); } catch { /* gone */ }
        try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
        reject(err);
      } else resolve(dest);
    };
    const onAbort = () => finish(new SfxError('ยกเลิกแล้ว', 'ABORTED'));
    const timer = setTimeout(() => finish(new SfxError('เซิร์ฟเวอร์ตอบช้าเกินไป', 'TIMEOUT')), TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const go = (u, left) => {
      let parsed;
      try {
        parsed = checkUrl(u);
      } catch (e) {
        return finish(e);
      }
      req = https.get(parsed, { headers: { 'User-Agent': 'mee-jarvis', Accept: 'audio/*' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return finish(new SfxError('ลิงก์เด้งต่อมากเกินไป', 'REDIRECT'));
          return go(new URL(res.headers.location, parsed).toString(), left - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return finish(new SfxError(`โหลดไม่สำเร็จ (HTTP ${res.statusCode})`, 'HTTP'));
        }
        if (!/^audio\//i.test(String(res.headers['content-type'] || ''))) {
          res.resume();
          return finish(new SfxError('เว็บไม่ได้ส่งไฟล์เสียงกลับมา', 'TYPE'));
        }
        if (Number(res.headers['content-length']) > maxBytes) {
          res.resume();
          return finish(new SfxError('ไฟล์ใหญ่เกินไป', 'SIZE'));
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const out = fs.createWriteStream(dest);
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (got > maxBytes) {
            out.destroy();
            finish(new SfxError('ไฟล์ใหญ่เกินไป', 'SIZE'));
          }
        });
        res.on('error', finish);
        out.on('error', finish);
        out.on('close', () => { if (!settled && got <= maxBytes) finish(null); });
        res.pipe(out);
      });
      req.on('error', (e) => finish(new SfxError(`โหลดไม่สำเร็จ: ${e.message}`, 'NET')));
    };
    go(url, 3);
  });
}

class SfxLibrary {
  /**
   * dir: where sounds and index.json live · ffmpeg: Ffmpeg (probe / require / run)
   * fetchFn(url, dest, { signal }) for tests · now() for tests
   */
  constructor({ dir, ffmpeg, fetchFn = fetchAudio, now = () => Date.now() }) {
    this.dir = dir;
    this.ffmpeg = ffmpeg;
    this.fetchFn = fetchFn;
    this.now = now;
    this.items = null;
  }

  _load() {
    if (this.items) return this.items;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8'));
      this.items = Array.isArray(j.items) ? j.items.filter((x) => x && /^dl-[0-9a-f]{8}$/.test(x.id) && fs.existsSync(path.join(this.dir, `${x.id}.wav`))) : [];
    } catch {
      this.items = [];
    }
    return this.items;
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, 'index.json');
    fs.writeFileSync(`${file}.part`, JSON.stringify({ version: 1, items: this.items }, null, 2));
    fs.renameSync(`${file}.part`, file);
  }

  list() {
    return this._load().map((x) => ({ ...x }));
  }

  get(id) {
    return this._load().find((x) => x.id === id) || null;
  }

  filePath(id) {
    return this.get(id) ? path.join(this.dir, `${id}.wav`) : null;
  }

  remove(id) {
    const items = this._load();
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) throw new SfxError('ไม่พบเสียงนี้ในคลัง', 'NONE');
    items.splice(i, 1);
    try { fs.rmSync(path.join(this.dir, `${id}.wav`), { force: true }); } catch { /* best effort */ }
    this._save();
    return { ok: true };
  }

  /**
   * Fetches one suggested sound. found: { audioUrl, pageUrl, title, license, role }.
   * Resolves the library entry (the same one when the link is already in the library).
   */
  async add(found, { signal } = {}) {
    const url = checkUrl(found.audioUrl);
    const id = `dl-${crypto.createHash('sha1').update(url.toString()).digest('hex').slice(0, 8)}`;
    const items = this._load();
    const known = items.find((x) => x.id === id);
    if (known) return { ...known };
    if (items.length >= MAX_ENTRIES) throw new SfxError('คลังเสียงเต็ม — ลบเสียงที่ไม่ใช้ก่อน', 'FULL');
    fs.mkdirSync(this.dir, { recursive: true });
    const raw = path.join(this.dir, `${id}.download`);
    const wav = path.join(this.dir, `${id}.wav`);
    try {
      await this.fetchFn(url.toString(), raw, { signal });
      const info = await this.ffmpeg.probe(raw, { signal });
      if (!info.audio) throw new SfxError('ไฟล์นี้ไม่มีเสียง', 'AUDIO');
      if (!(info.duration >= MIN_SECONDS) || info.duration > MAX_SECONDS) throw new SfxError(`เสียงนี้ยาว ${Math.round(info.duration || 0)} วินาที ไม่ใช่เสียงเอฟเฟกต์สั้น (ไม่เกิน ${MAX_SECONDS} วินาที)`, 'LENGTH');
      const { ffmpeg } = await this.ffmpeg.require();
      const tmp = `${wav}.part.wav`;
      const r = await this.ffmpeg.run(ffmpeg, ['-hide_banner', '-y', '-i', raw, '-vn', '-map', '0:a:0', '-t', String(MAX_SECONDS), '-af', 'loudnorm=I=-20:TP=-2:LRA=7', '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', tmp], { signal });
      if (r.code !== 0 || !fs.existsSync(tmp)) throw new SfxError('แปลงไฟล์เสียงไม่สำเร็จ', 'CONVERT');
      fs.renameSync(tmp, wav);
      const entry = {
        id,
        title: clean(found.title, 60) || 'เสียงเอฟเฟกต์',
        role: clean(found.role, 40),
        seconds: Math.round(Math.min(info.duration, MAX_SECONDS) * 100) / 100,
        host: url.hostname,
        sourcePage: /^https:\/\//.test(String(found.pageUrl || '')) ? clean(found.pageUrl, 300) : '',
        license: ALLOWED_HOSTS[url.hostname],
        licenseNote: clean(found.license, 300),
        addedAt: new Date(this.now()).toISOString(),
      };
      items.push(entry);
      this._save();
      return { ...entry };
    } finally {
      for (const f of [raw, `${wav}.part.wav`]) {
        try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
      }
    }
  }
}

module.exports = { SfxLibrary, SfxError, ALLOWED_HOSTS, checkUrl, fetchAudio, MAX_BYTES, MAX_SECONDS };
