'use strict';
// JSON schemas for ```jarvis-<kind> fenced blocks. `code` kinds carry raw source.

const str = (maxLength = 2000) => ({ type: 'string', maxLength });
const num = { type: 'number' };
const RESULT_TYPES = ['search', 'news', 'youtube', 'images', 'web', 'weather', 'table', 'chart', 'text', 'map', 'model'];

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
      question: str(500),
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
      view3d: { type: 'boolean' },
      satellite: { type: 'boolean' },
      earth: { type: 'boolean' },
      streetview: { type: 'boolean' },
      autoRotate: { type: 'boolean' },
      glb: str(500),
      credit: str(400),
      parts: { type: 'array', maxItems: 300, items: { type: 'object', required: ['shape'], properties: { shape: str(20) } } },
    },
  },
};

SCHEMAS['model-search'] = {
  type: 'object',
  required: ['query'],
  properties: { query: str(120) },
};

SCHEMAS['image-to-3d'] = {
  type: 'object',
  required: ['path'],
  properties: { path: str(500), title: str(120) },
};

SCHEMAS.memory = {
  type: 'object',
  properties: {
    add: { type: 'array', maxItems: 5, items: str(200) },
    forget: { type: 'array', maxItems: 5, items: str(200) },
  },
};

SCHEMAS.reminder = {
  type: 'object',
  properties: {
    add: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        required: ['text'],
        properties: {
          text: str(200),
          inSeconds: { type: 'number', minimum: 1, maximum: 31536000 },
          time: str(5),
          date: str(10),
        },
      },
    },
    cancel: { type: 'array', maxItems: 5, items: str(200) },
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
- \`\`\`jarvis-reminder JSON: {"add"?: [{"text": string, "inSeconds"?: จำนวนวินาทีจากตอนนี้, "time"?: "HH:MM" เวลาท้องถิ่น 24 ชม. (ครั้งถัดไปที่ถึงเวลานี้), "date"?: "YYYY-MM-DD"}], "cancel"?: [คำที่ตรงกับข้อความเตือนที่ต้องยกเลิก]} ใช้เมื่อผู้ใช้ขอให้เตือน/ตั้งเวลา ถ้าบอกเป็นระยะเวลา ("อีก 10 นาที") ให้ใช้ inSeconds ถ้าบอกเป็นนาฬิกา ("บ่ายสาม") ให้ใช้ time แล้วพูดยืนยันเวลาที่ตั้งสั้น ๆ
- \`\`\`jarvis-memory JSON: {"add"?: [ข้อเท็จจริงสั้น ๆ ไม่เกิน 100 ตัวอักษร], "forget"?: [คำที่ตรงกับข้อที่ต้องลบ]} ใช้เมื่อผู้ใช้สั่ง จำไว้ว่า / ลืมเรื่อง เท่านั้น ห้ามจำเองโดยไม่ได้สั่ง ห้ามเก็บรหัสผ่านหรือความลับ แล้วพูดยืนยันสั้น ๆ
- \`\`\`jarvis-model-search JSON: {"query": คำค้นภาษาอังกฤษสั้น ๆ เช่น "sports car", "robot dog"} ใช้เมื่อผู้ใช้อยากดูโมเดล 3D สมจริงของสิ่งของจริง (รถ สัตว์ ตึก ตัวละคร ของใช้) แอปจะค้นและดาวน์โหลดโมเดลจริงจาก Sketchfab แล้วแสดงเอง ห้ามส่ง jarvis-result แทน ห้ามเขียนฟิลด์ glb เอง พูดบอกสั้น ๆ ว่ากำลังหาโมเดล ใช้ model แบบ parts เฉพาะงานออกแบบชิ้นงานที่ต้องกำหนดขนาดเอง
- \`\`\`jarvis-image-to-3d JSON: {"path": ที่อยู่เต็มของไฟล์รูป jpg/png/webp ที่ผู้ใช้แนบหรือระบุเอง, "title"?: ชื่อ} ใช้เมื่อผู้ใช้ขอแปลงรูปเป็นโมเดล 3D แอปจะถามผู้ใช้ยืนยันก่อนส่งรูปไปบริการภายนอก (Hugging Face) แล้วแสดงโมเดลเอง ใช้ได้เฉพาะรูปที่ผู้ใช้ขอให้แปลงเท่านั้น ห้ามใช้กับไฟล์อื่น พูดบอกสั้น ๆ ว่ากำลังแปลงและอาจรอหลายนาที
- \`\`\`jarvis-result JSON — ผลลัพธ์ที่ต้องดูบนจอใหญ่ (Result Viewer): {"type": "search"|"news"|"youtube"|"images"|"web"|"weather"|"table"|"chart"|"text"|"map"|"model", "title": string, "spokenSummary": "สรุป 1–3 ประโยคที่จะพูด", ...ฟิลด์ตามชนิด}
  search: "items": [{"title","url","site"?,"snippet"}] และ "summary"?: {"text": "สรุป 3–5 บรรทัด อ้างอิง [1] [2] ตามลำดับ items"}
  news: "items": [{"title","url","source","publishedAt": ISO 8601,"summary","image"?: URL รูปข่าว}] ทุกข่าวต้องมี source และ publishedAt ข่าวเด่นสุดไว้ลำดับแรก
  web: เปิดหน้าเว็บจริงบนจอพร้อมสรุปโดยแอป ใช้เมื่อผู้ใช้ขอเปิด/ดูเว็บไซต์หรือหน้าใดหน้าหนึ่ง หรือคำตอบอยู่ในหน้าเว็บหน้าเดียว: "url" และ "question"?: คำถามของผู้ใช้ที่หน้านี้ควรตอบ (แอปจะอ่านหน้าและสรุปเอง ไม่ต้องสรุปซ้ำใน spokenSummary — เว้น spokenSummary ได้)
  youtube: "items": [{"videoId": รหัส 11 ตัวจาก youtube.com/watch?v=…,"title","channel","views"?,"duration"?,"publishedAt"?}] ลำดับแรกคือคลิปที่จะเล่น ที่เหลือ 3–5 รายการเป็น Up next
  images: "items": [{"image": URL ของรูปโดยตรง,"title","url": หน้าต้นทาง}] · map: "lat","lon","zoom"?,"location"?,"view3d"?: true เมื่อผู้ใช้ขอดูแบบ 3D (ตึก/ภูเขา, ใช้ภาพดาวเทียมสีจริงอัตโนมัติ),"satellite"?: boolean,"earth"?: true เมื่อผู้ใช้ขอแบบ Google Earth (ภาพถ่าย 3D สมจริง),"streetview"?: true เมื่อขอดูภาพถนนจริง / Street View / เดินดูถนน (ไม่ต้องใช้ key)
  weather: "location","lat"?,"lon"? (ใส่พิกัดเพื่อแสดงเรดาร์ฝนบนแผนที่),"current": {"temp","condition","feelsLike"?,"humidity"?,"wind"?,"high"?,"low"?},"hourly": [{"time":"14:00","temp","condition"?,"rain"?: %}]
  model: โมเดล 3D หมุนดูรอบได้ ใช้เมื่อผู้ใช้ขอดูดีไซน์/ชิ้นงานเป็น 3D: "parts": [{"shape":"box"|"cylinder"|"cone"|"sphere"|"torus"|"capsule"|"extrude","color":"#rrggbb","position":[x,y,z],"rotation":[องศา x,y,z],"metalness"?:0-1,"roughness"?:0-1,"opacity"?:0-1,"emissive"?:"#rrggbb"} บวก box: "size":[กว้าง,สูง,ลึก],"radius"?: มุมมน · cylinder: "radius","radiusTop"?,"height" · cone: "radius","height" · sphere: "radius" · torus: "radius","tube" · capsule: "radius","length" · extrude: "points":[[x,y]…] เส้นรอบรูปปิด,"holes"?:[{"cx","cy","r"} หรือ [[x,y]…]],"depth","bevel"?] แกน Y ชี้ขึ้น ขนาดรวมประมาณ 1–10 หน่วย,"autoRotate"?: boolean
  table: "columns": [string],"rows": [[ค่า]] · chart: "labels": [string],"series": [{"name","values": [number]}],"unit"? · text: "markdown": คำตอบยาว
  ใช้ข้อมูลจริงจากเครื่องมือ (WebSearch / WebFetch) เท่านั้น ห้ามแต่ง URL, videoId หรือรูป ถ้าไม่มีให้เว้นฟิลด์นั้น
บล็อกต้องเป็น JSON ที่ถูกต้อง (ยกเว้น arduino/scad) และปิดด้วย \`\`\` บรรทัดของตัวเอง ข้อความในบล็อกจะไม่ถูกอ่านออกเสียง
`.trim();

module.exports = { SCHEMAS, CODE_KINDS, PROTOCOL_DOC };
