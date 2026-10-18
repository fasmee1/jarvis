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
// Thai fine-tuned models (community ggml builds, Apache-2.0), verified by SHA-256 after download
const THAI_MODELS = {
  'thonburian-medium': { url: 'https://huggingface.co/suebphatt/thonburian-whisper-ggml/resolve/main/thonburian-medium-q5_0.bin', sha256: '25fe6beb59477b2f161371fb206e898843058f22ac13036159f83eba0a92336d' },
};
const MODEL_URL = (m) => (THAI_MODELS[m] ? THAI_MODELS[m].url : `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${m}.bin`);

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

  modelPath(model = this.model) {
    return path.join(this.dataDir, 'models', `ggml-${model}.bin`);
  }

  /**
   * A fast model for side jobs (wake-word check, live previews) when the chosen
   * one is slow: small / base if downloaded, else the chosen model.
   */
  fastModel() {
    if (this.model === 'small' || this.model === 'base') return this.model;
    for (const m of ['small', 'base']) if (fs.existsSync(this.modelPath(m))) return m;
    return this.model;
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
      const want = THAI_MODELS[this.model] && THAI_MODELS[this.model].sha256;
      if (want) {
        const got = crypto.createHash('sha256').update(fs.readFileSync(this.modelPath())).digest('hex');
        if (got !== want) { fs.rmSync(this.modelPath(), { force: true }); throw new Error('ไฟล์โมเดลเสีย (checksum ไม่ตรง) — ลองดาวน์โหลดใหม่'); }
      }
    }
    return this.status();
  }

  /**
   * opts.signal: AbortSignal — kills whisper (used to drop a live partial when the final starts).
   * opts.model: use this model instead of the chosen one (fast side jobs).
   */
  async transcribe(pcm, { signal, threads: nThreads, audioCtx = 0, model = this.model } = {}) {
    const exe = this.exe();
    if (!exe) throw Object.assign(new Error('ยังไม่ได้ติดตั้ง whisper.cpp — กดติดตั้งใน Settings'), { code: 'NO_WHISPER' });
    const modelFile = this.modelPath(model);
    if (!fs.existsSync(modelFile)) throw Object.assign(new Error(`ไม่พบโมเดล whisper (${model}) — กดติดตั้งใน Settings`), { code: 'NO_MODEL' });
    fs.mkdirSync(this.tempDir, { recursive: true });
    const base = path.join(this.tempDir, 'stt-' + crypto.randomBytes(6).toString('hex'));
    const wav = base + '.wav';
    fs.writeFileSync(wav, pcm16ToWav(pcm));
    try {
      const threads = nThreads || Math.max(2, Math.min(8, os.cpus().length - 1));
      const args = ['-m', modelFile, '-l', 'th', '-f', wav, '-nt', '-np', '-otxt', '-of', base, '-t', String(threads)];
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
