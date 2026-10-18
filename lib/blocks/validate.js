'use strict';
// Small JSON-schema subset validator (type, required, properties, items,
// minItems, maxItems, maxLength, minimum). Returns a list of error strings.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function validate(schema, value, at = '$') {
  const errs = [];
  const t = typeOf(value);
  if (schema.type) {
    const ok = schema.type === t || (schema.type === 'number' && t === 'integer');
    if (!ok) return [`${at}: ต้องเป็น ${schema.type} แต่ได้ ${t}`];
  }
  if (schema.type === 'string' && schema.maxLength != null && value.length > schema.maxLength) {
    errs.push(`${at}: ยาวเกิน ${schema.maxLength} ตัวอักษร`);
  }
  if ((schema.type === 'number' || schema.type === 'integer') && schema.minimum != null && value < schema.minimum) {
    errs.push(`${at}: ต้องไม่น้อยกว่า ${schema.minimum}`);
  }
  if (schema.type === 'array') {
    if (schema.minItems != null && value.length < schema.minItems) errs.push(`${at}: ต้องมีอย่างน้อย ${schema.minItems} รายการ`);
    if (schema.maxItems != null && value.length > schema.maxItems) errs.push(`${at}: มีได้ไม่เกิน ${schema.maxItems} รายการ`);
    if (schema.items) value.forEach((item, i) => errs.push(...validate(schema.items, item, `${at}[${i}]`)));
  }
  if (schema.type === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errs.push(`${at}: ขาดฟิลด์ "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value && value[key] !== undefined) errs.push(...validate(sub, value[key], `${at}.${key}`));
    }
  }
  return errs;
}

module.exports = { validate };
