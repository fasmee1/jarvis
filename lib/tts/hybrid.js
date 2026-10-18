'use strict';
// Prefers Edge neural voices (online) and falls back to Windows OneCore voices
// when the network or service fails. After a failure Edge is skipped for a
// short cooldown so every segment of a reply doesn't wait on a dead connection.

const { EdgeTts } = require('./edge');

const COOLDOWN_MS = 60000;
const MAX_PARALLEL = 3; // the renderer synthesizes segments concurrently

class HybridTts {
  constructor({ edge, fallback }) {
    this.edge = edge;
    this.fallback = fallback;
    this.edgeDownUntil = 0;
    this.active = 0;
    this.waiting = [];
  }

  async voices() {
    let local = [];
    try { local = await this.fallback.voices(); } catch { /* not windows */ }
    return [...(await this.edge.voices()), ...local];
  }

  async _slot(fn) {
    if (this.active >= MAX_PARALLEL) await new Promise((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  /** @returns {Promise<Buffer>} MP3 (Edge) or WAV (fallback) bytes */
  async synthesize(text, opts = {}) {
    if (EdgeTts.isEdgeVoice(opts.voice)) {
      if (Date.now() >= this.edgeDownUntil) {
        try {
          return await this._slot(() => this.edge.synthesize(text, opts));
        } catch {
          this.edgeDownUntil = Date.now() + COOLDOWN_MS;
        }
      }
      return this.fallback.synthesize(text, { ...opts, voice: '' });
    }
    return this.fallback.synthesize(text, opts);
  }

  dispose() {
    this.edge.dispose();
    this.fallback.dispose();
  }
}

module.exports = { HybridTts };
