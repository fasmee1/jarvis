'use strict';
// Sounds, music and pictures the user (or JARVIS) fetched from the web, kept on disk for the
// video editor. Three kinds, each with its own list of sites, size limit and conversion:
//   sfx    short sound effects (Mixkit, Pixabay) → WAV
//   music  background music (Mixkit, Pixabay)    → M4A
//   image  emoji stickers (Google Noto Emoji)    → PNG with transparency
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

// kind → what may be fetched. Every site here publishes a licence that lets anyone use its files
// in commercial work without credit (checked by hand, 2026-10); a path rule narrows a site to the
// part that licence covers. Anything not listed here is never downloaded.
const MIXKIT = 'Mixkit Free License — ใช้ในงานเชิงพาณิชย์ได้ ไม่ต้องให้เครดิต';
const PIXABAY = 'Pixabay Content License — ใช้ในงานเชิงพาณิชย์ได้ ไม่ต้องให้เครดิต';
const SOURCES = Object.freeze({
  sfx: {
    hosts: { 'assets.mixkit.co': { license: MIXKIT }, 'cdn.pixabay.com': { license: PIXABAY } },
    ext: /\.(mp3|wav|ogg|m4a)$/i, mime: /^audio\//i, maxBytes: 3 * 1024 * 1024, maxSeconds: 10, minSeconds: 0.05, out: 'wav',
  },
  music: {
    hosts: { 'assets.mixkit.co': { license: MIXKIT }, 'cdn.pixabay.com': { license: PIXABAY } },
    ext: /\.(mp3|wav|ogg|m4a)$/i, mime: /^audio\//i, maxBytes: 12 * 1024 * 1024, maxSeconds: 300, minSeconds: 15, out: 'm4a',
  },
  image: {
    hosts: { 'fonts.gstatic.com': { license: 'Google Noto Emoji — Apache License 2.0 (ใช้ในงานเชิงพาณิชย์ได้ ไม่ต้องให้เครดิต)', path: /^\/s\/e\/notoemoji\/latest\/[0-9a-f]{3,6}(?:_[0-9a-f]{3,6}){0,6}\/512\.png$/ } },
    ext: /\.png$/i, mime: /^image\/png$/i, maxBytes: 600 * 1024, out: 'png',
  },
});
// the sound sites and their licences, as before
const ALLOWED_HOSTS = Object.freeze(Object.fromEntries(Object.entries(SOURCES.sfx.hosts).map(([h, v]) => [h, v.license])));
const MAX_BYTES = SOURCES.sfx.maxBytes;
const MAX_SECONDS = SOURCES.sfx.maxSeconds;
const MAX_ENTRIES = 120;
const MAX_IMAGE_SIDE = 4096;
const TIMEOUT_MS = 20000;

class SfxError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The url if it is one the app accepts for a download of this kind, else throws SfxError. */
function checkUrl(raw, kind = 'sfx') {
  const src = SOURCES[kind];
  if (!src) throw new SfxError('ชนิดไฟล์ไม่ถูกต้อง', 'KIND');
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new SfxError('ลิงก์ไม่ถูกต้อง', 'URL');
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new SfxError('รับเฉพาะลิงก์ https ปกติ', 'URL');
  if (!Object.prototype.hasOwnProperty.call(src.hosts, u.hostname)) throw new SfxError(`เว็บ ${u.hostname} ไม่อยู่ในรายการที่ใบอนุญาตชัดเจน จึงไม่โหลด`, 'HOST');
  const rule = src.hosts[u.hostname].path;
  if (rule && !rule.test(u.pathname)) throw new SfxError('ลิงก์นี้ไม่ใช่ไฟล์ที่ใบอนุญาตของเว็บครอบคลุม', 'PATH');
  if (!src.ext.test(u.pathname)) throw new SfxError('ลิงก์นี้ไม่ใช่ไฟล์ชนิดที่ต้องการ', 'EXT');
  return u;
}

