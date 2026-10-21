// Task status pill: while JARVIS is working on the latest command, a slim capsule at the top centre
// shows which command it is, what it is doing right now, and how long it has been going.
// One element for every page (home, conversation, sections); it never takes the mouse and never moves other UI.

const FADE_MS = 260;

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
    el.setAttribute('aria-live', 'off');
    const part = (cls) => { const s = document.createElement('span'); s.className = cls; return s; };
    this.dot = part('ts-dot');
    this.cmd = part('ts-cmd');
    this.phase = part('ts-phase');
    this.time = part('ts-time');
    el.append(this.dot, this.cmd, part('ts-sep'), this.phase, part('ts-sep'), this.time);
    document.body.append(el);
    this.el = el;
    this.running = false;
    this.command = '';
    this.t0 = 0;
    this.tick = null;
    this.hideTimer = null;
  }

  /** info: { running, command, phase, attention, step: { current, total } | null } */
  update({ running, command = '', phase = '', attention = false, step = null }) {
    const text = String(command).replace(/\s+/g, ' ').trim().slice(0, 140);
    if (running && (!this.running || text !== this.command)) this.t0 = Date.now();
    this.command = text;
    this.cmd.textContent = text || 'คำสั่งล่าสุด';
    this.cmd.title = text;
    this.phase.textContent = step && step.total ? `${phase} · ขั้น ${step.current}/${step.total}` : phase;
    this.el.classList.toggle('att', !!attention);
    if (running === this.running) return;
    this.running = running;
    clearTimeout(this.hideTimer);
    if (running) {
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
}
