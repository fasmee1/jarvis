'use strict';
// Real Claude Code usage for the HUD / Diagnostics:
// - limits: the subscription windows (5-hour, weekly) with % used and reset time,
//   from the rate_limit_event Claude Code emits after each API response (read from
//   Anthropic's anthropic-ratelimit-unified-* headers). Saved, so they show after a restart.
// - tokens: counted from Claude Code's transcripts (lib/usage/scan.js), for today,
//   this week (Mon–Sun), and the current 5-hour / weekly limit windows.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { spawn } = require('child_process');

const H5 = 5 * 3600 * 1000;
const D7 = 7 * 24 * 3600 * 1000;

function startOfToday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d.getTime();
}

/** rate_limit_info → {status, fiveHour, sevenDay} with resetsAt in ms. */
function normalizeLimits(info, capturedAt = Date.now()) {
  if (!info || typeof info !== 'object') return null;
  const w = info.unifiedWindows || {};
  const win = (x) => (x && Number.isFinite(x.utilization) && Number.isFinite(x.resetsAt) ? { utilization: x.utilization, resetsAt: x.resetsAt * 1000 } : null);
  const out = {
    status: info.status || null,
    limitedBy: info.rateLimitType || null,
    fiveHour: win(w.five_hour),
    sevenDay: win(w.seven_day),
    capturedAt,
  };
  // older CLIs: only the limiting window at top level
  if (!out.fiveHour && !out.sevenDay && Number.isFinite(info.utilization) && Number.isFinite(info.resetsAt)) {
    const one = { utilization: info.utilization, resetsAt: info.resetsAt * 1000 };
    if (info.rateLimitType === 'five_hour') out.fiveHour = one;
    else if (String(info.rateLimitType || '').startsWith('seven_day')) out.sevenDay = one;
  }
  return out;
}

/** A window whose reset time has passed has started over: its old % no longer applies. */
function current(win, now) {
  if (!win) return null;
  return win.resetsAt > now ? win : { ...win, utilization: null, expired: true };
}

class UsageService {
  /**
   * @param {{dataDir:string, base?:string, onChange?:(snap)=>void, resolveCommand?:()=>{command:string,prefixArgs?:string[]}, env?:()=>object}} o
   */
  constructor(o) {
    this.o = o;
    this.base = o.base || path.join(os.homedir(), '.claude', 'projects');
    this.file = path.join(o.dataDir, 'usage-limits.json');
    this.cache = { files: {} };
    this.tokens = null;
    this.scannedAt = null;
    this.scanning = null;
    this.limits = null;
    try { this.limits = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* none yet */ }
  }

  /** Called with every rate_limit_event from a JARVIS session. */
  onRateLimit(info) {
    const l = normalizeLimits(info);
    if (!l || (!l.fiveHour && !l.sevenDay)) return;
    this.limits = l;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(l, null, 2), 'utf8');
    } catch { /* keep in memory */ }
    this.emit();
  }

  windows(now = Date.now()) {
    const w = { today: startOfToday(now), week: startOfWeek(now) };
    const l = this.limits;
    if (l && l.fiveHour && l.fiveHour.resetsAt > now) w.fiveHour = l.fiveHour.resetsAt - H5;
    if (l && l.sevenDay && l.sevenDay.resetsAt > now) w.sevenDay = l.sevenDay.resetsAt - D7;
    return w;
  }

  /** Count tokens again (new transcript lines only). Concurrent calls share one scan. */
  refresh() {
    if (this.scanning) return this.scanning;
    const windows = this.windows();
    this.scanning = new Promise((resolve) => {
      const w = new Worker(path.join(__dirname, 'worker.js'), { workerData: { base: this.base, cache: this.cache, windows } });
      const done = (r) => {
        this.scanning = null;
        if (r && r.ok) {
          this.cache = r.cache;
          this.tokens = { ...r.totals, windows };
          this.scannedAt = Date.now();
          this.error = null;
        } else this.error = (r && r.error) || 'นับ token ไม่สำเร็จ';
        this.emit();
        resolve(this.snapshot());
      };
      w.once('message', done);
      w.once('error', (err) => done({ ok: false, error: err.message }));
    });
    return this.scanning;
  }

  /**
   * Ask Claude Code for fresh limit numbers: one tiny Haiku request (no tools,
   * not saved as a session). Uses a little of the 5-hour window.
   */
  ping({ timeoutMs = 60000 } = {}) {
    if (this.pinging) return this.pinging;
    this.pinging = new Promise((resolve) => {
      let cmd;
      try { cmd = this.o.resolveCommand(); } catch (err) { this.pinging = null; return resolve({ ok: false, error: err.message }); }
      const args = [...(cmd.prefixArgs || []), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--model', 'haiku', '--no-session-persistence', '--setting-sources', '', '--tools', ''];
      const p = spawn(cmd.command, args, { cwd: os.tmpdir(), env: this.o.env ? this.o.env() : process.env, windowsHide: true, shell: false });
      let buf = '';
      let got = false;
      const finish = (r) => {
        clearTimeout(timer);
        try { p.kill(); } catch { /* gone */ }
        this.pinging = null;
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: got, error: got ? undefined : 'Claude Code ไม่ตอบภายในเวลา' }), timeoutMs);
      p.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'rate_limit_event') { got = true; this.onRateLimit(ev.rate_limit_info); }
          if (ev.type === 'result') finish({ ok: got, error: got ? undefined : 'Claude Code ไม่ได้ส่งข้อมูลลิมิตมา (อาจใช้ API key แทนการ login แบบ subscription)' });
        }
      });
      p.on('error', (err) => finish({ ok: false, error: err.message }));
      p.on('exit', () => setTimeout(() => finish({ ok: got, error: got ? undefined : 'Claude Code ปิดไปก่อนส่งข้อมูลลิมิต' }), 50));
      p.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: 'reply with: ok' } }) + '\n');
    });
    return this.pinging;
  }

  snapshot(now = Date.now()) {
    const l = this.limits;
    return {
      limits: l ? { ...l, fiveHour: current(l.fiveHour, now), sevenDay: current(l.sevenDay, now) } : null,
      tokens: this.tokens,
      scannedAt: this.scannedAt,
      error: this.error || null,
    };
  }

  emit() {
    if (this.o.onChange) this.o.onChange(this.snapshot());
  }
}

module.exports = { UsageService, normalizeLimits, startOfWeek, startOfToday };
