'use strict';
// HTTPS download with redirects, progress, and atomic rename (.part -> final).

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

function download(url, dest, { onProgress, maxRedirects = 8, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + '.part';
    const go = (u, left) => {
      const req = https.get(u, { headers: { 'User-Agent': 'mee-jarvis', ...headers } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return reject(new Error('redirect มากเกินไป'));
          return go(new URL(res.headers.location, u).toString(), left - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`ดาวน์โหลดไม่สำเร็จ HTTP ${res.statusCode}: ${u}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        let lastEmit = 0;
        const out = fs.createWriteStream(part);
        res.on('data', (c) => {
          got += c.length;
          const now = Date.now();
          if (onProgress && now - lastEmit > 250) {
            lastEmit = now;
            onProgress({ received: got, total });
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            if (total && got !== total) return reject(new Error('ไฟล์ดาวน์โหลดไม่ครบ'));
            fs.renameSync(part, dest);
            if (onProgress) onProgress({ received: got, total: total || got, done: true });
            resolve(dest);
          });
        });
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('การเชื่อมต่อหมดเวลา')));
    };
    go(url, maxRedirects);
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'mee-jarvis', Accept: 'application/json' } }, (res) => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { s += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
}

/** Extract a .zip using Windows' built-in bsdtar (args array, no shell). */
function extractZip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'unzip';
  const args = process.platform === 'win32' ? ['-xf', zip, '-C', destDir] : ['-o', zip, '-d', destDir];
  return new Promise((resolve, reject) => {
    const p = spawn(tar, args, { shell: false, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`แตกไฟล์ไม่สำเร็จ: ${err.slice(0, 300)}`))));
  });
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const f = findFile(full, name);
      if (f) return f;
    }
  }
  return null;
}

module.exports = { download, getJson, extractZip, findFile };
