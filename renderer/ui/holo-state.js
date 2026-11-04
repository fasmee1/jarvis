// Calm style holographic core: app state → visual targets (pure, no DOM / WebGL).
// The renderer (scripts/holo-core/entry.js → vendor/holo-core.min.js) eases toward these
// every frame, so state changes always blend smoothly. Only real app states and real
// audio levels drive it; nothing here is random.

const PROCESSING = new Set(['TRANSCRIBING', 'THINKING', 'TOOL_RUNNING', 'STREAMING']);

/**
 * glow      overall brightness of rings + particles (0..1.6)
 * speed     orbit speed multiplier (1 = standby)
 * swarm     particle activity: drift speed + audio push (0..1)
 * pulse     seconds between travelling energy pulses (0 = none on a timer)
 * orange    share of orange energy on the rings (0..1, standby keeps a little)
 * wave      inner waveform ring opacity (0..1)
 * audio     how strongly the real level drives glow / particles (0..1)
 */
const BASE = {
  STANDBY: { glow: 0.62, speed: 1, swarm: 0.15, pulse: 0, orange: 0.3, wave: 0, audio: 0 },
  WAKE: { glow: 0.42, speed: 0.55, swarm: 0.08, pulse: 0, orange: 0.22, wave: 0, audio: 0 },
  LISTENING: { glow: 0.95, speed: 1.25, swarm: 0.45, pulse: 0, orange: 0.24, wave: 0.55, audio: 1 },
  FOLLOW_UP: { glow: 0.78, speed: 1.1, swarm: 0.3, pulse: 0, orange: 0.24, wave: 0.35, audio: 0.6 },
  THINKING: { glow: 0.9, speed: 1.9, swarm: 0.7, pulse: 0.9, orange: 0.4, wave: 0, audio: 0 },
  SPEAKING: { glow: 0.82, speed: 1.3, swarm: 0.4, pulse: 0, orange: 0.34, wave: 0.85, audio: 1 },
  APPROVAL: { glow: 0.72, speed: 0.7, swarm: 0.2, pulse: 0, orange: 0.62, wave: 0, audio: 0 },
  ERROR: { glow: 0.5, speed: 0.35, swarm: 0.1, pulse: 0, orange: 0.8, wave: 0, audio: 0 },
};

export function holoKind(state) {
  if (PROCESSING.has(state)) return 'THINKING';
  switch (state) {
    case 'WAKE_LISTENING': case 'WAKE_DETECTED': return 'WAKE';
    case 'LISTENING': return 'LISTENING';
    case 'FOLLOW_UP': return 'FOLLOW_UP';
    case 'SPEAKING': return 'SPEAKING';
    case 'AWAITING_APPROVAL': return 'APPROVAL';
    case 'ERROR': return 'ERROR';
    default: return 'STANDBY';
  }
}

/** Targets for a state at the current real level (0..1). Reduced motion keeps brightness, drops movement. */
export function holoTarget(state, level = 0, { reduced = false } = {}) {
  const b = BASE[holoKind(state)];
  const lv = Math.max(0, Math.min(1, level || 0)) * b.audio;
  return {
    glow: b.glow + lv * 0.55,
    speed: reduced ? 0 : b.speed * (1 + lv * 0.4),
    swarm: reduced ? 0 : Math.min(1, b.swarm + lv * 0.5),
    pulse: reduced ? 0 : b.pulse,
    orange: b.orange,
    wave: b.wave,
    level: lv,
  };
}

/** Ease every numeric field of cur toward tgt (rate per second). Mutates and returns cur. */
export function easeToward(cur, tgt, dt, rate = 3) {
  const k = 1 - Math.exp(-rate * Math.max(0, dt));
  for (const key of Object.keys(tgt)) cur[key] = (cur[key] ?? tgt[key]) + (tgt[key] - (cur[key] ?? tgt[key])) * k;
  return cur;
}
