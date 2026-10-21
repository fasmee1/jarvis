'use strict';
// Screen watching: change detection, window matching, and the watcher lifecycle (fake clock, fake grabber).
const test = require('node:test');
const assert = require('node:assert');
const { ScreenWatcher, matchWindows, grayThumb, changed, THUMB_W, THUMB_H } = require('../lib/screen-watch');

const CELLS = THUMB_W * THUMB_H;
const flat = (v) => new Uint8Array(CELLS).fill(v);
const withPatch = (base, n, v) => { const t = Uint8Array.from(base); for (let i = 0; i < n; i++) t[i] = v; return t; };

test('grayThumb turns BGRA into brightness cells', () => {
  const bgra = new Uint8Array(CELLS * 4).fill(255);
  const g = grayThumb(bgra);
  assert.strictEqual(g.length, CELLS);
  assert.ok(g.every((x) => x >= 253));
});

test('changed: a blinking cursor is not a change, a new block of text is', () => {
  const base = flat(40);
  assert.strictEqual(changed(base, withPatch(base, 3, 255)), false); // under 2% of the cells
  assert.strictEqual(changed(base, withPatch(base, 40, 255)), true);
  assert.strictEqual(changed(base, withPatch(base, 200, 50)), false); // tiny brightness drift
  assert.strictEqual(changed(null, base), true);
});

test('matchWindows: spoken kinds and words', () => {
  const wins = [
    { id: 'w:1', name: 'Windows PowerShell' },
    { id: 'w:2', name: 'D:\\mee-jarvis - Visual Studio Code' },
    { id: 'w:3', name: 'Inbox - Google Chrome' },
    { id: 'w:4', name: 'Terminal - bash' },
    { id: 'w:5', name: 'Arduino IDE 2.3' },
  ];
  assert.deepStrictEqual(matchWindows(wins, 'terminal').map((w) => w.id), ['w:1', 'w:4']);
  assert.deepStrictEqual(matchWindows(wins, 'browser').map((w) => w.id), ['w:3']);
  assert.deepStrictEqual(matchWindows(wins, 'editor').map((w) => w.id), ['w:2']);
  assert.deepStrictEqual(matchWindows(wins, 'arduino ide').map((w) => w.id), ['w:5']);
  assert.deepStrictEqual(matchWindows(wins, 'nothing here'), []);
  assert.deepStrictEqual(matchWindows(wins, ''), []);
});

function rig({ maxMs = 60000, intervalMs = 1000 } = {}) {
  const r = { t: 0, timers: [], states: [], frames: [], fail: 0 };
  r.watcher = new ScreenWatcher({
    now: () => r.t,
    setTimer: (fn, ms) => { const h = { fn, at: r.t + ms }; r.timers.push(h); return h; },
    clearTimer: (h) => { r.timers = r.timers.filter((x) => x !== h); },
    onState: (s) => r.states.push(s),
    grab: async () => {
      if (r.fail) { r.fail--; throw new Error('boom'); }
      const f = r.frames.shift();
      if (!f) throw new Error('no frame');
      return f;
    },
  });
  r.start = (target = { kind: 'screen', name: 'ทั้งหน้าจอ' }) => r.watcher.start(target, { intervalMs, maxMs });
  r.tick = async (ms = intervalMs) => {
    r.t += ms;
    const due = r.timers.filter((h) => h.at <= r.t);
    r.timers = r.timers.filter((h) => h.at > r.t);
    for (const h of due) await h.fn();
  };
  return r;
}
const frame = (name, thumb) => ({ dataUrl: 'data:image/jpeg;base64,' + name, thumb });

test('watching keeps only frames that changed; latest() serves the newest one', async () => {
  const r = rig();
  r.frames = [frame('a', flat(10)), frame('same', flat(10)), frame('b', flat(200))];
  const st = await r.start();
  assert.strictEqual(st.on, true);
  assert.ok(r.watcher.latest().dataUrl.endsWith('a'));
  await r.tick();
  assert.ok(r.watcher.latest().dataUrl.endsWith('a'), 'an unchanged frame is not stored');
  await r.tick();
  assert.ok(r.watcher.latest().dataUrl.endsWith('b'));
});

test('latest() is null once checks stop arriving (stale) and after stop()', async () => {
  const r = rig();
  r.frames = [frame('a', flat(10))];
  await r.start();
  r.t += 10000; // no tick ran: the picture may be out of date
  assert.strictEqual(r.watcher.latest(), null);
  r.t = 0;
  assert.ok(r.watcher.latest());
  r.watcher.stop();
  assert.strictEqual(r.watcher.latest(), null);
  assert.strictEqual(r.watcher.state.on, false);
});

test('watching ends by itself at the time limit', async () => {
  const r = rig({ maxMs: 3000 });
  r.frames = [frame('a', flat(1)), frame('b', flat(100)), frame('c', flat(200)), frame('d', flat(1))];
  await r.start();
  await r.tick();
  await r.tick();
  await r.tick();
  const last = r.states[r.states.length - 1];
  assert.strictEqual(last.on, false);
  assert.strictEqual(last.reason, 'timeout');
  assert.strictEqual(r.watcher.latest(), null);
  assert.strictEqual(r.timers.length, 0);
});

test('three failed checks in a row stop watching; a failing first check rejects start()', async () => {
  const r = rig();
  r.fail = 1;
  await assert.rejects(r.start(), /boom/);
  assert.strictEqual(r.watcher.state.on, false);

  const r2 = rig();
  r2.frames = [frame('a', flat(10))];
  await r2.start();
  r2.fail = 5;
  await r2.tick();
  await r2.tick();
  assert.strictEqual(r2.watcher.state.on, true);
  await r2.tick();
  const last = r2.states[r2.states.length - 1];
  assert.deepStrictEqual([last.on, last.reason], [false, 'error']);
});

test('restart replaces the old target without reporting a stop; stop is idempotent', async () => {
  const r = rig();
  r.frames = [frame('a', flat(10)), frame('w', flat(90))];
  await r.start();
  await r.start({ kind: 'window', id: 'w:1', name: 'Windows PowerShell' });
  assert.strictEqual(r.watcher.state.target.name, 'Windows PowerShell');
  assert.ok(r.states.every((s) => s.on), 'no "stopped" state in between');
  assert.strictEqual(r.watcher.stop(), true);
  assert.strictEqual(r.watcher.stop(), false);
});
