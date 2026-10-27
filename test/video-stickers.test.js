'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/video/edit-list');
const stk = require('../lib/video/stickers');
const { buildProject } = require('../lib/video/hf-project');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not near ${b}`);
const base = () => E.addClip(E.emptyList([{ id: 's1', path: 'x', duration: 30 }]), { src: 's1', in: 0, out: 20 });

test('stickers: markup is plain SVG in the chosen colour; a bad colour falls back; places are named', () => {
  for (const k of Object.keys(stk.KINDS)) {
    const svg = stk.svgFor(k);
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), k);
    assert.ok(!/<script|on\w+=|href=|<image|<foreignObject/i.test(svg), `${k} has nothing active in it`);
    assert.ok(svg.includes(stk.KINDS[k].color), k);
  }
  assert.ok(stk.svgFor('circle', '#00ff00').includes('#00ff00'));
  assert.ok(stk.svgFor('circle', 'red" onload="x').includes(stk.KINDS.circle.color), 'only #rrggbb is accepted');
  assert.ok(stk.svgFor('circle', '"><script>').indexOf('<script') < 0);
  assert.throws(() => stk.svgFor('skull'), /ไม่รู้จัก/);
  assert.deepStrictEqual(stk.place('top-right'), stk.POSITIONS['top-right']);
  assert.deepStrictEqual(stk.place('nowhere'), stk.POSITIONS.center);
  assert.strictEqual(stk.isSticker('__proto__'), false);
});

test('stickers: in the edit list they need no text, have a place, a size and a colour, all checked', () => {
  let list = base();
  list = E.applyOp(list, { op: 'overlay-add', overlay: { kind: 'heart', start: 1, end: 3 } });
  assert.deepStrictEqual([list.overlays[0].x, list.overlays[0].y, list.overlays[0].size, list.overlays[0].color, list.overlays[0].text], [50, 50, 20, '#ff4d6d', '']);
  list = E.applyOp(list, { op: 'overlay-add', overlay: { kind: 'arrow', text: 'ignored', x: 20, y: 75, size: 12.34, color: '#00E5FF', start: 2, end: 5 } });
  assert.deepStrictEqual([list.overlays[1].x, list.overlays[1].y, list.overlays[1].size, list.overlays[1].color, list.overlays[1].text], [20, 75, 12.3, '#00e5ff', '']);
  list = E.applyOp(list, { op: 'overlay-update', id: 'o2', overlay: { x: 80 } });
  assert.strictEqual(list.overlays[1].x, 80);
  assert.strictEqual(list.overlays[1].color, '#00e5ff', 'untouched fields stay');
  const bad = (o) => () => E.applyOp(list, { op: 'overlay-add', overlay: { kind: 'circle', start: 0, end: 2, ...o } });
  assert.throws(bad({ x: -1 }), /ตำแหน่งสติกเกอร์/);
  assert.throws(bad({ y: 101 }), /ตำแหน่งสติกเกอร์/);
  assert.throws(bad({ x: NaN }), /ตำแหน่งสติกเกอร์/);
  assert.throws(bad({ size: 2 }), /ขนาดสติกเกอร์/);
  assert.throws(bad({ size: 91 }), /ขนาดสติกเกอร์/);
  assert.throws(bad({ color: 'red' }), /สีสติกเกอร์/);
  assert.throws(bad({ color: '#12345' }), /สีสติกเกอร์/);
  assert.throws(bad({ end: 0.3 }), /อย่างน้อย 0\.5/);
  // a title still needs words, and carries no sticker fields
  assert.throws(() => E.applyOp(list, { op: 'overlay-add', overlay: { kind: 'title', text: ' ', start: 0, end: 2 } }), /ว่างไม่ได้/);
  assert.strictEqual('x' in E.applyOp(list, { op: 'overlay-add', overlay: { kind: 'title', text: 'a', start: 0, end: 2 } }).overlays[2], false);
});

test('stickers: the render page places, sizes and animates each one; colours cannot break out', () => {
  let list = base();
  const kinds = ['arrow', 'circle', 'underline', 'heart', 'sparkle'];
  kinds.forEach((kind, i) => { list = E.addOverlay(list, { kind, start: i * 3, end: i * 3 + 2.4, x: 30, y: 40, size: 25, color: i === 1 ? '#00ffaa' : undefined }); });
  const { html } = buildProject({ clips: list.clips, overlays: list.overlays, sources: { s1: { file: 'assets/s1.mp4', kind: 'video', audio: true } }, canvas: { width: 1080, height: 1920 } });
  assert.match(html, /<div id="ov-0" class="clip ov-sticker" data-start="0" data-duration="2.4" data-track-index="12" style="left:30%;top:40%;width:270px;height:270px;margin:-135px 0 0 -135px"><svg/);
  assert.match(html, /<div id="ov-1" class="clip ov-sticker stk-draw"/, 'line stickers get the draw style');
  assert.match(html, /stroke="#00ffaa"/);
  assert.match(html, /tl\.fromTo\("#ov-0", \{ opacity: 0, y: -189 \}, \{ opacity: 1, y: 0, duration: 0\.45, ease: "bounce\.out" \}, 0\);/);
  assert.match(html, /tl\.fromTo\("#ov-1 path", \{ strokeDashoffset: 1 \}, \{ strokeDashoffset: 0, duration: 0\.6/);
  assert.match(html, /tl\.fromTo\("#ov-3", \{ scale: 0 \}, \{ scale: 1, duration: 0\.4, ease: "back\.out\(2\.4\)" \}, 9\);/);
  assert.match(html, /"#ov-4 \.st", \{ scale: 0, rotation: -45 \}/);
  assert.match(html, /\.stk-draw path \{ stroke-dasharray: 1;/);
  assert.ok(!/<script>[^]*<script>/.test(html.replace(/<script src=[^>]*><\/script>/, '')), 'only the one inline script of the page');
});

test('stickers: the preview math matches the render tweens', async () => {
  const p = await import('../renderer/ui/video-preview.js');
  const mk = (kind, extra = {}) => ({ kind, start: 10, end: 13, x: 50, y: 50, size: 20, color: '#fff', ...extra });
  assert.strictEqual(p.stickerState(mk('heart'), 9.9), null);
  assert.strictEqual(p.stickerState(mk('heart'), 13.1), null);
  const w = 216; // 20% of 1080
  near(p.stickerState(mk('arrow'), 10).y, -0.7 * w);
  near(p.stickerState(mk('arrow'), 10.45).y, 0);
  assert.ok(Math.abs(p.stickerState(mk('arrow'), 10.7).y) > 1, 'bobbing after it landed');
  near(p.stickerState(mk('circle'), 10).draw, 0);
  near(p.stickerState(mk('circle'), 10.6).draw, 1);
  near(p.stickerState(mk('underline'), 10.5).draw, 1);
  assert.strictEqual(p.stickerState(mk('heart'), 10.4).scale, 1);
  assert.ok(p.stickerState(mk('heart'), 12.9).y < -w, 'the heart floats up');
  assert.ok(p.stickerState(mk('heart'), 12.9).opacity < 0.3);
  near(p.stickerState(mk('sparkle'), 10).stars[0].scale, 0);
  near(p.stickerState(mk('sparkle'), 10.6).stars[2].scale, 1);
  assert.strictEqual(p.stickerState(mk('sparkle'), 10.6).stars.length, 3);
  near(p.stickerState(mk('circle'), 12.99).opacity, 0.04, 0.05);
  near(p.bounceOut(0), 0);
  near(p.bounceOut(1), 1);
  assert.deepStrictEqual(p.STICKER_KINDS.sort(), Object.keys(stk.KINDS).sort(), 'the same sticker kinds as the app draws');
  assert.deepStrictEqual(Object.keys(p.STICKER_DRAW).sort(), Object.keys(stk.KINDS).filter((k) => stk.KINDS[k].draw).sort());
});