/** Downloads to `dest` (a temp file), refusing other hosts, big files and slow servers. */
function fetchAudio(url, dest, { signal, kind = 'sfx', maxBytes = SOURCES[kind].maxBytes } = {}) {
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
        parsed = checkUrl(u, kind);
      } catch (e) {
        return finish(e);
      }
      req = https.get(parsed, { headers: { 'User-Agent': 'mee-jarvis', Accept: kind === 'image' ? 'image/png' : 'audio/*' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return finish(new SfxError('ลิงก์เด้งต่อมากเกินไป', 'REDIRECT'));
          return go(new URL(res.headers.location, parsed).toString(), left - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return finish(new SfxError(`โหลดไม่สำเร็จ (HTTP ${res.statusCode})`, 'HTTP'));
        }
        if (!SOURCES[kind].mime.test(String(res.headers['content-type'] || '').split(';')[0].trim())) {
          res.resume();
          return finish(new SfxError('เว็บไม่ได้ส่งไฟล์ชนิดที่ต้องการกลับมา', 'TYPE'));
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

const fileOf = (x) => x.file || `${x.id}.wav`;
const DEFAULT_TITLE = { sfx: 'เสียงเอฟเฟกต์', music: 'เพลงพื้นหลัง', image: 'สติกเกอร์' };

class SfxLibrary {
  /**
   * dir: where the files and index.json live · ffmpeg: Ffmpeg (probe / require / run)
   * fetchFn(url, dest, { signal, kind }) for tests · now() for tests
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
      this.items = Array.isArray(j.items) ? j.items.filter((x) => x && /^dl-[0-9a-f]{8}$/.test(x.id) && fs.existsSync(path.join(this.dir, fileOf(x)))).map((x) => ({ kind: 'sfx', ...x })) : [];
    } catch {
      this.items = [];
    }
    return this.items;
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, 'index.json');
    fs.writeFileSync(`${file}.part`, JSON.stringify({ version: 2, items: this.items }, null, 2));
    fs.renameSync(`${file}.part`, file);
  }

  /** Every entry, or only those of one kind ('sfx' | 'music' | 'image'). */
  list(kind) {
    return this._load().filter((x) => !kind || x.kind === kind).map((x) => ({ ...x }));
  }

  get(id) {
    return this._load().find((x) => x.id === id) || null;
  }

  filePath(id) {
    const x = this.get(id);
    return x ? path.join(this.dir, fileOf(x)) : null;
  }

  remove(id) {
    const items = this._load();
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) throw new SfxError('ไม่พบไฟล์นี้ในคลัง', 'NONE');
    const [gone] = items.splice(i, 1);
    try { fs.rmSync(path.join(this.dir, fileOf(gone)), { force: true }); } catch { /* best effort */ }
    this._save();
    return { ok: true };
  }

  /**
   * Fetches one suggested file of the given kind. found: { url (or audioUrl), pageUrl, title, license, role }.
   * Resolves the library entry (the same one when the link is already in the library).
   */
  async add(found, { signal, kind = 'sfx' } = {}) {
    const src = SOURCES[kind];
    const url = checkUrl(found.url || found.audioUrl, kind);
    const id = `dl-${crypto.createHash('sha1').update(url.toString()).digest('hex').slice(0, 8)}`;
    const items = this._load();
    const known = items.find((x) => x.id === id);
    if (known) return { ...known };
    if (items.length >= MAX_ENTRIES) throw new SfxError('คลังเต็ม — ลบไฟล์ที่ไม่ใช้ก่อน', 'FULL');
    fs.mkdirSync(this.dir, { recursive: true });
    const raw = path.join(this.dir, `${id}.download`);
    const out = path.join(this.dir, `${id}.${src.out}`);
    const tmp = path.join(this.dir, `${id}.part.${src.out}`);
    try {
      await this.fetchFn(url.toString(), raw, { signal, kind });
      const info = await this.ffmpeg.probe(raw, { signal });
      const extra = {};
      let args;
      if (kind === 'image') {
        const v = info.video;
        if (!v || info.audio || !(v.width >= 16) || !(v.height >= 16) || v.width > MAX_IMAGE_SIDE || v.height > MAX_IMAGE_SIDE) throw new SfxError('ไฟล์นี้ไม่ใช่รูปที่ใช้ได้', 'IMAGE');
        extra.width = Math.min(v.width, 512);
        extra.height = Math.round((v.height * extra.width) / v.width);
        args = ['-hide_banner', '-y', '-i', raw, '-frames:v', '1', '-update', '1', '-vf', "scale=w='min(512,iw)':h=-2:flags=lanczos,format=rgba", tmp];
      } else {
        if (!info.audio) throw new SfxError('ไฟล์นี้ไม่มีเสียง', 'AUDIO');
        if (!(info.duration >= src.minSeconds) || info.duration > src.maxSeconds) {
          throw new SfxError(kind === 'music'
            ? `เพลงนี้ยาว ${Math.round(info.duration || 0)} วินาที (ต้องอยู่ระหว่าง ${src.minSeconds} วินาทีถึง ${src.maxSeconds / 60} นาที)`
            : `เสียงนี้ยาว ${Math.round(info.duration || 0)} วินาที ไม่ใช่เสียงเอฟเฟกต์สั้น (ไม่เกิน ${src.maxSeconds} วินาที)`, 'LENGTH');
        }
        extra.seconds = Math.round(Math.min(info.duration, src.maxSeconds) * 100) / 100;
        args = kind === 'music'
          ? ['-hide_banner', '-y', '-i', raw, '-vn', '-map', '0:a:0', '-t', String(src.maxSeconds), '-af', 'loudnorm=I=-18:TP=-2:LRA=11', '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '160k', tmp]
          : ['-hide_banner', '-y', '-i', raw, '-vn', '-map', '0:a:0', '-t', String(src.maxSeconds), '-af', 'loudnorm=I=-20:TP=-2:LRA=7', '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', tmp];
      }
      const { ffmpeg } = await this.ffmpeg.require();
      const r = await this.ffmpeg.run(ffmpeg, args, { signal });
      if (r.code !== 0 || !fs.existsSync(tmp)) throw new SfxError('แปลงไฟล์ไม่สำเร็จ', 'CONVERT');
      fs.renameSync(tmp, out);
      const entry = {
        id,
        kind,
        file: path.basename(out),
        title: clean(found.title, 60) || DEFAULT_TITLE[kind],
        role: clean(found.role, 40),
        ...extra,
        host: url.hostname,
        sourcePage: /^https:\/\//.test(String(found.pageUrl || '')) ? clean(found.pageUrl, 300) : '',
        license: src.hosts[url.hostname].license,
        licenseNote: clean(found.license, 300),
        addedAt: new Date(this.now()).toISOString(),
      };
      items.push(entry);
      this._save();
      return { ...entry };
    } finally {
      for (const f of [raw, tmp]) {
        try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
      }
    }
  }
}

module.exports = { SfxLibrary, SfxError, SOURCES, ALLOWED_HOSTS, checkUrl, fetchAudio, MAX_BYTES, MAX_SECONDS };
