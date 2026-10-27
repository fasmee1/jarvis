'use strict';
// Runs HyperFrames for the video editor: puts a project on disk (the page, the source clips,
// gsap) and renders it to an MP4. It uses the pinned version through npx, with Node found on
// PATH (no shell, every argument is its own array item). Anonymous usage telemetry is switched
// off for the runs we start. The originals are only read: they are hard-linked (or copied)
// into the project's assets folder.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { FONT_FILES } = require('./hf-project');

const VERSION = '0.8.207';
const QUALITIES = Object.freeze({ draft: 'draft', standard: 'standard', high: 'high' });

class HfError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** node.exe and the npx script that ships with it, from PATH. */
function findNpx(env = process.env) {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    const node = path.join(dir, exe);
    if (!fs.existsSync(node)) continue;
    for (const rel of [['node_modules', 'npm', 'bin', 'npx-cli.js'], ['..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js']]) {
      const cli = path.join(dir, ...rel);
      if (fs.existsSync(cli)) return { node, cli };
    }
  }
  throw new HfError('ต้องมี Node.js ในเครื่องเพื่อสร้างวิดีโอด้วย HyperFrames (ติดตั้งจาก nodejs.org แล้วเปิดแอปใหม่)', 'NO_NODE');
}

/** A line of HyperFrames output → 0..1, or null. Lines look like: @hf-progress {"code":"compile","pct":5} */
function parseProgress(line) {
  const m = /@hf-progress\s+(\{.*\})/.exec(String(line));
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return Number.isFinite(j.pct) ? { fraction: Math.max(0, Math.min(1, j.pct / 100)), code: String(j.code || '') } : null;
  } catch {
    return null;
  }
}

function linkOrCopy(from, to) {
  try {
    if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) return;
    fs.rmSync(to, { force: true });
    try {
      fs.linkSync(from, to);
    } catch {
      fs.copyFileSync(from, to);
    }
  } catch (err) {
    throw new HfError(`เตรียมไฟล์คลิปให้โปรเจกต์ไม่สำเร็จ: ${err.message}`, 'PREPARE');
  }
}

class HfRender {
  /** root: folder that holds the projects · gsapFile: path of gsap.min.js · spawnFn: for tests */
  constructor({ root, gsapFile, fontsDir = '', version = VERSION, spawnFn = spawn }) {
    this.root = root;
    this.fontsDir = fontsDir;
    this.gsapFile = gsapFile;
    this.version = version;
    this.spawnFn = spawnFn;
  }

  /** True when the Thai font files are on disk, so pages can ship their own font. */
  hasFonts() {
    return !!this.fontsDir && FONT_FILES.every((f) => fs.existsSync(path.join(this.fontsDir, f)));
  }

  /**
   * Writes the project folder. files: [{ id, path }] original clips (asset names come from
   * `assetName(id, path)`, the same function the page was built with). Returns the folder.
   */
  prepare(projectId, { html, files, extra = [] }) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(projectId)) throw new HfError('ชื่อโปรเจกต์ไม่ถูกต้อง', 'ID');
    const dir = path.join(this.root, projectId);
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    fs.copyFileSync(this.gsapFile, path.join(assets, 'gsap.min.js'));
    for (const f of files) linkOrCopy(f.path, path.join(assets, assetName(f.id, f.path)));
    if (this.hasFonts()) {
      fs.mkdirSync(path.join(assets, 'fonts'), { recursive: true });
      for (const f of FONT_FILES) linkOrCopy(path.join(this.fontsDir, f), path.join(assets, 'fonts', f));
    }
    for (const f of extra) linkOrCopy(f.path, path.join(assets, path.basename(f.name))); // ready-made sounds
    fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
    return dir;
  }

  /**
   * Renders dir/index.html to `out` (an .mp4 path). onProgress(fraction, code) follows
   * HyperFrames' own progress lines. signal cancels (code ABORTED) and stops the whole process tree.
   */
  render(dir, { out, quality = 'draft', fps = 30, signal, onProgress = () => {} }) {
    if (!path.isAbsolute(out) || path.extname(out).toLowerCase() !== '.mp4') throw new HfError('ไฟล์ปลายทางต้องเป็น .mp4 และระบุที่อยู่เต็ม', 'OUT');
    if (!QUALITIES[quality]) throw new HfError('คุณภาพไม่ถูกต้อง', 'QUALITY');
    const { node, cli } = findNpx();
    const args = [cli, '--yes', `hyperframes@${this.version}`, 'render', dir, '--quality', quality, '--fps', String(fps), '--output', out];
    const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' };
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(node, args, { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let tailText = '';
      let buf = '';
      const feed = (d) => {
        const s = d.toString('utf8');
        tailText = (tailText + s).slice(-1500);
        buf += s;
        const lines = buf.split(/\r\n|\r|\n/);
        buf = lines.pop();
        for (const line of lines) {
          const p = parseProgress(line);
          if (p) {
            try { onProgress(p.fraction, p.code); } catch { /* the UI must not break the render */ }
          }
        }
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      const kill = () => {
        if (process.platform === 'win32' && child.pid) {
          try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ }
        } else {
          try { child.kill('SIGKILL'); } catch { /* gone */ }
        }
      };
      const onAbort = () => kill();
      if (signal) {
        if (signal.aborted) { kill(); return reject(new HfError('ยกเลิกแล้ว', 'ABORTED')); }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      child.on('error', (err) => reject(new HfError(`เปิด HyperFrames ไม่ได้: ${err.message}`, 'SPAWN')));
      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (signal && signal.aborted) return reject(new HfError('ยกเลิกแล้ว', 'ABORTED'));
        if (code === 0 && fs.existsSync(out)) return resolve(out);
        const last = tailText.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
        reject(new HfError(`HyperFrames สร้างวิดีโอไม่สำเร็จ (รหัส ${code})${last ? `: ${last.slice(0, 300)}` : ''}`, 'RENDER'));
      });
    });
  }
}

/** File name inside assets/ for a source: stable, ASCII, keeps the extension. */
function assetName(id, file) {
  const ext = path.extname(String(file)).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${String(id).replace(/[^A-Za-z0-9_-]/g, '')}${ext || ''}`;
}

module.exports = { HfRender, HfError, findNpx, parseProgress, assetName, VERSION, QUALITIES };
