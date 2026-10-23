'use strict';
// Order: Gemini (if enabled, keyed and under its daily cap) → Edge neural voices
// (online) → Windows OneCore voices. After a failure Edge is skipped for a
// short cooldown so every segment of a reply doesn't wait on a dead connection
// (Gemini keeps its own cooldown).

const { EdgeTts } = require('./edge');

const COOLDOWN_MS = 60000;
const MAX_PARALLEL = 3; // the renderer synthesizes segments concurrently

class HybridTts {
  constructor({ edge, fallback, gemini = null }) {
    this.edge = edge;
    this.fallback = fallback;
    this.gemini = gemini;
    this.geminiTail = Promise.resolve(); // Gemini requests run one at a time (tight free-tier rate)
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
    // An explicitly chosen Windows voice is respected; otherwise Gemini goes first.
    if (this.gemini && (!opts.voice || EdgeTts.isEdgeVoice(opts.voice)) && this.gemini.available()) {
      const run = this.geminiTail.then(() => (this.gemini.available() ? this.gemini.synthesize(text, opts) : null));
      this.geminiTail = run.catch(() => {});
      try {
        const wav = await run;
        if (wav) return wav;
      } catch { /* the provider set its own cooldown; fall through to Edge */ }
    }
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
