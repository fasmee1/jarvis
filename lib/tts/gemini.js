'use strict';
// TTS provider backed by the Gemini API (AI Studio key, free tier, no card).
// The model can be steered with a style prompt, which gives the emotional,
// conversational delivery. Returns WAV bytes (the API sends raw 16-bit PCM).
// Free-tier quota is not published for TTS, so the daily request cap is a setting
// and a 429 puts the provider on a growing cooldown (the caller falls back to Edge).

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_VOICE = 'Kore';
const DEFAULT_STYLE = 'Say in a warm, natural, friendly conversational Thai tone:';
const PROVIDER = 'gemini';
const COOLDOWN_BASE_MS = 60000;
const COOLDOWN_MAX_MS = 30 * 60000;
const BAD_KEY_COOLDOWN_MS = 10 * 60000;

/** Wrap raw 16-bit little-endian mono PCM in a WAV container. */
function pcmToWav(pcm, sampleRate = 24000) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); // fmt chunk size
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28); // byte rate
  head.writeUInt16LE(2, 32); // block align
  head.writeUInt16LE(16, 34); // bits per sample
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

class GeminiTts {
  /**
   * getKey(): API key or ''. getConfig(): { ttsGemini, geminiModel, geminiVoice,
   * geminiStyle, geminiDailyCap }. usage: a TtsUsage. fetchImpl / now: for tests.
   */
  constructor({ getKey, getConfig, usage, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.getKey = getKey;
    this.getConfig = getConfig;
    this.usage = usage;
    this.fetch = fetchImpl;
    this.now = now;
    this.downUntil = 0;
    this.failures = 0;
  }

  /** Enabled, has a key, under today's cap and not cooling down. */
  available() {
    const c = this.getConfig();
    if (!c.ttsGemini || !this.getKey()) return false;
    if (this.now() < this.downUntil) return false;
    return this.usage.snapshot(PROVIDER).day.requests < c.geminiDailyCap;
  }

  /** What the Settings panel shows. */
  status() {
    const c = this.getConfig();
    const u = this.usage.snapshot(PROVIDER);
    return {
      hasKey: !!this.getKey(),
      enabled: !!c.ttsGemini,
      model: c.geminiModel || DEFAULT_MODEL,
      voice: c.geminiVoice || DEFAULT_VOICE,
      dailyCap: c.geminiDailyCap,
      coolingDown: this.now() < this.downUntil,
      lastError: this.lastError || '',
      day: u.day,
      month: u.month,
    };
  }

  _fail(code, message, cooldownMs) {
    this.downUntil = this.now() + cooldownMs;
    this.lastError = message; // shown in Settings so a silent fallback to Edge can be diagnosed
    return Object.assign(new Error(message), { code });
  }

  /** @returns {Promise<Buffer>} WAV bytes */
  async synthesize(text, { timeoutMs = 20000 } = {}) {
    const key = this.getKey();
    if (!key) throw Object.assign(new Error('Gemini: no API key'), { code: 'NO_GEMINI_KEY' });
    const c = this.getConfig();
    const model = c.geminiModel || DEFAULT_MODEL;
    const style = c.geminiStyle || DEFAULT_STYLE;
    let res;
    try {
      res = await this.fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${style} ${text}` }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: c.geminiVoice || DEFAULT_VOICE } } },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // offline / timeout: skip Gemini for a while so each segment doesn't wait on it
      throw this._fail('TTS_FAILED', `Gemini: ${err.message}`, COOLDOWN_BASE_MS);
    }
    if (res.status === 429) {
      // Each consecutive 429 doubles the wait: 1, 2, 4 … 30 minutes.
      const wait = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** this.failures);
      this.failures++;
      throw this._fail('GEMINI_RATE_LIMIT', 'Gemini: quota reached (HTTP 429)', wait);
    }
    if (!res.ok) {
      // Google's own error text says why (bad key, API not enabled, model not found…)
      let why = '';
      try { why = (await res.json())?.error?.message || ''; } catch { /* no JSON body */ }
      why = why.slice(0, 200);
      if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
        throw this._fail('GEMINI_BAD_KEY', `Gemini: HTTP ${res.status}${why ? ` — ${why}` : ' (check the API key and model)'}`, BAD_KEY_COOLDOWN_MS);
      }
      throw this._fail('TTS_FAILED', `Gemini: HTTP ${res.status}${why ? ` — ${why}` : ''}`, COOLDOWN_BASE_MS);
    }
    const json = await res.json();
    const part = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw this._fail('TTS_FAILED', 'Gemini: no audio in the response', COOLDOWN_BASE_MS);
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1]) || 24000;
    this.failures = 0;
    this.lastError = '';
    this.usage.record(PROVIDER, text.length);
    return pcmToWav(Buffer.from(part.inlineData.data, 'base64'), rate);
  }
}

module.exports = { GeminiTts, pcmToWav, DEFAULT_MODEL, DEFAULT_VOICE, DEFAULT_STYLE };
