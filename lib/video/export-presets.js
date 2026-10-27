'use strict';
// Where the finished video is going: picture size, and how long that place likes a clip.
// Pure data and checks, shared by the main process and (through IPC) the editor page.

const PRESETS = Object.freeze({
  tiktok: { id: 'tiktok', label: 'TikTok', width: 1080, height: 1920, fps: 30, maxSec: 600, tipSec: 60, note: 'แนวตั้ง 9:16' },
  reels: { id: 'reels', label: 'Instagram Reels', width: 1080, height: 1920, fps: 30, maxSec: 180, tipSec: 90, note: 'แนวตั้ง 9:16' },
  shorts: { id: 'shorts', label: 'YouTube Shorts', width: 1080, height: 1920, fps: 30, maxSec: 180, tipSec: 60, note: 'แนวตั้ง 9:16' },
  youtube: { id: 'youtube', label: 'YouTube (แนวนอน)', width: 1920, height: 1080, fps: 30, maxSec: 0, tipSec: 0, note: 'แนวนอน 16:9' },
  feed45: { id: 'feed45', label: 'Instagram ฟีด 4:5', width: 1080, height: 1350, fps: 30, maxSec: 180, tipSec: 60, note: 'สูงนิดหน่อย 4:5' },
  square: { id: 'square', label: 'สี่เหลี่ยม 1:1', width: 1080, height: 1080, fps: 30, maxSec: 180, tipSec: 60, note: 'จัตุรัส 1:1' },
});

const FITS = Object.freeze({ cover: 'เต็มจอ (ตัดขอบภาพที่เกิน)', contain: 'เห็นทั้งภาพ (มีขอบดำ)' });

function preset(id) {
  const p = PRESETS[id];
  if (!p) throw new Error('ไม่รู้จักปลายทางนี้');
  return p;
}

/** A Thai warning when the clip is longer than the place allows or likes; '' when it is fine. */
function lengthNote(p, seconds) {
  if (p.maxSec && seconds > p.maxSec) return `ยาว ${fmt(seconds)} เกินที่ ${p.label} รับได้ (สูงสุด ${fmt(p.maxSec)}) — ตัดให้สั้นลงก่อน`;
  if (p.tipSec && seconds > p.tipSec) return `ยาว ${fmt(seconds)} — ${p.label} ที่ได้คนดูจนจบมักไม่เกิน ${fmt(p.tipSec)}`;
  return '';
}

function fmt(sec) {
  const s = Math.round(sec);
  return s >= 60 ? `${Math.floor(s / 60)} นาที${s % 60 ? ` ${s % 60} วินาที` : ''}` : `${s} วินาที`;
}

/** "my-clip" + tiktok → "my-clip-tiktok.mp4" (safe file name: no path characters) */
function suggestName(base, p) {
  const clean = String(base || 'clip').replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 60) || 'clip';
  return `${clean}-${p.id}.mp4`;
}

module.exports = { PRESETS, FITS, preset, lengthNote, suggestName };
