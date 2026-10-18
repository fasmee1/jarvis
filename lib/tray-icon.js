'use strict';
// Tray icon drawn in code (a small cyan diamond, like the reactor logo), encoded
// as PNG, so the app ships no image files for it.
const zlib = require('zlib');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** PNG bytes of a size×size diamond; `live` adds a small amber dot (listening). */
function trayIconPng(size = 32, { live = false } = {}) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const c = (size - 1) / 2;
  const r = size * 0.42;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const d = Math.abs(x - c) + Math.abs(y - c);
      let a = Math.max(0, Math.min(1, r - d + 0.5)); // anti-aliased edge
      let col = [91, 225, 240];
      if (live) {
        const dx = x - size * 0.78;
        const dy = y - size * 0.78;
        const dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < size * 0.2) { col = [255, 154, 61]; a = Math.max(a, Math.min(1, size * 0.2 - dd)); }
      }
      px[o] = col[0];
      px[o + 1] = col[1];
      px[o + 2] = col[2];
      px[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(px)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { trayIconPng };
