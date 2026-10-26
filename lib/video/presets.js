'use strict';
// Built-in clip styles and the cut "paces". Pure data: no I/O, safe to import anywhere.
// A style is what the user picks before JARVIS edits: a name, a description (the
// prompt JARVIS edits by), a pace and a target length. The pace only drives the
// first mechanical pass that trims pauses (auto-edit.js); the prompt drives the rest.

// silenceMs: pauses longer than this are cut. padMs: breathing room kept around speech.
// minKeepMs: kept pieces shorter than this are dropped.
const PACES = Object.freeze({
  fast: Object.freeze({ id: 'fast', label: 'เร็ว — ตัดช่วงเงียบเกือบหมด', silenceMs: 250, padMs: 60, minKeepMs: 400 }),
  normal: Object.freeze({ id: 'normal', label: 'ปานกลาง — ตัดช่วงเงียบที่ยาวเกินไป', silenceMs: 700, padMs: 150, minKeepMs: 700 }),
  slow: Object.freeze({ id: 'slow', label: 'ช้า — เก็บจังหวะหายใจไว้ ตัดแค่ช่วงว่างนาน ๆ', silenceMs: 1200, padMs: 250, minKeepMs: 1000 }),
});

const BUILTIN_STYLES = Object.freeze([
  Object.freeze({
    id: 'viral',
    name: 'ไวรัลจังหวะไว',
    pace: 'fast',
    targetSec: 30,
    prompt: 'คลิปสั้นแนวไวรัล จังหวะเร็วตลอดทั้งคลิป ตัดช่วงเงียบ คำว่า เอ่อ อ่า และคำพูดที่พูดซ้ำทิ้งให้หมด '
      + 'เปิดคลิปด้วยประโยคที่น่าสนใจที่สุดภายใน 3 วินาทีแรก (ย้ายมาไว้ต้นคลิปได้) เก็บเฉพาะช่วงที่มีสาระหรือสนุก '
      + 'ซับเด้งทีละคำตัวใหญ่ ซูมเข้าเป็นระยะทุก 3–5 วินาทีไม่ให้ภาพนิ่ง',
  }),
  Object.freeze({
    id: 'educational',
    name: 'สอน/ให้ความรู้',
    pace: 'normal',
    targetSec: 90,
    prompt: 'คลิปสอนหรือให้ความรู้ อ่านง่าย ไม่รีบ เก็บทุกประโยคที่อธิบายเนื้อหาให้ครบตามลำดับเดิม '
      + 'ตัดเฉพาะช่วงเงียบยาว ประโยคที่พูดผิดแล้วพูดใหม่ (เก็บครั้งที่ถูก) และช่วงที่ไม่เกี่ยวกับเนื้อหา '
      + 'ซับเป็นประโยคเต็มอ่านง่าย ไม่ต้องซูมบ่อย',
  }),
  Object.freeze({
    id: 'vlog',
    name: 'วล็อกชิล',
    pace: 'slow',
    targetSec: 60,
    prompt: 'วล็อกชิล จังหวะสบาย ๆ คงบรรยากาศและช่วงหยุดหายใจตามธรรมชาติไว้ '
      + 'ตัดเฉพาะช่วงว่างนาน ๆ และช่วงที่ไม่มีอะไรเกิดขึ้น เรียงตามลำดับเวลาเดิม ซับเรียบ ๆ ไม่ต้องซูม',
  }),
  Object.freeze({
    id: 'promo',
    name: 'โปรโมตสินค้า',
    pace: 'fast',
    targetSec: 20,
    prompt: 'คลิปโปรโมตสินค้า กระชับและมีพลัง เปิดด้วยจุดเด่นที่สุดของสินค้าหรือปัญหาที่สินค้าแก้ได้ '
      + 'ตามด้วยประโยชน์ 2–3 ข้อ ตัดส่วนที่ไม่ช่วยขายออก จบด้วยประโยคชวนซื้อหรือชวนกดติดตาม '
      + 'ซูมเข้าตอนพูดถึงจุดเด่น ซับตัวใหญ่',
  }),
]);

/** Settings for the mechanical pause-trimming pass (auto-edit.js) from a style. */
function cutParams(style) {
  const pace = PACES[style && style.pace] || PACES.normal;
  const target = Number(style && style.targetSec);
  return {
    id: (style && style.id) || pace.id,
    silenceMs: pace.silenceMs,
    padMs: pace.padMs,
    minKeepMs: pace.minKeepMs,
    speed: 1,
    targetSec: target > 0 ? target : Infinity, // 0 = no length limit
  };
}

function builtin(id) {
  return BUILTIN_STYLES.find((s) => s.id === id) || null;
}

module.exports = { PACES, BUILTIN_STYLES, cutParams, builtin };
