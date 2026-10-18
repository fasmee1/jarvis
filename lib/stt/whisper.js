'use strict';
// Local whisper.cpp provider (Thai). Binaries and models are installed into
// userData/stt by `install()`. Audio is written to a temp WAV that is deleted
// right after transcription.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { download, getJson, extractZip, findFile } = require('../installer/download');
const { pcm16ToWav } = require('./wav');

const PINNED_ZIP = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
const MODEL_URL = (m) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${m}.bin`;

class WhisperProvider {
  constructor({ dataDir, tempDir }) {
    this.dataDir = dataDir;
    this.tempDir = tempDir;
    this.model = 'small';
  }

  binDir() {
    return path.join(this.dataDir, 'whisper-bin');
  }

  exe() {
    const dir = this.binDir();
    if (!fs.existsSync(dir)) return null;
    return findFile(dir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  }

  modelPath() {
    return path.join(this.dataDir, 'models', `ggml-${this.model}.bin`);
  }

  status() {
    const exe = this.exe();
    const model = this.modelPath();
    return { provider: 'whisper', exe, model, hasExe: !!exe, hasModel: fs.existsSync(model), modelName: this.model };
  }

  async latestZipUrl() {
    try {
      const rels = await getJson('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10');
      for (const r of rels) {
        const a = (r.assets || []).find((x) => x.name === 'whisper-bin-x64.zip');
        if (a) return a.browser_download_url;
      }
    } catch { /* fall back to the pinned build */ }
    return PINNED_ZIP;
  }

  async install(onProgress = () => {}) {
    if (!this.exe()) {
      const url = await this.latestZipUrl();
      const zip = path.join(this.dataDir, 'whisper-bin-x64.zip');
      onProgress({ step: 'whisper.cpp', url });
      await download(url, zip, { onProgress: (p) => onProgress({ step: 'whisper.cpp', ...p }) });
      await extractZip(zip, this.binDir());
      fs.unlinkSync(zip);
      if (!this.exe()) throw new Error('แตกไฟล์แล้วแต่ไม่พบ whisper-cli.exe');
    }
    if (!fs.existsSync(this.modelPath())) {
      onProgress({ step: `model ${this.model}` });
      await download(MODEL_URL(this.model), this.modelPath(), { onProgress: (p) => onProgress({ step: `model ${this.model}`, ...p }) });
    }
    return this.status();
  }

  /** opts.signal: AbortSignal — kills whisper (used to drop a live partial when the final starts). */
  async transcribe(pcm, { signal, threads: nThreads, audioCtx = 0 } = {}) {
    const exe = this.exe();
    if (!exe) throw Object.assign(new Error('ยังไม่ได้ติดตั้ง whisper.cpp — กดติดตั้งใน Settings'), { code: 'NO_WHISPER' });
    if (!fs.existsSync(this.modelPath())) throw Object.assign(new Error(`ไม่พบโมเดล whisper (${this.model}) — กดติดตั้งใน Settings`), { code: 'NO_MODEL' });
    fs.mkdirSync(this.tempDir, { recursive: true });
    const base = path.join(this.tempDir, 'stt-' + crypto.randomBytes(6).toString('hex'));
    const wav = base + '.wav';
    fs.writeFileSync(wav, pcm16ToWav(pcm));
    try {
      const threads = nThreads || Math.max(2, Math.min(8, os.cpus().length - 1));
      const args = ['-m', this.modelPath(), '-l', 'th', '-f', wav, '-nt', '-np', '-otxt', '-of', base, '-t', String(threads)];
      // short clips (wake check): a smaller audio context is several times faster
      if (audioCtx) args.push('-ac', String(audioCtx));
      await new Promise((resolve, reject) => {
        const p = spawn(exe, args, { shell: false, windowsHide: true, cwd: path.dirname(exe) });
        // abort: kill, then reject only once the process has exited, so the temp
        // audio below is deleted (Windows keeps open files locked)
        let aborted = false;
        const kill = () => { aborted = true; try { p.kill(); } catch { /* gone */ } };
        if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true }); }
        let err = '';
        p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
        p.on('error', reject);
        p.on('exit', (code) => (aborted ? reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })) : code === 0 ? resolve() : reject(new Error(`whisper ล้มเหลว (exit ${code}) ${err.slice(-300)}`))));
      });
      const txt = fs.readFileSync(base + '.txt', 'utf8');
      return txt.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    } finally {
      // Audio is never kept: delete the temp files before returning.
      for (const f of [wav, base + '.txt']) {
        try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
      }
    }
  }
}

module.exports = { WhisperProvider, PINNED_ZIP, MODEL_URL };
