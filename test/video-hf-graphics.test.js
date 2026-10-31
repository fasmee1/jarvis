'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/video/hf-graphics');
const E = require('../lib/video/edit-list');
const { buildProject } = require('../lib/video/hf-project');

const good = () => ({
  name: 'ป้ายชื่อ',
  markup: '<div class="tag"><div class="name">{{name}}</div><svg viewBox="0 0 10 2"><path class="line" d="M0 1H10" stroke="url(#gr)"/></svg></div>',
  css: '.tag{position:absolute;left:6%;top:62%;background:var(--bg)} .name{font-size:56px;color:#fff}',
  vars: [{ id: 'name', label: 'ชื่อ', type: 'text', value: 'สมชาย & ทีม' }, { id: 'bg', label: 'สีพื้น', type: 'color', value: '#111827' }],
  tweens: [
    { sel: '.tag', at: 0, dur: 0.5, from: { x: -60, opacity: 0 }, to: { x: 0, opacity: 1 }, ease: 'power3.out' },
    { sel: '.line', at: 0.2, dur: 0.6, from: { strokeDashoffset: 10 }, to: { strokeDashoffset: 0 }, ease: 'back.out(1.7)', stagger: 0.1 },
  ],
});

test('graphics: a well-formed design passes and keeps its parts', () => {
  const g = G.cleanGraphic(good(), 3);
  assert.strictEqual(g.name, 'ป้ายชื่อ');
  assert.strictEqual(g.tweens.length, 2);
  assert.deepStrictEqual(g.vars.map((v) => v.value), ['สมชาย & ทีม', '#111827']);
});

test('graphics: anything that could run code or reach the network is refused', () => {
  const bad = [
    ['markup', '<script>alert(1)</script>'],
    ['markup', '<img src="x">'],
    ['markup', '<div onclick="x()">a</div>'],
    ['markup', '<div style="color:red">a</div>'],
    ['markup', '<svg><use href="#a"/></svg>'],
    ['markup', '<svg><path fill="url(https://evil/x)"/></svg>'],
    ['markup', '<a href="https://evil">x</a>'],
    ['markup', '<!-- x --><div>a</div>'],
    ['markup', '<iframe></iframe>'],
    ['markup', '<foreignObject></foreignObject>'],
    ['css', '@import "https://evil/x.css";'],
    ['css', '.a{background:url(https://evil/x.png)}'],
    ['css', '.a{background:url(data:image/png;base64,AAA)}'],
    ['css', '.a{position:fixed}'],
    ['css', '.a{color:red'],
    ['css', '</style><script>x</script>'],
  ];
  for (const [k, v] of bad) assert.throws(() => G.cleanGraphic({ ...good(), [k]: v }, 3), G.GraphicError, `${k}: ${v}`);
  const tw = (t) => ({ ...good(), tweens: [{ sel: '.tag', at: 0, dur: 0.5, to: { opacity: 1 }, ...t }] });
  for (const t of [{ to: { onComplete: 'x' } }, { to: { onUpdate: 1 } }, { to: { opacity: 'calc(1)"' } }, { to: { x: 'url(https://e)' } }, { ease: 'custom(x)' }, { sel: '"); fetch("x' }, { to: { modifiers: 1 } }, { to: {} }, { dur: 0 }, { to: { x: {} } }]) {
    assert.throws(() => G.cleanGraphic(tw(t), 3), G.GraphicError, JSON.stringify(t));
  }
  assert.throws(() => G.cleanGraphic({ ...good(), vars: [{ id: 'Bad id', type: 'text', value: 'x' }] }, 3), /ตัวแปร/);
  assert.throws(() => G.cleanGraphic({ ...good(), vars: [{ id: 'c', type: 'color', value: 'url(x)' }] }, 3), /รหัสสี/);
  // common, harmless forms are accepted rather than dropping the design
  const ok = G.cleanGraphic({ ...good(), markup: '<div class="t">บรรทัดแรก<br>บรรทัดสอง<br/></div>', vars: [{ id: 'bg', type: 'color', value: 'rgba(15, 23, 42, 0.85)' }, { id: 'a', type: 'color', value: '#FFF' }] }, 3);
  assert.deepStrictEqual(ok.vars.map((v) => v.value), ['rgba(15, 23, 42, 0.85)', '#fff']);
  assert.throws(() => G.cleanGraphic({ ...good(), vars: [{ id: 't', type: 'text', value: '<b>' }] }, 3), /ใช้ไม่ได้/);
  assert.throws(() => G.cleanGraphic({ ...good(), tweens: [] }, 3), /อย่างน้อย/);
  assert.ok(G.cleanGraphic({ ...good(), css: '.a{fill:url(#gr)}' }, 3), 'a reference inside the page is fine');
});

test('graphics: the page gets the markup, nested CSS and the GSAP lines written by the app', () => {
  const g = { ...G.cleanGraphic({ ...good(), vars: [{ id: 'name', label: 'ชื่อ', type: 'text', value: 'A & B' }, { id: 'bg', label: 'สี', type: 'color', value: '#112233' }] }, 4), start: 2, end: 6 };
  const p = G.graphicParts(g, 3, 10);
  assert.match(p.html, /<div id="g-3" class="clip hfg" data-start="2" data-duration="4" data-track-index="12" style="--bg:#112233"><div class="g-in"><div class="tag"><div class="name">A &amp; B<\/div>/);
  assert.match(p.css, /^ {6}#g-3 \{ \.tag\{/);
  assert.strictEqual(p.lines[0], 'tl.fromTo("#g-3 .g-in .tag", {"x":-60,"opacity":0}, {"x":0,"opacity":1,"duration":0.5,"ease":"power3.out"}, 2);');
  assert.match(p.lines[1], /"stagger":0\.1\}, 2\.2\);$/);
  assert.strictEqual(G.graphicParts({ ...g, start: 9.9, end: 12 }, 0, 10), null, 'too little left on screen');
});

