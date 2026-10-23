'use strict';
// Finds and downloads a real, downloadable 3D model from Sketchfab (Data API v3) so the
// Result Viewer can show it as glTF. The token stays in the main process; the renderer only
// ever sees an app://jarvis/models/<uid>/… URL of a file extracted under userData/models.
// Sketchfab's download API hands back a temporary link to a ZIP (scene.gltf + scene.bin + textures/).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const API = 'https://api.sketchfab.com/v3';
const MAX_ZIP_BYTES = 150 * 1024 * 1024;
const UID = /^[0-9a-f]{32}$/i;

class SketchfabError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class Sketchfab {
  /** getToken: () => string. modelsDir: where extracted models live (served as app://jarvis/models/). */
  constructor({ getToken, modelsDir, fetchFn = fetch, extract = extractZip }) {
    this.getToken = getToken;
    this.modelsDir = modelsDir;
    this.fetch = fetchFn;
    this.extract = extract;
  }

  async _api(url, token, scheme) {
    return this.fetch(url, { headers: { Authorization: `${scheme} ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  }

  /** Same call with the "Token" scheme (personal API token), falling back to "Bearer" (OAuth). */
  async _authed(url) {
    const token = this.getToken();
    if (!token) throw new SketchfabError('ยังไม่ได้ใส่ Sketchfab API token ในหน้าตั้งค่า', 'NO_TOKEN');
    let res = await this._api(url, token, 'Token');
    if (res.status === 401 || res.status === 403) res = await this._api(url, token, 'Bearer');
    if (res.status === 401 || res.status === 403) throw new SketchfabError('Sketchfab ไม่ยอมรับ token นี้ (หรือบัญชีนี้ดาวน์โหลดไม่ได้)');
    if (res.status === 429) throw new SketchfabError('Sketchfab จำกัดจำนวนคำขอ ลองใหม่ภายหลัง');
    if (!res.ok) throw new SketchfabError(`Sketchfab ตอบ ${res.status}`);
    return res.json();
  }

  async search(query, count = 8) {
    const q = String(query || '').trim().slice(0, 120);
    if (!q) throw new SketchfabError('ไม่มีคำค้นหาโมเดล');
    // default relevance order; ask for more than we need so weak matches can be dropped
    const url = `${API}/search?type=models&downloadable=true&q=${encodeURIComponent(q)}&count=${Math.max(count, 24)}`;
    const data = await this._authed(url);
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    const tagsOf = (m) => (Array.isArray(m.tags) ? m.tags.map((t) => String((t && (t.name || t.slug)) || t).toLowerCase()).join(' ') : '');
    const scored = (Array.isArray(data.results) ? data.results : [])
      .filter((m) => m && UID.test(m.uid || '') && m.isDownloadable !== false)
      .map((m) => {
        const name = String(m.name || '').toLowerCase();
        const tags = tagsOf(m);
        const inName = words.filter((w) => name.includes(w)).length;
        const inTags = words.filter((w) => tags.includes(w)).length;
        // a title word counts double a tag word; a hit needs a title word or every query word in its tags
        return { m, score: inName * 2 + inTags, related: inName > 0 || inTags === words.length };
      })
      .filter((x) => !words.length || x.related)
      .sort((a, b) => b.score - a.score); // stable: ties keep Sketchfab's relevance order
    return scored.slice(0, count).map(({ m }) => ({
      uid: m.uid,
      name: String(m.name || 'โมเดล 3D').slice(0, 120),
      author: String((m.user && (m.user.displayName || m.user.username)) || 'ไม่ทราบชื่อ').slice(0, 80),
      license: String((m.license && (m.license.label || m.license.slug)) || '').slice(0, 60),
      url: typeof m.viewerUrl === 'string' && m.viewerUrl.startsWith('https://sketchfab.com/') ? m.viewerUrl : `https://sketchfab.com/3d-models/${m.uid}`,
    }));
  }

  /** Downloads + extracts one model; resolves to its entry file relative to modelsDir, e.g. "<uid>/scene.gltf". */
  async download(uid) {
    if (!UID.test(uid || '')) throw new SketchfabError('รหัสโมเดลไม่ถูกต้อง');
    const entry = path.join(uid, 'scene.gltf');
    if (fs.existsSync(path.join(this.modelsDir, entry))) return entry.split(path.sep).join('/'); // cached
    const info = await this._authed(`${API}/models/${uid}/download`);
    const g = info && info.gltf;
    if (!g || typeof g.url !== 'string' || !g.url.startsWith('https://')) throw new SketchfabError('โมเดลนี้ไม่มีไฟล์ glTF ให้ดาวน์โหลด');
    if (g.size > MAX_ZIP_BYTES) throw new SketchfabError('โมเดลนี้ไฟล์ใหญ่เกินไป');
    const res = await this.fetch(g.url, { signal: AbortSignal.timeout(180000) }); // the link carries its own signature: no auth header
    if (!res.ok) throw new SketchfabError(`ดาวน์โหลดโมเดลไม่สำเร็จ (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ZIP_BYTES) throw new SketchfabError('โมเดลนี้ไฟล์ใหญ่เกินไป');
    const dir = path.join(this.modelsDir, uid);
    const zip = path.join(this.modelsDir, `${uid}.zip`);
    fs.mkdirSync(this.modelsDir, { recursive: true });
    fs.writeFileSync(zip, buf);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      await this.extract(zip, dir);
      if (!fs.existsSync(path.join(dir, 'scene.gltf'))) throw new SketchfabError('ไฟล์ที่ได้ไม่มี scene.gltf');
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    } finally {
      fs.rmSync(zip, { force: true });
    }
    return entry.split(path.sep).join('/');
  }

  /** Search, take the first hit and download it. Resolves to the data of a "model" result. */
  async fetchModel(query) {
    const hits = await this.search(query);
    if (!hits.length) throw new SketchfabError(`ไม่พบโมเดลที่ดาวน์โหลดได้สำหรับ "${query}"`);
    let lastErr = null;
    for (const hit of hits.slice(0, 3)) { // a hit can fail to download (no glTF, too big): try the next
      try {
        const file = await this.download(hit.uid);
        return {
          type: 'model',
          title: hit.name,
          glb: `app://jarvis/models/${file}`,
          credit: `"${hit.name}" โดย ${hit.author}${hit.license ? ` (${hit.license})` : ''} — ${hit.url}`,
        };
      } catch (err) {
        lastErr = err;
        if (err instanceof SketchfabError && /token|จำกัด/.test(err.message)) throw err;
      }
    }
    throw lastErr;
  }
}

// Windows 10+ ships bsdtar as tar.exe, which reads ZIP and refuses entries that escape the target folder.
function extractZip(zip, dir) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', zip, '-C', dir], { windowsHide: true, timeout: 120000 }, (err) => {
      if (err) reject(new SketchfabError('แตกไฟล์โมเดลไม่สำเร็จ'));
      else resolve();
    });
  });
}

module.exports = { Sketchfab, SketchfabError };
