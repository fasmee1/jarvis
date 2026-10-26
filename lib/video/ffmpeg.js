'use strict';
// Finds, installs and runs ffmpeg / ffprobe for the video editor.
// Lookup order: the path the user set (settings.ffmpegPath) → our own copy in
// userData/video/ffmpeg → ffmpeg on the system PATH. Our copy is a pinned
// Windows build, checked by SHA-256 before it is unpacked.
// Every process is spawned with an args array (shell:false); a cancel kills the whole tree.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const installer = require('../installer/download');

// gyan.dev "essentials" build (GPLv3), mirrored as a GitHub release. Not bundled: downloaded on request.
const PINNED = Object.freeze({
  version: '7.1.1',
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip',
  sha256: '04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4',
  size: 92234348,
});

const MAX_STDOUT = 8 * 1024 * 1024;
const MAX_STDERR = 8 * 1024 * 1024;

class FfmpegError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Streams a file through SHA-256 (the zip is ~90 MB, so no readFileSync). */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** "30000/1001" → 29.97; bad input → null */
function parseRate(r) {
  const m = /^(\d+)\/(\d+)$/.exec(String(r || ''));
  if (!m || !Number(m[2])) return null;
  const v = Number(m[1]) / Number(m[2]);
  return v > 0 && v < 1000 ? Math.round(v * 1000) / 1000 : null;
}

/** ffprobe JSON → the few facts the editor needs. Phone clips often carry a 90° rotation. */
function parseProbe(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const streams = Array.isArray(data && data.streams) ? data.streams : [];
  const fmt = (data && data.format) || {};
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  let duration = parseFloat(fmt.duration);
  if (!Number.isFinite(duration)) duration = parseFloat((v && v.duration) || (a && a.duration));
  let video = null;
  if (v) {
    let rotation = 0;
    for (const sd of v.side_data_list || []) if (Number.isFinite(Number(sd.rotation))) rotation = Number(sd.rotation);
    if (!rotation && v.tags && v.tags.rotate) rotation = Number(v.tags.rotate) || 0;
    rotation = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
    const turned = rotation === 90 || rotation === 270;
    video = {
      codec: v.codec_name || '',
      width: turned ? v.height : v.width, // as it looks on screen
      height: turned ? v.width : v.height,
      rotation,
      fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
    };
  }
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    video,
    audio: a ? { codec: a.codec_name || '', sampleRate: Number(a.sample_rate) || null, channels: a.channels || null } : null,
    size: Number(fmt.size) || null,
  };
}

class Ffmpeg {
  /**
   * dataDir: userData/video. getCustomPath(): the user's ffmpeg path ('' = none).
   * deps (tests): download, extractZip, findFile, spawn, hash, env, platform.
   */
  constructor({ dataDir, getCustomPath = () => '', deps = {} }) {
    this.dataDir = dataDir;
    this.getCustomPath = getCustomPath;
    this.download = deps.download || installer.download;
    this.extractZip = deps.extractZip || installer.extractZip;
    this.findFile = deps.findFile || installer.findFile;
    this.spawn = deps.spawn || childProcess.spawn;
    this.hash = deps.hash || sha256File;
    this.env = deps.env || process.env;
    this.platform = deps.platform || process.platform;
    this.installing = null;
    this.versions = new Map(); // exe path → version string ('' when it would not run)
  }

  exeName(base) {
    return this.platform === 'win32' ? `${base}.exe` : base;
  }

  installDir() {
    return path.join(this.dataDir, 'ffmpeg');
  }

  /** Checks the user's path (the exe or its folder): an existing ffmpeg with ffprobe next to it. */
  checkCustom(p) {
    if (!p) return null;
    if (!path.isAbsolute(p)) throw new FfmpegError('ที่อยู่ ffmpeg ต้องเป็นที่อยู่เต็ม เช่น C:\\ffmpeg\\bin\\ffmpeg.exe', 'BAD_PATH');
    let file = p;
    try {
      if (fs.statSync(p).isDirectory()) file = path.join(p, this.exeName('ffmpeg'));
    } catch { /* reported below */ }
    if (path.basename(file).toLowerCase() !== this.exeName('ffmpeg').toLowerCase()) {
      throw new FfmpegError(`ไฟล์ต้องชื่อ ${this.exeName('ffmpeg')}`, 'BAD_PATH');
    }
    if (!isFile(file)) throw new FfmpegError('ไม่พบ ffmpeg ตามที่อยู่ที่ตั้งไว้', 'BAD_PATH');
    const probe = path.join(path.dirname(file), this.exeName('ffprobe'));
    if (!isFile(probe)) throw new FfmpegError('พบ ffmpeg แต่ไม่มี ffprobe อยู่ในโฟลเดอร์เดียวกัน', 'BAD_PATH');
    return { ffmpeg: file, ffprobe: probe, source: 'custom' };
  }

