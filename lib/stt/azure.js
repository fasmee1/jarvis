'use strict';
// Azure Speech (th-TH) provider using the short-audio REST endpoint.
// The subscription key is kept encrypted with Electron safeStorage in main.

const { pcm16ToWav } = require('./wav');

class AzureProvider {
  constructor({ getKey, region }) {
    this.getKey = getKey;
    this.region = region;
  }

  status() {
    return { provider: 'azure', hasKey: !!this.getKey(), region: this.region };
  }

  async transcribe(pcm) {
    const key = this.getKey();
    if (!key || !this.region) throw Object.assign(new Error('ยังไม่ได้ใส่ Azure key หรือ region ใน Settings'), { code: 'NO_AZURE_KEY' });
    if (!/^[a-z0-9-]+$/i.test(this.region)) throw new Error('region ไม่ถูกต้อง');
    const url = `https://${this.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=th-TH&format=simple`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        Accept: 'application/json',
      },
      body: pcm16ToWav(pcm),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Azure ตอบ HTTP ${res.status}`);
    const j = await res.json();
    if (j.RecognitionStatus !== 'Success') return '';
    return String(j.DisplayText || '').trim();
  }
}

module.exports = { AzureProvider };
