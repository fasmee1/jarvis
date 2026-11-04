// Real startup checks shown by the calm boot intro (ui/calm-intro.js). app.js reports each
// one when its real signal arrives; nothing here guesses or fakes progress. Pure module.

export const CHECKS = [
  { id: 'core', label: 'แกนระบบ' },
  { id: 'mic', label: 'ไมโครโฟน' },
  { id: 'voice', label: 'เสียงพูด' },
  { id: 'stt', label: 'ถอดเสียง' },
];

class StartupChecks {
  constructor() {
    this.items = new Map(CHECKS.map((c) => [c.id, { ...c, state: 'pending', text: '' }]));
    this.subs = new Set();
  }

  /** state: 'ok' | 'fail'; text: the real reason when it failed (Thai). */
  report(id, ok, text = '') {
    const it = this.items.get(id);
    if (!it || it.state !== 'pending') return;
    it.state = ok ? 'ok' : 'fail';
    it.text = ok ? '' : String(text || 'ไม่พร้อม');
    for (const fn of this.subs) fn(it);
  }

  list() {
    return [...this.items.values()];
  }

  get settled() {
    return this.list().every((it) => it.state !== 'pending');
  }

  /** Returns an unsubscribe function. */
  on(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

export const startupChecks = new StartupChecks();
export { StartupChecks };
