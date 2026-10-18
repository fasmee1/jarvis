'use strict';
// JSON schemas for ```jarvis-<kind> fenced blocks. `code` kinds carry raw source.

const str = (maxLength = 2000) => ({ type: 'string', maxLength });

const SCHEMAS = {
  steps: {
    type: 'object',
    required: ['steps'],
    properties: {
      title: str(200),
      current: { type: 'integer', minimum: 1 },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          required: ['title'],
          properties: {
            title: str(300),
            detail: str(4000),
            done: { type: 'boolean' },
            warning: str(1000),
          },
        },
      },
    },
  },
  diagram: {
    type: 'object',
    required: ['nodes'],
    properties: {
      title: str(200),
      nodes: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          required: ['id', 'label'],
          properties: {
            id: str(80),
            label: str(200),
            kind: str(40),
            pins: { type: 'array', maxItems: 80, items: str(40) },
          },
        },
      },
      edges: {
        type: 'array',
        maxItems: 500,
        items: {
          type: 'object',
          required: ['from', 'to'],
          properties: {
            from: str(120),
            to: str(120),
            label: str(120),
            color: str(30),
          },
        },
      },
    },
  },
  bom: {
    type: 'object',
    required: ['items'],
    properties: {
      title: str(200),
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 300,
        items: {
          type: 'object',
          required: ['name', 'qty'],
          properties: {
            name: str(200),
            qty: { type: 'number', minimum: 0 },
            spec: str(500),
            note: str(1000),
          },
        },
      },
    },
  },
};

// Kinds whose body is source code, not JSON.
const CODE_KINDS = new Set(['arduino', 'scad']);

const PROTOCOL_DOC = `
รูปแบบบล็อกสำหรับแสดงบน HUD (ใช้ fenced code block ที่ชื่อภาษาเป็น jarvis-<ชนิด>):
- \`\`\`jarvis-steps  JSON: {"title"?: string, "current"?: เลขขั้นปัจจุบัน(เริ่ม 1), "steps": [{"title": string, "detail"?: string, "done"?: boolean, "warning"?: string}]}
- \`\`\`jarvis-diagram JSON: {"title"?: string, "nodes": [{"id": string, "label": string, "kind"?: "board"|"sensor"|"actuator"|"power"|"other", "pins"?: [string]}], "edges": [{"from": "nodeId.pin หรือ nodeId", "to": "...", "label"?: string, "color"?: string}]}
- \`\`\`jarvis-bom JSON: {"title"?: string, "items": [{"name": string, "qty": number, "spec"?: string, "note"?: string}]}
- \`\`\`jarvis-arduino  โค้ด Arduino (.ino) ล้วน ไม่ใช่ JSON
- \`\`\`jarvis-scad     โค้ด OpenSCAD ล้วน ไม่ใช่ JSON
บล็อกต้องเป็น JSON ที่ถูกต้อง (ยกเว้น arduino/scad) และปิดด้วย \`\`\` บรรทัดของตัวเอง ข้อความในบล็อกจะไม่ถูกอ่านออกเสียง
`.trim();

module.exports = { SCHEMAS, CODE_KINDS, PROTOCOL_DOC };
