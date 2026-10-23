'use strict';
// Turns one picture into a textured GLB with a free Hugging Face Space (TRELLIS, Gradio API).
// The picture leaves this computer: callers must get the user's OK for that first.
// Output lands in userData/models/<id>/model.glb, which the app serves as app://jarvis/models/….

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SPACE = 'trellis-community/TRELLIS';
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_GLB_BYTES = 200 * 1024 * 1024;

class ImageTo3dError extends Error {}

class ImageTo3d {
  /** connect(space, opts) resolves to a @gradio/client-like { predict, close? }; handleFile(path) wraps a local file. */
  constructor({ modelsDir, connect, handleFile, fetchFn = fetch, space = SPACE }) {
    this.modelsDir = modelsDir;
    this.connect = connect || (async (s, o) => (await import('@gradio/client')).Client.connect(s, o));
    this.handleFile = handleFile || (async (p) => (await import('@gradio/client')).handle_file(p));
    this.fetch = fetchFn;
    this.space = space;
  }

  /** Checks a picture the user pointed at; returns its absolute path. */
  static checkImage(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new ImageTo3dError('ต้องระบุที่อยู่เต็มของรูป');
    if (!IMAGE_EXT.has(path.extname(file).toLowerCase())) throw new ImageTo3dError('รองรับเฉพาะรูป jpg png webp');
    let st;
    try { st = fs.statSync(file); } catch { throw new ImageTo3dError('ไม่พบไฟล์รูป'); }
    if (!st.isFile()) throw new ImageTo3dError('ไม่พบไฟล์รูป');
    if (st.size > MAX_IMAGE_BYTES) throw new ImageTo3dError('รูปใหญ่เกิน 10 MB');
    return path.resolve(file);
  }

  /** Resolves to the data of a "model" result. onStatus(text) is called as the job moves along. */
  async convert(file, { title, onStatus = () => {} } = {}) {
    const image = ImageTo3d.checkImage(file);
    onStatus('กำลังเชื่อมต่อ Hugging Face');
    const client = await this.connect(this.space, { token: process.env.HF_TOKEN || undefined });
    try {
      await client.predict('/start_session', {});
      onStatus('ตัดพื้นหลังรูป');
      const pre = await client.predict('/preprocess_image', { image: await this.handleFile(image) });
      const prepared = pre && pre.data && pre.data[0];
      if (!prepared) throw new ImageTo3dError('ตัดพื้นหลังไม่สำเร็จ');
      onStatus('กำลังสร้างโมเดล 3D (อาจรอคิวหลายนาที)');
      const res = await client.predict('/generate_and_extract_glb', {
        image: prepared,
        seed: 0,
        ss_guidance_strength: 7.5,
        ss_sampling_steps: 12,
        slat_guidance_strength: 3,
        slat_sampling_steps: 12,
        multiimage_algo: 'stochastic',
        mesh_simplify: 0.9, // keep more triangles than the default 0.95
        texture_size: 2048,
      });
      const out = (res && res.data && (res.data[2] || res.data[1])) || null;
      const url = out && (out.url || (out.path && /^https?:/.test(out.path) ? out.path : null));
      if (!url) throw new ImageTo3dError('บริการไม่ได้ส่งไฟล์ GLB กลับมา');
      onStatus('กำลังดาวน์โหลดโมเดล');
      const id = crypto.randomBytes(8).toString('hex');
      await this._save(url, id);
      return {
        type: 'model',
        title: title || path.basename(image, path.extname(image)),
        glb: `app://jarvis/models/${id}/model.glb`,
        credit: 'สร้างจากรูปด้วย TRELLIS (Microsoft, MIT) ผ่าน Hugging Face Space — ด้านหลังและรายละเอียดที่ไม่เห็นในรูปเป็นการคาดเดา',
      };
    } catch (err) {
      throw err instanceof ImageTo3dError ? err : new ImageTo3dError(friendly(err));
    } finally {
      try { if (client.close) client.close(); } catch { /* already closed */ }
    }
  }

  async _save(url, id) {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new ImageTo3dError(`ดาวน์โหลด GLB ไม่สำเร็จ (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_GLB_BYTES) throw new ImageTo3dError('ไฟล์โมเดลใหญ่เกินไป');
    if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'glTF') throw new ImageTo3dError('ไฟล์ที่ได้ไม่ใช่ GLB');
    const dir = path.join(this.modelsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model.glb'), buf);
  }
}

function friendly(err) {
  const msg = String((err && (err.message || err.detail)) || err || '');
  if (/quota|zerogpu|GPU/i.test(msg)) return 'โควตา GPU ฟรีของ Hugging Face หมดชั่วคราว ลองใหม่ภายหลัง';
  if (/queue|busy|timeout/i.test(msg)) return 'คิวของ Hugging Face เต็มหรือหมดเวลา ลองใหม่ภายหลัง';
  return `แปลงรูปเป็น 3D ไม่สำเร็จ (${msg.slice(0, 160)})`;
}

module.exports = { ImageTo3d, ImageTo3dError };
