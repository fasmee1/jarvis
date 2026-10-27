'use strict';
// Serves the clips the user imported to the editor's <video> as app://jarvis/media/<token>.
// Only files registered here (picked in a dialog or dropped by the user) can be read,
// and the URL carries a random token, never the path. Range requests are answered
// with 206 so the preview can seek without loading the whole file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac']);
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.png': 'image/png', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
};
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB
const IMAGE_EXT = new Set(['.png']);
const MAX_ENTRIES = 600;

class MediaError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Is this a clip the editor can take? Returns the absolute path or throws a Thai message. */
function checkMediaFile(file, { image = false } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new MediaError('ต้องเป็นไฟล์ในเครื่อง (ที่อยู่เต็ม)', 'BAD_PATH');
  const ext = path.extname(file).toLowerCase();
  if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext) && !(image && IMAGE_EXT.has(ext))) {
    throw new MediaError('รองรับเฉพาะวิดีโอ (mp4 mov m4v webm mkv avi) และเสียง (mp3 m4a wav aac ogg flac)', 'BAD_TYPE');
  }
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new MediaError('ไม่พบไฟล์', 'NOT_FOUND');
  }
  if (!st.isFile()) throw new MediaError('ไม่พบไฟล์', 'NOT_FOUND');
  if (st.size > MAX_FILE_BYTES) throw new MediaError('ไฟล์ใหญ่เกิน 8 GB', 'TOO_BIG');
  return path.resolve(file);
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  return VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : 'audio';
}

/**
 * "bytes=0-" style header → { start, end } (inclusive) within size, or null when
 * there is no usable range (serve the whole file), or 'invalid' (416).
 * Only a single range is supported, which is what <video> sends.
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]); // suffix: the last n bytes
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return 'invalid';
  return { start, end };
}

class MediaRegistry {
  constructor() {
    this.byToken = new Map(); // token → { path, mime, kind }
    this.byPath = new Map(); // path (lower case on Windows) → token
  }

  _key(p) {
    return process.platform === 'win32' ? p.toLowerCase() : p;
  }

  /** Registers a checked file; the same file keeps its token. Returns { token, url, kind, name, path }. */
  add(file, { image = false } = {}) {
    const full = checkMediaFile(file, { image });
    let token = this.byPath.get(this._key(full));
    if (!token) {
      if (this.byToken.size >= MAX_ENTRIES) {
        const oldest = this.byToken.keys().next().value;
        this.byPath.delete(this._key(this.byToken.get(oldest).path));
        this.byToken.delete(oldest);
      }
      token = crypto.randomBytes(16).toString('hex');
      this.byToken.set(token, { path: full, mime: MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', kind: kindOf(full) });
      this.byPath.set(this._key(full), token);
    }
    const e = this.byToken.get(token);
    return { token, url: `app://jarvis/media/${token}`, kind: e.kind, name: path.basename(full), path: full };
  }

  get(token) {
    return /^[0-9a-f]{32}$/.test(String(token)) ? this.byToken.get(token) || null : null;
  }

  /** Answers a request for app://jarvis/media/<token> (pathname "/media/<token>"). */
  respond(pathname, headers) {
    const m = /^\/media\/([0-9a-f]{32})$/.exec(pathname);
    const entry = m && this.get(m[1]);
    if (!entry) return new Response('not found', { status: 404 });
    let st;
    try {
      st = fs.statSync(entry.path);
    } catch {
      return new Response('not found', { status: 404 });
    }
    const size = st.size;
    const get = (k) => (headers && typeof headers.get === 'function' ? headers.get(k) : headers && headers[k]);
    const range = parseRange(get('range') || get('Range'), size);
    const base = { 'Content-Type': entry.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (range === 'invalid') return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
    if (!size) return new Response(null, { status: 200, headers: { ...base, 'Content-Length': '0' } });
    const { start, end } = range || { start: 0, end: size - 1 };
    const body = Readable.toWeb(fs.createReadStream(entry.path, { start, end }));
    const h = { ...base, 'Content-Length': String(end - start + 1) };
    if (!range) return new Response(body, { status: 200, headers: h });
    return new Response(body, { status: 206, headers: { ...h, 'Content-Range': `bytes ${start}-${end}/${size}` } });
  }
}

module.exports = { MediaRegistry, MediaError, checkMediaFile, parseRange, kindOf, VIDEO_EXT, AUDIO_EXT };