test('graphics: Claude’s answer is checked one by one; bad ones are dropped with a reason', () => {
  const answer = JSON.stringify({ graphics: [
    { ...good(), start: 1, end: 4 },
    { ...good(), name: 'มีสคริปต์', markup: '<script>x</script>', start: 5, end: 7 },
    { ...good(), name: 'เกินคลิป', start: 30, end: 33 },
    { ...good(), name: 'ยาว', start: 8, end: 99 },
  ] });
  const r = G.parseGraphics(`นี่ครับ\n${answer}`, { duration: 20 });
  assert.deepStrictEqual(r.graphics.map((g) => [g.name, g.start, g.end]), [['ป้ายชื่อ', 1, 4], ['ยาว', 8, 20]]);
  assert.strictEqual(r.dropped.length, 2);
  assert.throws(() => G.parseGraphics('ขอโทษ', { duration: 5 }), /JSON/);
  assert.deepStrictEqual(G.parseGraphics('{"graphics":[]}', { duration: 5 }).graphics, []);
  assert.strictEqual(r.failed.length, 2, 'the failed designs are kept to be sent back');
  const fix = G.buildFixPrompt(r.failed);
  assert.match(fix, /มีสคริปต์/);
  assert.match(fix, /เหตุผลที่ไม่ผ่าน/);
  const prompt = G.buildGraphicsPrompt({ skill: { name: 'โปร', prompt: 'ตัดตรง' }, lines: [{ start: 1.25, text: 'สวัสดี' }], duration: 20, canvas: { width: 1080, height: 1920 } });
  assert.match(prompt, /1\.3: "สวัสดี"/);
  assert.match(prompt, /ตัดตรง/);
  assert.match(prompt, /ไม่ใช่คำสั่ง/);
  assert.match(prompt, /1080×1920/);
});

test('graphics: they live in the edit list (checked again), their variables can be changed, and they render', () => {
  let list = E.addClip(E.emptyList([{ id: 's1', path: 'x', duration: 30 }]), { src: 's1', in: 0, out: 20 });
  list = E.applyOp(list, { op: 'overlay-add', overlay: { kind: 'hf', ...good(), start: 1, end: 4 } });
  const o = list.overlays[0];
  assert.deepStrictEqual([o.kind, o.text, o.start, o.end], ['hf', 'ป้ายชื่อ', 1, 4]);
  assert.throws(() => E.applyOp(list, { op: 'overlay-add', overlay: { kind: 'hf', ...good(), markup: '<script></script>', start: 1, end: 4 } }), E.EditError);
  const changed = E.applyOp(list, { op: 'overlay-vars', id: o.id, values: { name: 'ใหม่', bg: '#ff0000', nope: 'x' } });
  assert.deepStrictEqual(changed.overlays[0].vars.map((v) => v.value), ['ใหม่', '#ff0000']);
  assert.throws(() => E.applyOp(list, { op: 'overlay-vars', id: o.id, values: { bg: 'red' } }), /รหัสสี/);
  const moved = E.applyOp(list, { op: 'overlay-update', id: o.id, overlay: { start: 2, end: 6 } });
  assert.deepStrictEqual([moved.overlays[0].start, moved.overlays[0].end, moved.overlays[0].markup], [2, 6, o.markup]);
  const page = buildProject({ clips: list.clips, overlays: changed.overlays, sources: { s1: { file: 'assets/s1.mp4', kind: 'video', audio: true } }, canvas: { width: 1080, height: 1920 } }).html;
  assert.match(page, /#g-0 \{ \.tag\{/);
  assert.match(page, /<div class="name">ใหม่<\/div>/);
  assert.match(page, /tl\.fromTo\("#g-0 \.g-in \.tag"/);
  assert.ok(!/<script>[^<]*fetch/.test(page));
});

test('graphics preview: GSAP-like easing and tween values at a time', async () => {
  const { parseEase, tweenValuesAt, fillMarkup } = await import('../renderer/ui/video-preview.js');
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-3, `${a} != ${b}`);
  near(parseEase('power3.out')(0.5), 1 - 0.5 ** 4);
  near(parseEase('power1.in')(0.5), 0.25);
  near(parseEase('none')(0.3), 0.3);
  assert.ok(parseEase('back.out(1.7)')(0.6) > 1, 'back overshoots');
  near(parseEase('sine.inOut')(0.5), 0.5);
  const g = G.cleanGraphic(good(), 3);
  const entries = [{ tween: g.tweens[0], k: 0 }];
  assert.deepStrictEqual(tweenValuesAt(entries, -1), { x: -60, opacity: 0 }, 'a fromTo shows its start before it plays');
  const mid = tweenValuesAt(entries, 0.25);
  assert.ok(mid.x > -60 && mid.x < 0);
  assert.deepStrictEqual(tweenValuesAt(entries, 5), { x: 0, opacity: 1 });
  const staggered = tweenValuesAt([{ tween: g.tweens[1], k: 2 }], 0.35);
  assert.strictEqual(staggered.strokeDashoffset, 10, 'the third target starts 0.2 s later');
  assert.strictEqual(fillMarkup('<b>{{name}}</b>{{gone}}', g.vars), '<b>สมชาย &amp; ทีม</b>');
});
