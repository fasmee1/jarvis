'use strict';
// Real usage: token counts from transcripts (deduplicated, incremental) and the
// limit windows from Claude Code's rate_limit_event.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanAll, totals, shortModel } = require('../lib/usage/scan');
const { UsageService, normalizeLimits, startOfWeek } = require('../lib/usage/service');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-usage-'));
const line = (o) => JSON.stringify(o) + '\n';
const reply = (id, ts, usage, model = 'claude-opus-5-5-20261001', extra = {}) =>
  line({ type: 'assistant', timestamp: new Date(ts).toISOString(), requestId: `req_${id}`, message: { id, model, usage, content: [] }, ...extra });

test('scan: one reply counted once (last line wins), synthetic skipped, subagents included, forks deduped', () => {
  const base = tmp();
  const now = Date.now();
  const p = path.join(base, 'D--proj');
  fs.mkdirSync(path.join(p, 'sess', 'subagents'), { recursive: true });
  const u = (i, o) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 });
  fs.writeFileSync(path.join(p, 'a.jsonl'),
    line({ type: 'user', message: { content: 'hi' } }) +
    reply('m1', now - 1000, u(5, 1)) + reply('m1', now - 1000, u(5, 40)) + // streamed in two lines
    reply('m2', now - 500, u(3, 10), '<synthetic>'));
  fs.writeFileSync(path.join(p, 'sess', 'subagents', 'agent-1.jsonl'), reply('m3', now - 200, u(1, 2), 'claude-haiku-5-5'));
  fs.writeFileSync(path.join(p, 'fork.jsonl'), reply('m1', now - 1000, u(5, 40))); // a resumed copy
  const r = scanAll(base, undefined, now);
  const t = totals(r.entries, { all: 0 }).all;
  assert.strictEqual(t.requests, 2);
  assert.strictEqual(t.output, 42);
  assert.strictEqual(t.input, 6);
  assert.strictEqual(t.cacheRead, 2000);
  assert.strictEqual(t.total, 6 + 42 + 200 + 2000);
  assert.deepStrictEqual(Object.keys(t.byModel).sort(), ['Haiku 5.5', 'Opus 5.5']);

  // incremental: only new lines are read; a half-written last line waits
  fs.appendFileSync(path.join(p, 'a.jsonl'), reply('m4', now - 100, u(7, 7)) + '{"type":"assist');
  const r2 = scanAll(base, r.cache, now);
  assert.strictEqual(totals(r2.entries, { all: 0 }).all.requests, 3);
});

test('totals per window', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const e = (ago, n) => [now - ago, n, 0, 0, 0, 'claude-sonnet-5-5', `k${ago}`];
  const t = totals([e(1000, 1), e(3 * 3600e3, 10), e(3 * 86400e3, 100)], { h1: now - 3600e3, d1: now - 86400e3, d7: now - 7 * 86400e3 });
  assert.strictEqual(t.h1.total, 1);
  assert.strictEqual(t.d1.total, 11);
  assert.strictEqual(t.d7.total, 111);
});

test('shortModel and start of week (Monday)', () => {
  assert.strictEqual(shortModel('claude-opus-5-5-20261001'), 'Opus 5.5');
  assert.strictEqual(shortModel('claude-haiku-5-5'), 'Haiku 5.5');
  assert.strictEqual(new Date(startOfWeek(new Date(2026, 9, 20, 15).getTime())).getDay(), 1); // Tue → Mon
  assert.strictEqual(new Date(startOfWeek(new Date(2026, 9, 25, 9).getTime())).getDate(), 19); // Sun → Mon 19th
});

test('limits: from rate_limit_event, saved, windows follow the reset times, expired windows drop their %', () => {
  const info = { status: 'allowed', resetsAt: 1792448400, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1792448400 }, seven_day: { utilization: 0.42, resetsAt: 1792879200 } } };
  const l = normalizeLimits(info, 1);
  assert.deepStrictEqual(l.fiveHour, { utilization: 0.08, resetsAt: 1792448400000 });
  assert.deepStrictEqual(l.sevenDay, { utilization: 0.42, resetsAt: 1792879200000 });
  assert.deepStrictEqual(normalizeLimits({ status: 'allowed', resetsAt: 10, rateLimitType: 'seven_day', utilization: 0.5 }).sevenDay, { utilization: 0.5, resetsAt: 10000 });

  const dir = tmp();
  const s = new UsageService({ dataDir: dir, base: tmp() });
  const seen = [];
  s.o.onChange = (x) => seen.push(x);
  s.onRateLimit(info);
  assert.strictEqual(seen.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'usage-limits.json')));
  const again = new UsageService({ dataDir: dir, base: tmp() });
  assert.strictEqual(again.limits.sevenDay.utilization, 0.42);

  const before = 1792448400000 - 3600e3;
  const w = again.windows(before);
  assert.strictEqual(w.fiveHour, 1792448400000 - 5 * 3600e3);
  assert.strictEqual(w.sevenDay, 1792879200000 - 7 * 86400e3);
  const after = again.snapshot(1792448400000 + 1);
  assert.strictEqual(after.limits.fiveHour.utilization, null);
  assert.strictEqual(after.limits.fiveHour.expired, true);
  assert.strictEqual(after.limits.sevenDay.utilization, 0.42);
  s.onRateLimit({ status: 'allowed' }); // nothing usable: ignored
  assert.strictEqual(seen.length, 1);
});

test('service.refresh runs the scan in a worker', async () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, 'p'));
  fs.writeFileSync(path.join(base, 'p', 'x.jsonl'), reply('z', Date.now() - 1000, { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));
  const s = new UsageService({ dataDir: tmp(), base });
  const snap = await s.refresh();
  assert.strictEqual(snap.tokens.today.total, 3);
  assert.ok(snap.scannedAt);
});