  installed() {
    const dir = this.installDir();
    if (!fs.existsSync(dir)) return null;
    const ff = this.findFile(dir, this.exeName('ffmpeg'));
    if (!ff) return null;
    const probe = path.join(path.dirname(ff), this.exeName('ffprobe'));
    return isFile(probe) ? { ffmpeg: ff, ffprobe: probe, source: 'installed' } : null;
  }

  /** ffmpeg on PATH, found by looking in each folder (nothing is run to search). */
  system() {
    const sep = this.platform === 'win32' ? ';' : ':';
    for (const raw of String(this.env.PATH || this.env.Path || '').split(sep)) {
      const dir = raw.trim().replace(/^"(.*)"$/, '$1');
      if (!dir || !path.isAbsolute(dir)) continue; // a relative entry depends on the cwd: skip it
      const ff = path.join(dir, this.exeName('ffmpeg'));
      const probe = path.join(dir, this.exeName('ffprobe'));
      if (isFile(ff) && isFile(probe)) return { ffmpeg: ff, ffprobe: probe, source: 'system' };
    }
    return null;
  }

  /** The tools to use, or null. A bad custom path is reported, not silently skipped. */
  locate() {
    const custom = this.getCustomPath();
    if (custom) return this.checkCustom(custom);
    return this.installed() || this.system();
  }

  /** Version of an ffmpeg, cached per path; '' if it would not run. */
  async version(exe) {
    if (this.versions.has(exe)) return this.versions.get(exe);
    let ver = '';
    try {
      const r = await this.run(exe, ['-hide_banner', '-version'], { timeoutMs: 15000 });
      const m = /ffmpeg version (\S+)/.exec(r.stdout);
      ver = r.code === 0 && m ? m[1] : '';
    } catch {
      ver = '';
    }
    this.versions.set(exe, ver);
    return ver;
  }

  async status() {
    const base = { ready: false, source: null, ffmpeg: null, version: '', installing: !!this.installing, error: '', pinned: PINNED.version };
    let tools;
    try {
      tools = this.locate();
    } catch (err) {
      return { ...base, error: err.message };
    }
    if (!tools) return base;
    const version = await this.version(tools.ffmpeg);
    if (!version) return { ...base, source: tools.source, ffmpeg: tools.ffmpeg, error: 'พบ ffmpeg แต่เปิดใช้งานไม่ได้' };
    return { ...base, ready: true, source: tools.source, ffmpeg: tools.ffmpeg, version };
  }

  /** The tools, or throws a Thai error the UI can show as is. */
  async require() {
    const tools = this.locate();
    if (!tools) throw new FfmpegError('ยังไม่มี ffmpeg — กดติดตั้งในตั้งค่า > วิดีโอ', 'NO_FFMPEG');
    if (!(await this.version(tools.ffmpeg))) throw new FfmpegError('พบ ffmpeg แต่เปิดใช้งานไม่ได้', 'BAD_FFMPEG');
    return tools;
  }

  /** Downloads and unpacks the pinned build. One install at a time; resolves { ok, status | error }. */
  install(onProgress = () => {}) {
    if (!this.installing) {
      this.installing = this._install(onProgress)
        .then(async () => {
          this.versions.clear();
          return { ok: true };
        })
        .catch((err) => ({ ok: false, error: err.message }))
        .finally(() => {
          this.installing = null;
        })
        .then(async (r) => (r.ok ? { ok: true, status: await this.status() } : r));
    }
    return this.installing;
  }

