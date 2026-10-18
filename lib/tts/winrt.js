'use strict';
// TTS provider backed by Windows OneCore voices (e.g. "Microsoft Pattara" th-TH)
// through a persistent PowerShell worker. Chromium's speechSynthesis only sees
// SAPI voices, so Thai OneCore voices are reachable only this way.

const path = require('path');
const { spawn } = require('child_process');
const { StreamJsonParser } = require('../claude/stream-parser');

class WinRtTts {
  constructor() {
    this.proc = null;
    this.seq = 0;
    this.waiters = new Map();
    this.ready = null;
  }

  _start() {
    if (this.proc) return this.ready;
    const script = path.join(__dirname, 'winrt-worker.ps1');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.ready = new Promise((resolve, reject) => {
      this.waiters.set(0, { resolve, reject });
    });
    const parser = new StreamJsonParser({
      onEvent: (msg) => {
        const w = this.waiters.get(msg.id);
        if (!w) return;
        this.waiters.delete(msg.id);
        w.resolve(msg);
      },
    });
    proc.stdout.on('data', (d) => parser.push(d));
    proc.stderr.on('data', () => {});
    const die = (err) => {
      for (const w of this.waiters.values()) w.reject(err);
      this.waiters.clear();
      this.proc = null;
    };
    proc.on('error', die);
    proc.on('exit', (code) => die(new Error('TTS worker exited ' + code)));
    return this.ready;
  }

  async _call(req, timeoutMs = 20000) {
    await this._start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error('TTS timeout'));
      }, timeoutMs);
      this.waiters.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ id, ...req }) + '\n');
    });
  }

  async voices() {
    if (process.platform !== 'win32') return [];
    const r = await this._call({ cmd: 'voices' });
    return r.voices || [];
  }

  /** @returns {Promise<Buffer>} WAV bytes */
  async synthesize(text, { voice = '', rate = 1, pitch = 1 } = {}) {
    const r = await this._call({ cmd: 'speak', text_b64: Buffer.from(text, 'utf8').toString('base64'), voice, rate, pitch });
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error === 'NO_THAI_VOICE' ? 'NO_THAI_VOICE' : 'TTS_FAILED' });
    return Buffer.from(r.wav_b64, 'base64');
  }

  dispose() {
    if (this.proc) {
      try { this.proc.stdin.end(); this.proc.kill(); } catch { /* gone */ }
    }
    this.proc = null;
  }
}

module.exports = { WinRtTts };
