'use strict';
// Hold-to-talk key tracking. Pure: main.js feeds it raw key events from the native hook
// (uiohook-napi) and gets back 'down' / 'up' edges for ONE configured accelerator only.
// Nothing else about the keyboard is kept or reported.

const MODIFIERS = {
  ctrl: ['Ctrl', 'CtrlRight'],
  shift: ['Shift', 'ShiftRight'],
  alt: ['Alt', 'AltRight'],
  meta: ['Meta', 'MetaRight'],
};
const MOD_ALIASES = {
  control: 'ctrl', ctrl: 'ctrl', commandorcontrol: 'ctrl', cmdorctrl: 'ctrl',
  shift: 'shift', alt: 'alt', option: 'alt',
  meta: 'meta', super: 'meta', command: 'meta', cmd: 'meta', win: 'meta',
};
const KEY_ALIASES = { esc: 'Escape', return: 'Enter', del: 'Delete', ins: 'Insert', pgup: 'PageUp', pgdn: 'PageDown', plus: 'Equal' };

/**
 * "Control+Space" -> { mods: ['ctrl'], codes: [keycodes of the main key] } or null when it cannot be mapped.
 * @param {string} accelerator Electron-style accelerator
 * @param {Record<string, number>} keyMap UiohookKey (name -> keycode)
 */
function parseAccelerator(accelerator, keyMap) {
  const parts = String(accelerator || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = new Set();
  let main = null;
  for (const p of parts) {
    const m = MOD_ALIASES[p.toLowerCase()];
    if (m) { mods.add(m); continue; }
    if (main) return null; // two non-modifier keys
    main = p;
  }
  if (!main) return null;
  const wanted = (KEY_ALIASES[main.toLowerCase()] || main).toLowerCase();
  const name = Object.keys(keyMap).find((k) => k.toLowerCase() === wanted);
  if (name === undefined) return null;
  return { mods: [...mods], key: keyMap[name] };
}

class PttTracker {
  /**
   * @param {string} accelerator
   * @param {Record<string, number>} keyMap UiohookKey
   */
  constructor(accelerator, keyMap) {
    this.spec = parseAccelerator(accelerator, keyMap);
    this.modCodes = {};
    for (const [m, names] of Object.entries(MODIFIERS)) this.modCodes[m] = names.map((n) => keyMap[n]).filter((c) => c !== undefined);
    this.allModCodes = new Set(Object.values(this.modCodes).flat());
    this.held = new Set();
    this.active = false;
  }

  get valid() { return !!this.spec; }

  _modHeld(m) { return this.modCodes[m].some((c) => this.held.has(c)); }

  _comboHeld() {
    if (!this.held.has(this.spec.key)) return false;
    return Object.keys(this.modCodes).every((m) => this._modHeld(m) === this.spec.mods.includes(m));
  }

  /**
   * @param {'down'|'up'} type
   * @param {number} keycode
   * @returns {'down'|'up'|null} an edge of the hold, or null
   */
  feed(type, keycode) {
    if (!this.spec) return null;
    if (type === 'down') this.held.add(keycode);
    else this.held.delete(keycode);
    if (!this.active) {
      if (type === 'down' && keycode === this.spec.key && this._comboHeld()) {
        this.active = true;
        return 'down';
      }
      return null;
    }
    // releasing the main key or any required modifier ends the hold
    if (!this._comboHeld()) {
      this.active = false;
      return 'up';
    }
    return null;
  }

  /** Forget held keys (e.g. after the hook restarts or the screen locks). Returns 'up' if a hold was open. */
  reset() {
    this.held.clear();
    if (!this.active) return null;
    this.active = false;
    return 'up';
  }
}

module.exports = { PttTracker, parseAccelerator };
