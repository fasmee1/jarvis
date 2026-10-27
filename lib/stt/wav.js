'use strict';
// 16-bit PCM mono WAV encoding.

function pcm16ToWav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** The PCM bytes and sample rate of a 16-bit mono WAV (walks the chunks, so extra LIST chunks are fine). */
function readWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('ไม่ใช่ไฟล์ WAV');
  let off = 12;
  let rate = 16000;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
    if (id === 'data') return { pcm: buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)), rate };
    off += 8 + size + (size % 2);
  }
  throw new Error('ไม่พบข้อมูลเสียงใน WAV');
}

/** A WAV of seconds [start, end) of a read WAV ({ pcm, rate }). */
function sliceWav({ pcm, rate }, start, end) {
  const a = Math.max(0, Math.floor(start * rate)) * 2;
  const b = Math.min(pcm.length, Math.ceil(end * rate) * 2);
  return pcm16ToWav(pcm.subarray(a, Math.max(a, b)), rate);
}

/** RMS level of int16 PCM in [0,1]. */
function rms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

module.exports = { pcm16ToWav, readWav, sliceWav, rms };
