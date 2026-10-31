// Task status pill: while JARVIS is working on the latest command, a slim capsule at the top centre
// shows which command it is, what it is doing right now, and how long it has been going.
// One element for every page (home, conversation, sections); it never takes the mouse and never moves other UI.

const FADE_MS = 260;
const RESULT_MS = 4000; // how long "เสร็จแล้ว" stays

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class TaskStatus {
  constructor() {
    const el = document.createElement('div');
    el.className = 'task-status';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    const part = (cls) => { const s = document.createElement('span'); s.className = cls; return s; };
    this.dot = part('ts-dot');
    this.cmd = part('ts-cmd');
    this.phase = part('ts-phase');
    this.time = part('ts-time');
    this.sep2 = part('ts-sep');
    el.append(this.dot, this.cmd, part('ts-sep'), this.phase, this.sep2, this.time);
    document.body.append(el);
    this.el = el;
    this.running = false;
    this.command = '';
    this.t0 = 0;
    this.tick = null;
    this.hideTimer = null;
    this.result = null; // 'done' | 'err' while the finished state is shown
  }

  /** info: { running, command, phase, attention, step: { current, total } | null } */
  update({ running, command = '', phase = '', attention = false, step = null }) {
    if (this.result && !running) return; // showing the result of the turn; its own timer hides the pill
    const text = String(command).replace(/\s+/g, ' ').trim().slice(0, 140);
    if (running && (!this.running || text !== this.command)) this.t0 = Date.now();
    this.command = text;
    this.cmd.textContent = text || 'คำสั่งล่าสุด';
    this.cmd.title = text;
    this.phase.textContent = step && step.total ? `${phase} · ขั้น ${step.current}/${step.total}` : phase;
    this.el.classList.toggle('att', !!attention);
    // waiting for the user (a question, a permission): no clock, the wait is not JARVIS's work time
    this.time.style.display = attention ? 'none' : '';
    this.sep2.style.display = attention ? 'none' : '';
    if (running === this.running) return;
    this.running = running;
    clearTimeout(this.hideTimer);
    if (running) {
      this.result = null;
      this.el.classList.remove('done', 'err');
      this.time.textContent = fmt(0);
      this.el.hidden = false;
      requestAnimationFrame(() => this.el.classList.add('on'));
      clearInterval(this.tick);
      this.tick = setInterval(() => { this.time.textContent = fmt(Date.now() - this.t0); }, 1000);
    } else {
      clearInterval(this.tick);
      this.tick = null;
      this.el.classList.remove('on');
      this.hideTimer = setTimeout(() => { if (!this.running) this.el.hidden = true; }, FADE_MS + 40);
    }
  }

  /** The turn ended: keep the pill a few seconds as "เสร็จแล้ว" / "ผิดพลาด" with the total time. */
  finish(ok) {
    if (!this.running) return;
    this.result = ok ? 'done' : 'err';
    this.running = false;
    clearInterval(this.tick);
    this.tick = null;
    this.time.textContent = fmt(Date.now() - this.t0);
    this.phase.textContent = ok ? 'เสร็จแล้ว ✓' : 'ผิดพลาด ✕';
    this.el.classList.remove('att');
    this.el.classList.toggle('done', !!ok);
    this.el.classList.toggle('err', !ok);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.result = null;
      if (this.running) return;
      this.el.classList.remove('on');
      this.hideTimer = setTimeout(() => { if (!this.running) { this.el.hidden = true; this.el.classList.remove('done', 'err'); } }, FADE_MS + 40);
    }, RESULT_MS);
  }
}
