// UI style (hud | calm | arc) and motion (auto | full | reduced) — pure state + <html> attributes.
// Per-viewer preferences live in localStorage; ui/style-boot.js applies them before first paint.

export const STYLES = ['hud', 'calm', 'arc'];
export const MOTIONS = ['auto', 'full', 'reduced'];

const listeners = new Set();
const root = () => document.documentElement;

function read(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

export function getStyle() {
  const v = root().dataset.style;
  return STYLES.includes(v) ? v : read('jarvis.style', STYLES, 'hud');
}

export function getMotion() {
  const v = root().dataset.motion;
  return MOTIONS.includes(v) ? v : read('jarvis.motion', MOTIONS, 'auto');
}

/** True when animations should be minimal: user chose "reduced", or "auto" + OS reduce-motion. */
export function motionReduced() {
  const m = getMotion();
  if (m === 'reduced') return true;
  if (m === 'full') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function setStyle(style) {
  if (!STYLES.includes(style)) return;
  root().dataset.style = style;
  write('jarvis.style', style);
  emit();
}

export function setMotion(motion) {
  if (!MOTIONS.includes(motion)) return;
  root().dataset.motion = motion;
  write('jarvis.motion', motion);
  emit();
}

/** cb({ style, reduced }) on every change; called once immediately. Returns an unsubscribe function. */
export function onStyleChange(cb) {
  listeners.add(cb);
  cb({ style: getStyle(), reduced: motionReduced() });
  return () => listeners.delete(cb);
}

function emit() {
  const state = { style: getStyle(), reduced: motionReduced() };
  for (const cb of listeners) cb(state);
}

if (typeof matchMedia === 'function') {
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => { if (getMotion() === 'auto') emit(); });
}
