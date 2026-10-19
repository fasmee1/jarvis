'use strict';
// Typhoon ASR (SCB 10X, Thai) via its OpenAI-compatible transcription endpoint.
// Free tier: 100 requests/minute. The API key is kept encrypted with safeStorage in main.

const { pcm16ToWav } = require('./wav');

const ENDPOINT = 'https://api.opentyphoon.ai/v1/audio/transcriptions';
const MODEL = 'typhoon-asr-realtime';

class TyphoonProvider {
  constructor({ getKey }) {
    this.getKey = getKey;
  }

  status() {
    return { provider: 'typhoon', hasKey: !!this.getKey(), model: MODEL };
  }

  async transcribe(pcm) {
    const key = this.getKey();
    if (!key) throw Object.assign(new Error('ยังไม่ได้ใส่ Typhoon API key ใน Settings'), { code: 'NO_TYPHOON_KEY' });
    const form = new FormData();
    form.append('model', MODEL);
    form.append('file', new Blob([pcm16ToWav(pcm)], { type: 'audio/wav' }), 'audio.wav');
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Typhoon API key ไม่ถูกต้อง'), { code: 'TYPHOON_AUTH' });
    if (res.status === 429) throw Object.assign(new Error('Typhoon ถูกจำกัดการใช้งานชั่วคราว (เกิน 100 ครั้ง/นาที) — ลองใหม่อีกครู่'), { code: 'TYPHOON_RATE_LIMIT' });
    if (!res.ok) throw new Error(`Typhoon ตอบ HTTP ${res.status}`);
    const j = await res.json();
    return String((j && j.text) || '').replace(/\s+/g, ' ').trim();
  }
}

module.exports = { TyphoonProvider, ENDPOINT, MODEL };
