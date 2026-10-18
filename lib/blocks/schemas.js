'use strict';
// JSON schemas for ```jarvis-<kind> fenced blocks. `code` kinds carry raw source.

const str = (maxLength = 2000) => ({ type: 'string', maxLength });
const num = { type: 'number' };
const RESULT_TYPES = ['search', 'news', 'youtube', 'images', 'web', 'weather', 'table', 'chart', 'text', 'map'];

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
  // Result Viewer payload, rendered by type (renderer/ui/results.js); new types can be added there.
  result: {
    type: 'object',
    required: ['type'],
    properties: {
      type: { type: 'string', enum: RESULT_TYPES },
      title: str(200),
      query: str(300),
      spokenSummary: str(600),
      url: str(2000),
      markdown: str(30000),
      summary: { type: 'object', properties: { text: str(2000) } },
      items: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          properties: {
            title: str(400),
            url: str(2000),
            site: str(120),
            source: str(120),
            snippet: str(800),
            summary: str(800),
            image: str(2000),
            publishedAt: str(60),
            videoId: str(20),
            channel: str(160),
            views: str(60),
            duration: str(30),
          },
        },
      },
      location: str(160),
      current: {
        type: 'object',
        properties: { temp: num, condition: str(120), feelsLike: num, humidity: num, wind: str(60), high: num, low: num },
      },
      hourly: {
        type: 'array',
        maxItems: 48,
        items: { type: 'object', properties: { time: str(20), temp: num, condition: str(80), rain: num } },
      },
      columns: { type: 'array', maxItems: 20, items: str(120) },
      rows: { type: 'array', maxItems: 300, items: { type: 'array', maxItems: 20 } },
      unit: str(40),
      labels: { type: 'array', maxItems: 200, items: str(40) },
      series: {
        type: 'array',
        maxItems: 6,
        items: { type: 'object', required: ['values'], properties: { name: str(80), values: { type: 'array', maxItems: 200, items: num } } },
      },
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lon: { type: 'number', minimum: -180, maximum: 180 },
      zoom: { type: 'integer', minimum: 1, maximum: 19 },
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
- \`\`\`jarvis-result JSON — ผลลัพธ์ที่ต้องดูบนจอใหญ่ (Result Viewer): {"type": "search"|"news"|"youtube"|"images"|"web"|"weather"|"table"|"chart"|"text"|"map", "title": string, "spokenSummary": "สรุป 1–3 ประโยคที่จะพูด", ...ฟิลด์ตามชนิด}
  search: "items": [{"title","url","site"?,"snippet"}] และ "summary"?: {"text": "สรุป 3–5 บรรทัด อ้างอิง [1] [2] ตามลำดับ items"}
  news: "items": [{"title","url","source","publishedAt": ISO 8601,"summary","image"?: URL รูปข่าว}] ทุกข่าวต้องมี source และ publishedAt ข่าวเด่นสุดไว้ลำดับแรก
  youtube: "items": [{"videoId": รหัส 11 ตัวจาก youtube.com/watch?v=…,"title","channel","views"?,"duration"?,"publishedAt"?}] ลำดับแรกคือคลิปที่จะเล่น ที่เหลือ 3–5 รายการเป็น Up next
  images: "items": [{"image": URL ของรูปโดยตรง,"title","url": หน้าต้นทาง}] · web: "url" · map: "lat","lon","zoom"?,"location"?
  weather: "location","current": {"temp","condition","feelsLike"?,"humidity"?,"wind"?,"high"?,"low"?},"hourly": [{"time":"14:00","temp","condition"?,"rain"?: %}]
  table: "columns": [string],"rows": [[ค่า]] · chart: "labels": [string],"series": [{"name","values": [number]}],"unit"? · text: "markdown": คำตอบยาว
  ใช้ข้อมูลจริงจากเครื่องมือ (WebSearch / WebFetch) เท่านั้น ห้ามแต่ง URL, videoId หรือรูป ถ้าไม่มีให้เว้นฟิลด์นั้น
บล็อกต้องเป็น JSON ที่ถูกต้อง (ยกเว้น arduino/scad) และปิดด้วย \`\`\` บรรทัดของตัวเอง ข้อความในบล็อกจะไม่ถูกอ่านออกเสียง
`.trim();

module.exports = { SCHEMAS, CODE_KINDS, PROTOCOL_DOC };