  async _install(onProgress) {
    if (this.installed()) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const zip = path.join(this.dataDir, 'ffmpeg.zip');
    const dir = this.installDir();
    const tmp = dir + '.part';
    try {
      onProgress({ step: 'ffmpeg', url: PINNED.url });
      await this.download(PINNED.url, zip, { onProgress: (p) => onProgress({ step: 'ffmpeg', ...p }) });
      onProgress({ step: 'ตรวจไฟล์' });
      const got = await this.hash(zip);
      if (got !== PINNED.sha256) throw new FfmpegError('ไฟล์ ffmpeg ที่ดาวน์โหลดมาไม่ตรงกับต้นฉบับ (checksum ไม่ตรง) จึงไม่ติดตั้ง', 'CHECKSUM');
      onProgress({ step: 'แตกไฟล์' });
      fs.rmSync(tmp, { recursive: true, force: true });
      await this.extractZip(zip, tmp);
      if (!this.findFile(tmp, this.exeName('ffmpeg'))) throw new FfmpegError('แตกไฟล์แล้วแต่ไม่พบ ffmpeg', 'NO_EXE');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir); // the folder appears only when complete
      onProgress({ step: 'ติดตั้งเสร็จ', done: true });
    } finally {
      fs.rmSync(zip, { force: true });
      fs.rmSync(zip + '.part', { force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Runs an executable with an args array. Resolves { code, stdout, stderr } (also on a non-zero exit).
   * opts.signal cancels (rejects with code ABORTED once the process is gone).
   * opts.onStderr(chunk) sees live output (progress). opts.timeoutMs kills a hung run.
   */
  run(exe, args, { signal, onStderr, timeoutMs = 0, cwd } = {}) {
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new TypeError('args must be an array of strings');
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new FfmpegError('ยกเลิกแล้ว', 'ABORTED'));
      let p;
      try {
        p = this.spawn(exe, args, { shell: false, windowsHide: true, cwd: cwd || path.dirname(exe), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        return reject(new FfmpegError(`เปิด ${path.basename(exe)} ไม่ได้: ${err.message}`, 'SPAWN'));
      }
      let stdout = '';
      let stderr = '';
      let why = null;
      const stop = (reason) => {
        if (why) return;
        why = reason;
        killTree(p, this.platform, this.spawn);
      };
      const onAbort = () => stop('abort');
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = timeoutMs ? setTimeout(() => stop('timeout'), timeoutMs) : null;
      const done = () => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      p.stdout.setEncoding('utf8');
      p.stderr.setEncoding('utf8');
      p.stdout.on('data', (d) => {
        if (stdout.length < MAX_STDOUT) stdout += d;
      });
      p.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-MAX_STDERR);
        if (onStderr) {
          try {
            onStderr(d);
          } catch { /* a progress handler must not break the run */ }
        }
      });
      p.on('error', (err) => {
        done();
        reject(new FfmpegError(`เปิด ${path.basename(exe)} ไม่ได้: ${err.message}`, 'SPAWN'));
      });
      p.on('close', (code) => {
        done();
        if (why === 'abort') return reject(new FfmpegError('ยกเลิกแล้ว', 'ABORTED'));
        if (why === 'timeout') return reject(new FfmpegError(`${path.basename(exe)} ใช้เวลานานเกินไป`, 'TIMEOUT'));
        resolve({ code, stdout, stderr });
      });
    });
  }

  /** Duration, picture size, rotation, fps and audio facts of a media file. */
  async probe(file, { signal } = {}) {
    const input = checkInput(file);
    const { ffprobe } = await this.require();
    const r = await this.run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], { signal, timeoutMs: 60000 });
    if (r.code !== 0) throw new FfmpegError(`อ่านข้อมูลไฟล์ไม่ได้ ${lastLine(r.stderr)}`.trim(), 'PROBE');
    let info;
    try {
      info = parseProbe(r.stdout);
    } catch {
      throw new FfmpegError('อ่านข้อมูลไฟล์ไม่ได้', 'PROBE');
    }
    if (!info.video && !info.audio) throw new FfmpegError('ไฟล์นี้ไม่มีภาพหรือเสียง', 'PROBE');
    return info;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function lastLine(s) {
  return String(s || '').trim().split(/\r?\n/).pop().slice(0, 200);
}

function checkInput(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new FfmpegError('ต้องระบุที่อยู่เต็มของไฟล์', 'BAD_PATH');
  if (!isFile(file)) throw new FfmpegError('ไม่พบไฟล์', 'BAD_PATH');
  return path.resolve(file);
}

function killTree(p, platform, spawn) {
  if (platform === 'win32' && p.pid) {
    try {
      const k = spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      if (k && k.on) k.on('error', () => {
        try { p.kill(); } catch { /* gone */ }
      });
      return;
    } catch { /* fall through */ }
  }
  try { p.kill(); } catch { /* gone */ }
}

module.exports = { Ffmpeg, FfmpegError, PINNED, parseProbe, parseRate, sha256File, checkInput };
