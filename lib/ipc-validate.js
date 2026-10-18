'use strict';
// Input checks for every IPC channel. Throwing rejects the renderer's invoke().

function fail(msg) {
  const e = new Error('IPC input ไม่ถูกต้อง: ' + msg);
  e.code = 'BAD_INPUT';
  throw e;
}

const v = {
  obj(x, name = 'payload') {
    if (!x || typeof x !== 'object' || Array.isArray(x)) fail(`${name} ต้องเป็น object`);
    return x;
  },
  str(x, max, name = 'string', { optional = false } = {}) {
    if (x === undefined && optional) return undefined;
    if (typeof x !== 'string') fail(`${name} ต้องเป็น string`);
    if (x.length > max) fail(`${name} ยาวเกิน ${max}`);
    return x;
  },
  bool(x, name = 'bool') {
    if (typeof x !== 'boolean') fail(`${name} ต้องเป็น boolean`);
    return x;
  },
  num(x, name = 'number', { optional = false, min = -Infinity, max = Infinity } = {}) {
    if (x === undefined && optional) return undefined;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) fail(`${name} ต้องเป็นตัวเลขในช่วง`);
    return x;
  },
  oneOf(x, list, name = 'value') {
    if (!list.includes(x)) fail(`${name} ต้องเป็นหนึ่งใน ${list.join(', ')}`);
    return x;
  },
  bytes(x, max, name = 'bytes') {
    let buf;
    if (x instanceof ArrayBuffer) buf = Buffer.from(x);
    else if (ArrayBuffer.isView(x)) buf = Buffer.from(x.buffer, x.byteOffset, x.byteLength);
    else fail(`${name} ต้องเป็น ArrayBuffer`);
    if (buf.length > max) fail(`${name} ใหญ่เกิน ${max} bytes`);
    return buf;
  },
  strArray(x, maxItems, maxLen, name = 'list') {
    if (!Array.isArray(x) || x.length > maxItems) fail(`${name} ต้องเป็น array ไม่เกิน ${maxItems}`);
    x.forEach((s, i) => v.str(s, maxLen, `${name}[${i}]`));
    return x;
  },
};

module.exports = { v, fail };
