'use strict';
// Ready-made moving stickers the app draws itself (no download, no licence question):
// a pointing arrow, a circle that draws around something, an underline, a floating heart, sparkles.
// Each is an SVG drawn on a 100×100 board. The same markup is used by the render page
// (lib/video/hf-project.js, animated by GSAP) and by the editor's live preview (through IPC).

const KINDS = Object.freeze({
  arrow: { id: 'arrow', label: 'ลูกศรชี้เด้ง', color: '#ffe14d', draw: false },
  circle: { id: 'circle', label: 'วงกลมเน้นจุด', color: '#ff4d6d', draw: true },
  underline: { id: 'underline', label: 'ขีดเส้นใต้', color: '#ffe14d', draw: true },
  heart: { id: 'heart', label: 'หัวใจลอย', color: '#ff4d6d', draw: false },
  sparkle: { id: 'sparkle', label: 'ประกายระยิบ', color: '#ffe14d', draw: false },
});

const POSITIONS = Object.freeze({
  'top-left': { label: 'บนซ้าย', x: 20, y: 20 },
  'top-center': { label: 'บนกลาง', x: 50, y: 20 },
  'top-right': { label: 'บนขวา', x: 80, y: 20 },
  center: { label: 'กลางจอ', x: 50, y: 50 },
  'bottom-left': { label: 'ล่างซ้าย', x: 20, y: 75 },
  'bottom-center': { label: 'ล่างกลาง', x: 50, y: 75 },
  'bottom-right': { label: 'ล่างขวา', x: 80, y: 75 },
});

const HEX = /^#[0-9a-fA-F]{6}$/;
const isSticker = (kind) => Object.prototype.hasOwnProperty.call(KINDS, kind);
const star = 'M50 4 L58 42 L96 50 L58 58 L50 96 L42 58 L4 50 L42 42 Z';

/** The SVG markup of a sticker in `color` (a #rrggbb, else the sticker's own colour). */
function svgFor(kind, color) {
  if (!isSticker(kind)) throw new Error('ไม่รู้จักสติกเกอร์นี้');
  const c = HEX.test(String(color)) ? String(color) : KINDS[kind].color;
  const open = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">';
  const body = {
    arrow: `<path d="M50 10 L50 62 M26 40 L50 68 L74 40" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="19" stroke-linecap="round" stroke-linejoin="round"/><path d="M50 10 L50 62 M26 40 L50 68 L74 40" fill="none" stroke="${c}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`,
    circle: `<path pathLength="1" d="M50 12 C78 12 94 30 92 52 C90 76 66 90 40 88 C16 86 6 66 10 46 C14 26 34 14 62 16" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/>`,
    underline: `<path pathLength="1" d="M5 62 C28 40 58 80 95 48" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round"/>`,
    heart: `<path d="M50 90 C18 63 6 45 6 31 C6 17 17 9 29 9 C39 9 46 15 50 23 C54 15 61 9 71 9 C83 9 94 17 94 31 C94 45 82 63 50 90 Z" fill="${c}" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>`,
    sparkle: `<g transform="translate(19 19) scale(.62)"><path class="st st0" d="${star}" fill="${c}"/></g><g transform="translate(52 6) scale(.3)"><path class="st st1" d="${star}" fill="${c}"/></g><g transform="translate(6 58) scale(.26)"><path class="st st2" d="${star}" fill="${c}"/></g>`,
  }[kind];
  return `${open}${body}</svg>`;
}

/** { x, y } in percent of the picture for a named place; the centre for an unknown name. */
function place(name) {
  return POSITIONS[name] || POSITIONS.center;
}

module.exports = { KINDS, POSITIONS, isSticker, svgFor, place, HEX };
