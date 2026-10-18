'use strict';
// TTS provider backed by Microsoft Edge "Read aloud" neural voices
// (e.g. th-TH-NiwatNeural) over the public WebSocket endpoint. Needs internet;
// returns MP3 bytes, which the renderer decodes with decodeAudioData like WAV.

const crypto = require('crypto');
const { secMsGec, TRUSTED_CLIENT_TOKEN } = require('./edge-drm');

const CHROMIUM_VERSION = '143.0.3650.75';
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const DEFAULT_VOICE = 'th-TH-NiwatNeural';

const VOICES = [
  { name: 'th-TH-NiwatNeural', lang: 'th-TH', gender: 'male', neural: true },
  { name: 'th-TH-PremwadeeNeural', lang: 'th-TH', gender: 'female', neural: true },
];

function escapeXml(s) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

const pct = (x) => {
  const n = Math.round((x - 1) * 100);
  return (n >= 0 ? '+' : '') + n + '%';
};

function ssml(text, voice, rate, pitch) {
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='th-TH'>"
    + `<voice name='${voice}'><prosody pitch='${pct(pitch)}' rate='${pct(rate)}' volume='+0%'>`
    + escapeXml(text)
    + '</prosody></voice></speak>';
}

class EdgeTts {
  static VOICES = VOICES;
  static DEFAULT_VOICE = DEFAULT_VOICE;

  static isEdgeVoice(name) {
    return VOICES.some((v) => v.name === name);
  }

  async voices() {
    return VOICES.map((v) => ({ ...v }));
  }

  /** @returns {Promise<Buffer>} MP3 bytes */
  synthesize(text, { voice = DEFAULT_VOICE, rate = 1, pitch = 1, timeoutMs = 15000 } = {}) {
    if (!EdgeTts.isEdgeVoice(voice)) voice = DEFAULT_VOICE;
    const connId = crypto.randomUUID().replace(/-/g, '');
    const url = `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec()}`
      + `&Sec-MS-GEC-Version=2-${CHROMIUM_VERSION}&ConnectionId=${connId}`;
    const major = CHROMIUM_VERSION.split('.')[0];
    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
      },
    });
    ws.binaryType = 'arraybuffer';

    return new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* gone */ }
        if (err) return reject(Object.assign(err, { code: 'TTS_FAILED' }));
        if (!chunks.length) return reject(Object.assign(new Error('Edge TTS: no audio'), { code: 'TTS_FAILED' }));
        resolve(Buffer.concat(chunks));
      };
      const timer = setTimeout(() => finish(new Error('Edge TTS timeout')), timeoutMs);

      ws.onopen = () => {
        const ts = new Date().toString();
        ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
          + JSON.stringify({ context: { synthesis: { audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
            outputFormat: OUTPUT_FORMAT,
          } } } }) + '\r\n');
        ws.send(`X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n`
          + ssml(text, voice, rate, pitch));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          if (ev.data.includes('Path:turn.end')) finish();
          return;
        }
        // Binary frame: 2-byte big-endian header length, header text, then audio.
        const buf = Buffer.from(ev.data);
        if (buf.length < 2) return;
        const hlen = buf.readUInt16BE(0);
        const header = buf.subarray(2, 2 + hlen).toString('utf8');
        if (header.includes('Path:audio')) chunks.push(buf.subarray(2 + hlen));
      };
      ws.onerror = (ev) => finish(new Error('Edge TTS: ' + ((ev && ev.message) || 'connection failed')));
      ws.onclose = () => finish(chunks.length ? null : new Error('Edge TTS: connection closed'));
    });
  }

  dispose() {}
}

module.exports = { EdgeTts };
