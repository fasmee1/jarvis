// Sample map: which recorded sound plays for which cue (renderer/sfx.js falls back to its synthesized version when a
// file is missing or not decoded yet). Sounds are from Kenney's "Interface Sounds" and "Sci-fi Sounds" packs
// (CC0, see audio/sfx/LICENSE.txt). To change a sound, edit the file name here — nothing else.
//
// A cue maps to { group, wet, gate?, layers } or to a function (args, sfx) returning the same.
//   group  : which switch mutes it ('ui' | 'boot' | 'chat' | 'wake')
//   wet    : reverb send (0..1)
//   layers : [{ f, level, rate, at, lp, hp, loop, dur, fadeIn, fadeOut }]
//            f = file name without .ogg · level = volume · rate = playback speed (or [from, to] glide)
//            at = start delay (s) · lp / hp = low-/high-pass Hz (or [from, to] sweep) · dur = play length (s)
//   synth  : true = also play the synthesized version underneath (adds weight)

export const SAMPLE_FILES = new Set();
const L = (f, o = {}) => { SAMPLE_FILES.add(f); return { f, ...o }; };
const pick = (list, i) => list[((i % list.length) + list.length) % list.length];

export const SAMPLE_MAP = {
  // ---------- the intro film ----------
  // reactor charging: a low engine bed climbs in pitch and brightness for the whole film
  introHum: ([len = 4]) => ({
    group: 'boot', wet: 0.4, synth: true,
    layers: [L('spaceEngineLow_000', { level: 0.55, rate: [0.8, 1.18], lp: [160, 2400], loop: true, dur: len + 0.6, fadeIn: len * 0.5, fadeOut: 0.9 })],
  }),
  // heartbeat of the spark: a deep thump with no top end
  introPulse: ([k = 1]) => ({
    group: 'boot', wet: 0.3,
    layers: [L('lowFrequency_explosion_001', { level: 0.5 * k, rate: 1.1, lp: 220, dur: 0.6 })],
  }),
  introTick: ([i = 0]) => ({
    group: 'boot', wet: 0.1, pan: ((i % 5) - 2) * 0.25,
    layers: [L(pick(['tick_001', 'tick_002', 'tick_004'], i), { level: 0.45, rate: 0.9 + (i % 4) * 0.06 })],
  }),
  // ignition: sub boom + the force field bloom on top
  introImpact: () => ({
    group: 'boot', wet: 0.5, synth: true,
    layers: [
      L('lowFrequency_explosion_000', { level: 0.95, rate: 0.95, lp: 700, dur: 2 }),
      L('forceField_002', { level: 0.55, rate: 0.85, at: 0.03, lp: 7000 }),
      L('impactMetal_003', { level: 0.3, rate: 0.7, lp: 1800 }),
    ],
  }),
  introGreet: () => ({
    group: 'boot', wet: 0.45,
    layers: [L('confirmation_003', { level: 0.6, rate: 0.95 }), L('glass_004', { level: 0.25, at: 0.08, hp: 1200 })],
  }),

  // ---------- boot (calm style and the end of the HUD boot) ----------
  ready: () => ({
    group: 'boot', wet: 0.4,
    layers: [L('confirmation_004', { level: 0.65 }), L('glass_004', { level: 0.22, at: 0.1, hp: 1400 })],
  }),
  panelOpen: ([i = 0, pan = 0, opt = {}]) => ({
    group: opt.group || 'boot', wet: 0.22, pan,
    layers: [L(pick(['open_001', 'open_002', 'open_003', 'open_004'], i), { level: 0.5, rate: 0.94 + Math.min(i, 8) * 0.025, at: opt.blipAt ?? 0.05 })],
  }),
  panelBlip: ([i = 0, pan = 0, group = 'ui']) => ({
    group, wet: 0.22, pan,
    layers: [L(pick(['open_001', 'open_002', 'open_003', 'open_004'], i), { level: 0.5, rate: 0.94 + Math.min(i, 8) * 0.025 })],
  }),

  // ---------- interaction ----------
  hover: () => ({ group: 'ui', wet: 0.05, gate: 'hover', layers: [L('tick_004', { level: 0.22, rate: 1.1 })] }),
  click: () => ({ group: 'ui', wet: 0.1, layers: [L('click_001', { level: 0.45 })] }),
  dockWhoosh: () => ({ group: 'ui', wet: 0.25, skipReduced: true, layers: [L('minimize_005', { level: 0.5, lp: 5200 })] }),
  undockWhoosh: () => ({ group: 'ui', wet: 0.25, skipReduced: true, layers: [L('maximize_005', { level: 0.5, lp: 5200 })] }),
  dockHit: () => ({ group: 'ui', wet: 0.3, layers: [L('drop_002', { level: 0.5, rate: 0.9 })] }),
  micOn: () => ({ group: 'ui', wet: 0.18, layers: [L('maximize_007', { level: 0.5 })] }),
  micOff: () => ({ group: 'ui', wet: 0.18, layers: [L('minimize_007', { level: 0.5 })] }),
  wakeChime: () => ({ group: 'wake', wet: 0.2, layers: [L('confirmation_001', { level: 0.6 })] }),
  captureBlip: () => ({ group: 'ui', wet: 0.15, layers: [L('pluck_001', { level: 0.5, rate: 1.1 })] }),
  cancelBlip: () => ({ group: 'ui', wet: 0.15, layers: [L('back_002', { level: 0.5 })] }),
  hfOn: () => ({ group: 'ui', wet: 0.2, layers: [L('maximize_008', { level: 0.5 })] }),
  hfOff: () => ({ group: 'ui', wet: 0.2, layers: [L('minimize_008', { level: 0.5 })] }),
  cameraTransform: ([dir = 'in']) => ({ group: 'ui', wet: 0.3, layers: [L('forceField_001', { level: 0.45, rate: dir === 'in' ? 1 : 0.85, lp: 6000 })] }),
  lensFocus: () => ({ group: 'ui', wet: 0.2, layers: [L('glass_003', { level: 0.4, rate: 0.9 })] }),
  shutter: () => ({ group: 'chat', wet: 0.1, layers: [L('impactMetal_004', { level: 0.45, rate: 1.7, lp: 5000 }), L('click_001', { level: 0.3, at: 0.02 })] }),

  // ---------- chat ----------
  error: () => ({ group: 'ui', wet: 0.2, layers: [L('error_005', { level: 0.5 })] }),
  send: () => ({ group: 'chat', wet: 0.15, layers: [L('pluck_002', { level: 0.45 })] }),
  done: () => ({ group: 'chat', wet: 0.2, layers: [L('confirmation_003', { level: 0.5 })] }),
  approval: () => ({ group: 'chat', wet: 0.2, layers: [L('question_002', { level: 0.5 })] }),
};

// register every file named above (the map functions only register their files when called)
for (const key of Object.keys(SAMPLE_MAP)) {
  try { SAMPLE_MAP[key]([0, 0, {}]); } catch { /* arguments without defaults */ }
}
// files that are only picked from lists above (pick(...)) and so never pass through L()
for (const f of ['open_002', 'open_003', 'open_004', 'tick_002']) SAMPLE_FILES.add(f);
