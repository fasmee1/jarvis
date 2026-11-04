// Source of renderer/ui/vendor/holo-core.min.js (bundled by scripts/build-holo-core.js).
// Calm style reactor: a holographic energy core in WebGL. Overlapping transparent
// ribbons (fresnel edges, fine wires, speckle), thin orbital lines with travelling
// light points, a few thousand particles, a horizontal light streak behind the
// J.A.R.V.I.S wordmark (the wordmark itself is HTML) and, while JARVIS speaks or
// listens, glowing voice strands that stream out of both sides of the wordmark.
// Driven only by real app state + real audio (setState / setSignals / pulseActivity / wake);
// see renderer/ui/holo-state.js for the state → visual mapping.

import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, Points, LineLoop, LineSegments,
  BufferGeometry, BufferAttribute, PlaneGeometry, ShaderMaterial, AdditiveBlending, DoubleSide, Color, Vector2, Vector4,
} from 'three';
import { holoTarget, easeToward } from '../../renderer/ui/holo-state.js';

const TAU = Math.PI * 2;
const DESIGN = 1200; // canvas size in stage px (the 720 core box sits in the middle)
const PX_PER_UNIT = 280; // stage px per world unit at z = 0 (ribbon radius ≈ 1)
const FOV = 28;
const CAM_Z = (DESIGN / 2 / PX_PER_UNIT) / Math.tan((FOV / 2) * Math.PI / 180);
const BANDS = 16; // audio bands passed to the shaders
const PULSES = 4; // pulse slots per ribbon

const C = {
  blue: new Color('#087BFF'),
  holo: new Color('#20B8FF'),
  cyan: new Color('#70DFFF'),
  orange: new Color('#FF741C'),
  warm: new Color('#FF9B45'),
  amber: new Color('#FF8A34'), // between energy and warm orange: reads orange on navy, not red
};

// Deterministic PRNG so the structure is identical on every launch.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- ribbons ----------
// R radius, w width, tilt Euler (rad), phase: 0 = hoop, π/2 = flat ring, twist: turns of the
// strip per lap (0.5 = Möbius), spin rad/s at speed 1, orange region centre / width (u 0..1)
const RIBBONS = [
  { R: 1.0, w: 0.4, tilt: [0.62, 0.38, 0.3], phase: Math.PI / 2, twist: 0.5, spin: 0.05, oAt: 0.12, oW: 0.24 },
  { R: 0.96, w: 0.32, tilt: [-0.74, 0.5, -0.25], phase: Math.PI / 2, twist: 0, spin: -0.065, oAt: 0.6, oW: 0.2 },
  { R: 1.05, w: 0.24, tilt: [0.28, -0.86, 0.9], phase: Math.PI / 2.4, twist: 1, spin: 0.04, oAt: 0.36, oW: 0.14 },
  { R: 0.92, w: 0.34, tilt: [0.98, -0.32, 1.6], phase: Math.PI / 2, twist: 0.5, spin: -0.035, oAt: 0.83, oW: 0.18 },
  { R: 1.12, w: 0.1, tilt: [0.16, 0.2, 0.0], phase: Math.PI / 2, twist: 0, spin: 0.022, oAt: 0.7, oW: 0.1 },
];

function ribbonGeometry({ R, w, phase, twist }, seg = 360) {
  const pos = new Float32Array((seg + 1) * 2 * 3);
  const uv = new Float32Array((seg + 1) * 2 * 2);
  const idx = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    const th = u * TAU;
    const cx = Math.cos(th), sy = Math.sin(th);
    const phi = phase + twist * th;
    // strip direction: mix of the ring axis (z) and the radial direction
    const dx = Math.sin(phi) * cx, dy = Math.sin(phi) * sy, dz = Math.cos(phi);
    for (let s = 0; s < 2; s++) {
      const o = (s - 0.5) * w;
      const k = (i * 2 + s);
      pos[k * 3] = R * cx + dx * o;
      pos[k * 3 + 1] = R * sy + dy * o;
      pos[k * 3 + 2] = dz * o;
      uv[k * 2] = u;
      uv[k * 2 + 1] = s;
    }
    if (i < seg) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const RIBBON_VS = /* glsl */`
varying vec2 vUv;
varying float vFres;
varying float vDepth;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFres = 1.0 - abs(dot(n, normalize(-mv.xyz)));
  vDepth = mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const RIBBON_FS = /* glsl */`
uniform float uTime, uGlow, uOrange, uOAt, uOW, uSeed, uCamZ, uDraw;
uniform vec4 uPulse[${PULSES}];
uniform vec3 uBlue, uHolo, uCyan, uOrangeC;
varying vec2 vUv;
varying float vFres;
varying float vDepth;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float u = vUv.x, v = vUv.y;
  float ac = abs(v * 2.0 - 1.0);
  float edge = smoothstep(0.78, 1.0, ac) * 0.7 + smoothstep(0.965, 1.0, ac) * 0.9;
  float fill = 0.07 * (1.0 - ac * 0.5);
  float wires = pow(0.5 + 0.5 * cos(v * 6.2831 * 13.0), 14.0) * 0.32;
  vec2 cell = vec2(floor(u * 1100.0), floor(v * 22.0));
  float h = hash(cell + uSeed);
  float dots = step(0.94, h) * (0.45 + 0.55 * sin(uTime * 1.7 + h * 50.0)) * 0.55;
  float fres = pow(clamp(vFres, 0.0, 1.0), 1.6);
  float base = (fill + wires + dots) * (0.45 + 1.1 * fres) + edge * (0.55 + 0.9 * fres);

  float du = abs(fract(u - uOAt + 0.5) - 0.5);
  float om = smoothstep(uOW, 0.0, du) * uOrange;

  float pe = 0.0, po = 0.0;
  for (int i = 0; i < ${PULSES}; i++) {
    vec4 p = uPulse[i];
    if (p.y <= 0.001) continue;
    float d = fract(u - p.x + 0.5) - 0.5;          // + ahead of the head, - behind
    float e = p.y * (d < 0.0 ? exp(d * 22.0) : exp(-d * 160.0));
    pe += e * (1.0 - p.z);
    po += e * p.z;
  }

  vec3 blue = mix(uBlue, uHolo, 0.35 + 0.45 * fres);
  blue = mix(blue, uCyan, clamp(edge * 0.45 + pe * 0.6, 0.0, 1.0));
  // a quick blue → orange turn so the arcs read orange, not a purple in-between
  float ot = clamp(om * (0.85 + edge) + po, 0.0, 1.0);
  vec3 col = mix(blue, uOrangeC, smoothstep(0.0, 0.55, ot));
  base += om * (0.25 + edge * 0.9);
  // back of the structure is dimmer: real depth
  float depthK = mix(0.38, 1.0, smoothstep(-uCamZ - 1.1, -uCamZ + 1.0, vDepth));
  float a = (base + (pe + po) * (0.5 + edge * 1.2)) * uGlow * depthK;
  // boot intro: the ribbon draws itself on from u = 0, with a bright front (uDraw > 1: whole)
  float dd = uDraw - u;
  a *= smoothstep(-0.004, 0.012, dd);
  float front = exp(-dd * dd * 4000.0) * (1.0 - step(1.0, uDraw)) * smoothstep(-0.004, 0.004, dd);
  a += front * uGlow * (0.08 + edge * 0.9);
  col = mix(col, uCyan, clamp(front * edge, 0.0, 1.0));
  a = clamp(a, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}`;

// ---------- orbital lines ----------
const ORBITS = [
  { R: 1.24, tilt: [0.12, 0.05, 0.0], dash: 0, a: 0.16, head: 0.07 },
  { R: 1.32, tilt: [0.2, -0.1, 0.4], dash: 180, a: 0.12, head: -0.045 },
  { R: 1.42, tilt: [0.08, 0.14, -0.2], dash: 0, a: 0.08, head: 0.03 },
  { R: 1.16, tilt: [1.2, 0.3, 0.6], dash: 0, a: 0.07, head: -0.06 },
  { R: 1.52, tilt: [0.0, 0.0, 0.0], dash: 90, a: 0.06, head: 0 },
];

function circleGeometry(R, n = 512) {
  const pos = new Float32Array(n * 3);
  const u = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    pos[i * 3] = Math.cos(t) * R;
    pos[i * 3 + 1] = Math.sin(t) * R;
    u[i] = i / n;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aU', new BufferAttribute(u, 1));
  return g;
}

const LINE_VS = /* glsl */`
attribute float aU;
varying float vU;
varying float vDepth;
void main() {
  vU = aU;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const LINE_FS = /* glsl */`
uniform vec3 uColor, uHeadC;
uniform float uAlpha, uDash, uHead, uHeadA, uCamZ, uDraw;
varying float vU;
varying float vDepth;
void main() {
  float a = uAlpha * step(vU, uDraw);
  if (uDash > 0.0) a *= step(0.45, fract(vU * uDash));
  float d = abs(fract(vU - uHead + 0.5) - 0.5);
  float head = exp(-d * d * 9000.0) * uHeadA + exp(-d * 60.0) * uHeadA * 0.25;
  a *= mix(0.45, 1.0, smoothstep(-uCamZ - 1.5, -uCamZ + 1.5, vDepth));
  float o = clamp(a + head, 0.0, 1.0);
  gl_FragColor = vec4(mix(uColor, uHeadC, clamp(head, 0.0, 1.0)) * o, o);
}`;

// ---------- particles ----------
const PART_VS = /* glsl */`
attribute vec4 aSeed; // x: orbit speed, y: twinkle rate, z: size, w: colour pick
uniform float uTime, uPhase, uPush, uPx, uCamZ, uGlow, uGather;
uniform float uBands[${BANDS}];
varying float vA;
varying float vC;
void main() {
  vec3 p = position;
  float ang = uPhase * aSeed.x;
  float c = cos(ang), s = sin(ang);
  p = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
  float az = atan(p.y, p.x);
  float m = abs(az) / 3.14159265;               // mirrored spectrum around the circle
  int bi = int(clamp(m * ${BANDS - 1}.0, 0.0, ${BANDS - 1}.0));
  float band = 0.0;
  for (int i = 0; i < ${BANDS}; i++) if (i == bi) band = uBands[i];
  p *= 1.0 + uPush * (0.04 + band * 0.12);
  // boot intro: each particle streams in from outside the frame on a curved path
  float g = clamp(uGather * 1.6 - aSeed.w * 0.6, 0.0, 1.0);
  float ge = 1.0 - pow(1.0 - g, 3.0);
  if (ge < 1.0) {
    float sw = (1.0 - ge) * (1.4 + aSeed.x);
    float cs = cos(sw), sn = sin(sw);
    vec3 far = normalize(p + vec3(0.0001)) * (2.6 + aSeed.y * 0.35);
    far = vec3(far.x * cs - far.y * sn, far.x * sn + far.y * cs, far.z);
    p = mix(far, p, ge);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.55 + 0.45 * sin(uTime * aSeed.y + aSeed.w * 80.0);
  vA = tw * uGlow * smoothstep(0.0, 0.35, g) * mix(0.4, 1.0, smoothstep(-uCamZ - 1.6, -uCamZ + 1.2, mv.z));
  vC = aSeed.w;
  gl_PointSize = aSeed.z * uPx * (uCamZ / -mv.z);
}`;
const PART_FS = /* glsl */`
uniform vec3 uBlue, uCyan, uOrangeC;
uniform float uOrangeShare;
varying float vA;
varying float vC;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  vec3 col = vC > 1.0 - uOrangeShare * 0.12 ? uOrangeC : mix(uBlue, uCyan, vC);
  gl_FragColor = vec4(col * a * vA, a * vA);
}`;

// ---------- voice strands (camera-facing) ----------
// Glowing threads leaving both sides of the wordmark. The real spectrum is laid out from
// the core outward (low → high); waves travel outward with the voice. Silent behind the text.
const VOICE_VS = /* glsl */`
attribute float aX;    // -1..1 along the strand
attribute float aSide; // -1 / 1 across its width
uniform float uBands[${BANDS}];
uniform float uLevel, uFlow, uOff, uFreq, uHalf, uSpan, uGain;
varying float vSide;
varying float vEnv;
void main() {
  float x = aX * uSpan;
  float ax = abs(x);
  // from the wordmark's ends (±0.66) out through the rings, fading before the cards
  float env = smoothstep(0.64, 0.84, ax) * (1.0 - smoothstep(uSpan * 0.7, uSpan, ax));
  float f = clamp((ax - 0.66) / (uSpan - 0.66), 0.0, 1.0) * ${BANDS - 1}.0;
  int i0 = int(floor(f));
  float b0 = 0.0, b1 = 0.0;
  for (int i = 0; i < ${BANDS}; i++) { if (i == i0) b0 = uBands[i]; if (i == i0 + 1) b1 = uBands[i]; }
  float band = mix(b0, b1, fract(f));
  float amp = uGain * (0.02 + uLevel * 0.12 + band * 0.3) * env;
  float y = amp * sin(ax * uFreq - uFlow + uOff) * (0.62 + 0.38 * sin(ax * uFreq * 0.41 + uFlow * 0.37 + uOff * 1.7));
  float hw = uHalf * (0.5 + env * (0.7 + band));
  vSide = aSide;
  vEnv = env;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y + aSide * hw, 0.0, 1.0);
}`;
const VOICE_FS = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
varying float vSide;
varying float vEnv;
void main() {
  float s2 = vSide * vSide;
  float core = exp(-s2 * 28.0);
  float a = clamp((0.3 * exp(-s2 * 2.5) + core) * vEnv * uAlpha, 0.0, 1.0);
  vec3 col = mix(uColor, vec3(1.0), core * 0.45);
  gl_FragColor = vec4(col * a, a);
}`;
const STRANDS = [
  { off: 0.0, freq: 9.0, color: 'cyan', gain: 1.0, half: 0.016, a: 1.0 },
  { off: 2.1, freq: 6.8, color: 'holo', gain: 0.85, half: 0.013, a: 0.8 },
  { off: 4.3, freq: 12.5, color: 'blue', gain: 0.7, half: 0.011, a: 0.75 },
  { off: 1.2, freq: 5.2, color: 'amber', gain: 0.5, half: 0.01, a: 0.45 },
];

function strandGeometry(n = 240) {
  const x = new Float32Array((n + 1) * 2);
  const side = new Float32Array((n + 1) * 2);
  const idx = [];
  for (let i = 0; i <= n; i++) {
    const v = (i / n) * 2 - 1;
    x[i * 2] = x[i * 2 + 1] = v;
    side[i * 2] = -1;
    side[i * 2 + 1] = 1;
    if (i < n) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array((n + 1) * 2 * 3), 3));
  g.setAttribute('aX', new BufferAttribute(x, 1));
  g.setAttribute('aSide', new BufferAttribute(side, 1));
  g.setIndex(idx);
  return g;
}

// ---------- streak (horizontal light line behind the wordmark) ----------
const STREAK_FS = /* glsl */`
uniform vec3 uBlue, uOrangeC;
uniform float uAlpha, uOrange;
varying vec2 vUv;
void main() {
  float x = abs(vUv.x * 2.0 - 1.0);
  float y = abs(vUv.y * 2.0 - 1.0);
  float core = pow(1.0 - x, 2.2) * (1.0 - y);
  float tip = smoothstep(0.78, 0.9, x) * smoothstep(1.0, 0.9, x) * uOrange * 0.45;
  vec3 col = mix(uBlue, uOrangeC, clamp(tip * 2.0, 0.0, 1.0));
  float a = (core + tip * 0.8) * uAlpha;
  gl_FragColor = vec4(col * a, a);
}`;
const PLANE_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// ---------- flares (soft light points) ----------
const FLARE_VS = /* glsl */`
attribute vec4 aF; // x: size, y: orange (0/1), z: phase
uniform float uPx, uTime, uAlpha, uBreath;
varying float vO;
varying float vA;
void main() {
  vO = aF.y;
  vA = uAlpha * (0.75 + 0.25 * sin(uTime * 0.8 + aF.z) * uBreath);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aF.x * uPx;
}`;
const FLARE_FS = /* glsl */`
uniform vec3 uBlue, uOrangeC;
varying float vO;
varying float vA;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q);
  float glow = exp(-d * d * 60.0) + exp(-d * 9.0) * 0.25;
  float cross = (exp(-abs(q.y) * 90.0) * exp(-abs(q.x) * 5.0) + exp(-abs(q.x) * 90.0) * exp(-abs(q.y) * 7.0)) * 0.6;
  vec3 col = mix(uBlue, uOrangeC, vO);
  float a = clamp((glow + cross) * vA, 0.0, 1.0);
  gl_FragColor = vec4(mix(col, vec3(1.0), glow * 0.35) * a, a);
}`;

// premultiplied output (rgb * a, a) + additive blending = gl.blendFunc(ONE, ONE): light adds up, the canvas alpha stays honest
const additive = (o) => new ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, premultipliedAlpha: true, ...o });

class HoloCore {
  constructor(canvas, { quality = 'high', reduced = false } = {}) {
    this.canvas = canvas;
    this.quality = quality === 'low' ? 'low' : 'high';
    this.reduced = !!reduced;
    this.state = 'STANDBY';
    this.level = 0;
    this.bands = new Float32Array(BANDS);
    this.cur = { ...holoTarget('STANDBY', 0, { reduced }) };
    this.t = 0; // animation clock (stops when motion is reduced)
    this.phase = 0; // accumulated orbit phase (speed changes never jump)
    this.pulseClock = 0;
    this.pulseN = 0;
    this.voiceFlow = 0; // voice strand wave clock
    this.voice = 0; // smoothed voice level (also lights the wordmark)
    this.lvSlow = 0; // slow level, for syllable onsets
    this.lastOnset = -1e9;
    this.onsetN = 0;
    this.lastAct = -1e9;
    this.wakeAt = -1e9;
    this.intro = null; // boot intro progress (renderer/ui/calm-intro-timeline.js), null = normal
    this.lost = false;
    this.onLost = null;
    this.rand = rng(11); // where a new pulse starts on its ribbon

    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: this.quality === 'high', premultipliedAlpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this._onLost = (e) => { e.preventDefault(); this.lost = true; if (this.onLost) this.onLost(); };
    canvas.addEventListener('webglcontextlost', this._onLost);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(FOV, 1, 0.1, 50);
    this.camera.position.set(0, 0, CAM_Z);
    this.cluster = new Group(); // the tilted 3D structure
    this.flat = new Group(); // camera-facing parts (streak, waveform, ripple, flares)
    this.scene.add(this.cluster, this.flat);
    this._build();
    this.resize(1);
  }

  _build() {
    const shared = { uTime: { value: 0 }, uCamZ: { value: CAM_Z }, uPx: { value: 1 }, uDrawL: { value: 2 } };
    this.shared = shared;
    const bandsU = { value: this.bands };
    this.bandsU = bandsU;

    // ribbons
    this.ribbons = RIBBONS.map((def, i) => {
      const holder = new Group();
      holder.rotation.set(def.tilt[0], def.tilt[1], def.tilt[2]);
      const mat = additive({
        side: DoubleSide,
        vertexShader: RIBBON_VS,
        fragmentShader: RIBBON_FS,
        uniforms: {
          uTime: shared.uTime, uCamZ: shared.uCamZ,
          uGlow: { value: 0 }, uOrange: { value: 0 }, uDraw: { value: 2 }, uOAt: { value: def.oAt }, uOW: { value: def.oW }, uSeed: { value: i * 17.3 },
          uPulse: { value: Array.from({ length: PULSES }, () => new Vector4(0, 0, 0, 0)) },
          uBlue: { value: C.blue }, uHolo: { value: C.holo }, uCyan: { value: C.cyan }, uOrangeC: { value: C.amber },
        },
      });
      const mesh = new Mesh(ribbonGeometry(def, this.quality === 'high' ? 360 : 200), mat);
      holder.add(mesh);
      this.cluster.add(holder);
      return { def, mesh, mat, pulses: mat.uniforms.uPulse.value, slot: 0 };
    });

    // orbital lines (+ one travelling light point each)
    this.orbits = ORBITS.map((def, i) => {
      const mat = additive({
        vertexShader: LINE_VS,
        fragmentShader: LINE_FS,
        uniforms: {
          uCamZ: shared.uCamZ, uDraw: shared.uDrawL, uColor: { value: C.holo }, uHeadC: { value: i === 1 ? C.warm : C.cyan },
          uAlpha: { value: def.a }, uDash: { value: def.dash }, uHead: { value: (i * 0.29) % 1 }, uHeadA: { value: def.head ? 0.9 : 0 },
        },
      });
      const line = new LineLoop(circleGeometry(def.R), mat);
      line.rotation.set(def.tilt[0], def.tilt[1], def.tilt[2]);
      this.cluster.add(line);
      return { def, line, mat };
    });

    // fine technical tick marks on the outer orbit (camera-facing)
    {
      const n = 120;
      const pos = new Float32Array(n * 2 * 3);
      const u = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const t = (i / n) * TAU;
        const major = i % 10 === 0;
        const r0 = 1.6, r1 = r0 + (major ? 0.05 : 0.022);
        pos.set([Math.cos(t) * r0, Math.sin(t) * r0, 0, Math.cos(t) * r1, Math.sin(t) * r1, 0], i * 6);
        u[i * 2] = u[i * 2 + 1] = i / n;
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('aU', new BufferAttribute(u, 1));
      this.ticksMat = additive({
        vertexShader: LINE_VS, fragmentShader: LINE_FS,
        uniforms: { uCamZ: shared.uCamZ, uDraw: shared.uDrawL, uColor: { value: C.holo }, uHeadC: { value: C.cyan }, uAlpha: { value: 0.1 }, uDash: { value: 0 }, uHead: { value: 0 }, uHeadA: { value: 0 } },
      });
      this.ticks = new LineSegments(g, this.ticksMat);
      this.flat.add(this.ticks);
    }

    // particles
    {
      const r = rng(7);
      const n = this.quality === 'high' ? 5200 : 1800;
      const pos = new Float32Array(n * 3);
      const seed = new Float32Array(n * 4);
      const tmp = new Group();
      for (let i = 0; i < n; i++) {
        let x, y, z;
        if (i < n * 0.72) {
          // on / around a ribbon, in its tilted frame
          const def = RIBBONS[Math.floor(r() * RIBBONS.length)];
          const th = r() * TAU;
          const o = (r() - 0.5) * def.w * 1.15;
          const phi = def.phase + def.twist * th;
          const lx = def.R * Math.cos(th) + Math.sin(phi) * Math.cos(th) * o;
          const ly = def.R * Math.sin(th) + Math.sin(phi) * Math.sin(th) * o;
          const lz = Math.cos(phi) * o;
          tmp.rotation.set(def.tilt[0], def.tilt[1], def.tilt[2]);
          tmp.updateMatrix();
          const e = tmp.matrix.elements;
          x = e[0] * lx + e[4] * ly + e[8] * lz;
          y = e[1] * lx + e[5] * ly + e[9] * lz;
          z = e[2] * lx + e[6] * ly + e[10] * lz;
          const j = 0.02;
          x += (r() - 0.5) * j; y += (r() - 0.5) * j; z += (r() - 0.5) * j;
        } else {
          // sparse halo, slightly flattened
          const u = r() * 2 - 1, th = r() * TAU, rad = 1.15 + Math.pow(r(), 1.6) * 0.85;
          const s = Math.sqrt(1 - u * u);
          x = rad * s * Math.cos(th); y = rad * u * 0.8; z = rad * s * Math.sin(th);
        }
        pos.set([x, y, z], i * 3);
        seed.set([0.4 + r() * 0.9, 0.6 + r() * 2.2, (i < n * 0.72 ? 1.4 : 1.1) + r() * 2.2, r()], i * 4);
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new BufferAttribute(seed, 4));
      this.partMat = additive({
        vertexShader: PART_VS, fragmentShader: PART_FS,
        uniforms: {
          uTime: shared.uTime, uPx: shared.uPx, uCamZ: shared.uCamZ, uBands: bandsU,
          uPhase: { value: 0 }, uPush: { value: 0 }, uGlow: { value: 0 }, uGather: { value: 1 }, uOrangeShare: { value: 0.3 },
          uBlue: { value: C.holo }, uCyan: { value: C.cyan }, uOrangeC: { value: C.warm },
        },
      });
      this.particles = new Points(g, this.partMat);
      this.cluster.add(this.particles);
    }

    // voice strands (speaking / listening)
    this.strands = STRANDS.map((d) => {
      const mat = additive({
        side: DoubleSide,
        vertexShader: VOICE_VS, fragmentShader: VOICE_FS,
        uniforms: {
          uBands: bandsU, uLevel: { value: 0 }, uFlow: { value: 0 }, uOff: { value: d.off }, uFreq: { value: d.freq },
          uHalf: { value: d.half }, uSpan: { value: 1.65 }, uGain: { value: d.gain }, uColor: { value: C[d.color] }, uAlpha: { value: 0 },
        },
      });
      const m = new Mesh(strandGeometry(this.quality === 'high' ? 320 : 160), mat);
      m.frustumCulled = false;
      this.flat.add(m);
      return { d, mat };
    });

    // wake ripple
    this.rippleMat = additive({
      vertexShader: LINE_VS, fragmentShader: LINE_FS,
      uniforms: { uCamZ: shared.uCamZ, uDraw: { value: 2 }, uColor: { value: C.cyan }, uHeadC: { value: C.cyan }, uAlpha: { value: 0 }, uDash: { value: 0 }, uHead: { value: 0 }, uHeadA: { value: 0 } },
    });
    this.ripple = new LineLoop(circleGeometry(1, 256), this.rippleMat);
    this.flat.add(this.ripple);

    // horizontal light streaks above / below the wordmark + a faint vertical guide
    const streak = (w, h, y, a) => {
      const mat = additive({
        vertexShader: PLANE_VS, fragmentShader: STREAK_FS,
        uniforms: { uBlue: { value: C.holo }, uOrangeC: { value: C.warm }, uAlpha: { value: 0 }, uOrange: { value: 1 } },
      });
      const m = new Mesh(new PlaneGeometry(w, h), mat);
      m.position.y = y;
      this.flat.add(m);
      return { mat, a };
    };
    this.streaks = [streak(4.0, 0.012, 0.135, 0.85), streak(4.0, 0.012, -0.135, 0.85), streak(3.0, 0.05, 0.0, 0.18)];
    this.streaks[2].noOrange = true;
    this.vguide = streak(0.006, 3.2, 0, 0.16);
    this.vguide.mat.uniforms.uOrange.value = 0;

    // flares
    {
      const pts = [
        [0, 0.135, 0, 54, 0, 0.0], [0, -0.135, 0, 64, 0, 1.3], [-1.86, 0.135, 0, 18, 1, 2.1], [1.86, -0.135, 0, 18, 1, 0.7],
        [0, 1.58, 0, 34, 0, 1.9], [0.98, 0.9, 0, 18, 1, 2.7], [-1.05, -0.86, 0, 22, 1, 0.3], [0.84, -0.96, 0, 20, 0, 1.1],
      ];
      const pos = new Float32Array(pts.length * 3);
      const f = new Float32Array(pts.length * 4);
      pts.forEach((p, i) => { pos.set(p.slice(0, 3), i * 3); f.set([p[3], p[4], p[5], 0], i * 4); });
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('aF', new BufferAttribute(f, 4));
      this.flareMat = additive({
        vertexShader: FLARE_VS, fragmentShader: FLARE_FS,
        uniforms: { uPx: shared.uPx, uTime: shared.uTime, uAlpha: { value: 0 }, uBreath: { value: 1 }, uBlue: { value: C.holo }, uOrangeC: { value: C.warm } },
      });
      this.flares = new Points(g, this.flareMat);
      this.flat.add(this.flares);
    }
  }

  // ---------- inputs (same names as the 2D Core) ----------
  setState(s) {
    if (s === this.state) return;
    this.state = s;
    this.pulseClock = 0;
  }

  setSignals({ level, bands }) {
    if (level != null) this.level = level;
    if (bands !== undefined) {
      if (bands && bands.length) {
        for (let i = 0; i < BANDS; i++) {
          const v = bands[Math.floor((i / (BANDS - 1)) * (bands.length - 1))] || 0;
          this.bands[i] += (Math.min(1, v * 1.2) - this.bands[i]) * 0.45;
        }
      } else {
        // no spectrum: shape the real level so the ring still breathes with the voice
        for (let i = 0; i < BANDS; i++) this.bands[i] += ((this.level || 0) * (0.6 + 0.4 * Math.cos((i / BANDS) * Math.PI)) - this.bands[i]) * 0.35;
      }
    }
  }

  /** Stream activity (a real delta arrived): one small blue pulse, at most every 250 ms. */
  pulseActivity() {
    if (this.reduced || this.t - this.lastAct < 0.25) return;
    this.lastAct = this.t;
    this._pulse(false, 0.55);
  }

  /** Hands-free wake word: every ribbon gets a pulse and one ripple expands. */
  wake() {
    this.wakeAt = this.t;
    if (!this.reduced) for (let i = 0; i < this.ribbons.length; i++) this._pulse(false, 0.9, i);
  }

  setReduced(on) { this.reduced = !!on; }
  setQuality(q) { this.quality = q === 'low' ? 'low' : 'high'; this.resize(this.scale || 1); }

  /** scale: stage scale (window px per stage px). */
  resize(scale) {
    this.scale = scale;
    const dpr = window.devicePixelRatio || 1;
    const cap = this.quality === 'high' ? 2048 : 1100;
    const px = Math.max(256, Math.min(cap, Math.round(DESIGN * scale * (this.quality === 'high' ? Math.min(dpr, 2) : 1))));
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(px, px, false);
    this.shared.uPx.value = px / DESIGN;
  }

  _pulse(orange, strength, idx) {
    const rb = this.ribbons[idx ?? (this.pulseN++ % this.ribbons.length)];
    const slot = rb.slot++ % PULSES;
    rb.pulses[slot].set(this.rand(), strength, orange ? 1 : 0, 0);
  }

  /** bootK: 0..1 while the boot sequence builds the reactor, 1 otherwise. */
  frame(now, dt, bootK = 1) {
    if (this.lost) return;
    const I = this.intro;
    if (I) bootK = I.glow;
    const tgt = holoTarget(this.state, this.level, { reduced: this.reduced });
    easeToward(this.cur, tgt, dt, 2.6);
    const cur = this.cur;
    if (!this.reduced) this.t += dt;
    this.phase += dt * cur.speed * (1 + (I ? I.spin : 0));
    this.shared.uTime.value = this.t;

    // timed pulses while processing; every fourth is orange
    if (tgt.pulse > 0) {
      this.pulseClock -= dt;
      if (this.pulseClock <= 0) {
        this.pulseClock = tgt.pulse;
        this._pulse(this.pulseN % 4 === 3, 1);
      }
    }
    for (const rb of this.ribbons) {
      for (const p of rb.pulses) {
        if (p.y <= 0) continue;
        if (this.reduced) { p.y = 0; continue; }
        p.x = (p.x + dt * 0.32 * Math.max(0.6, cur.speed)) % 1;
        p.y = Math.max(0, p.y - dt * 0.42);
      }
    }

    const breath = this.reduced ? 1 : 1 + 0.07 * Math.sin((this.t / 5) * TAU);
    const glow = cur.glow * breath * bootK;
    const wakeP = (this.t - this.wakeAt) / 0.9;
    const wakeK = wakeP >= 0 && wakeP < 1 ? Math.sin(Math.PI * wakeP) * 0.35 : 0;

    // ribbons spin on their own axes; the whole structure sways a little for depth
    this.ribbons.forEach((rb, i) => {
      rb.mesh.rotation.z = this.phase * rb.def.spin * 1.6;
      const u = rb.mat.uniforms;
      u.uGlow.value = glow * (0.9 + wakeK) * (i === 4 ? 0.7 : 1);
      u.uOrange.value = I ? Math.max(cur.orange, I.warm * 0.85) : cur.orange;
      u.uDraw.value = I ? I.draw * 1.02 : 2;
    });
    this.cluster.rotation.y = 0.28 * Math.sin(this.phase * 0.05) + this.phase * 0.012;
    this.cluster.rotation.x = 0.1 * Math.sin(this.phase * 0.037);

    for (const o of this.orbits) {
      o.line.rotation.z += dt * cur.speed * 0.01 * (o.def.head >= 0 ? 1 : -1);
      const u = o.mat.uniforms;
      u.uHead.value = (u.uHead.value + dt * cur.speed * o.def.head + 1) % 1;
      u.uAlpha.value = o.def.a * Math.min(1.4, glow + 0.2);
      u.uHeadA.value = o.def.head ? 0.85 * bootK * Math.min(1, cur.glow + 0.2) : 0;
    }
    this.shared.uDrawL.value = I ? I.orbits[0] : 2;
    this.ticks.rotation.z = -this.phase * 0.004;
    this.ticksMat.uniforms.uAlpha.value = 0.09 * bootK;

    this.partMat.uniforms.uPhase.value = this.phase * (0.035 + cur.swarm * 0.05);
    this.partMat.uniforms.uPush.value = cur.swarm * (0.4 + cur.level * 1.6);
    this.partMat.uniforms.uGlow.value = Math.min(1.2, glow * 0.85 + wakeK);
    this.partMat.uniforms.uOrangeShare.value = I ? Math.max(cur.orange, I.warm) : cur.orange;
    this.partMat.uniforms.uGather.value = I ? I.gather : 1;

    // voice: strands stream outward with the real spectrum; each syllable onset fires a ribbon pulse
    const lv = tgt.level;
    this.voice += (lv - this.voice) * Math.min(1, dt * 10);
    if (!this.reduced) this.voiceFlow += dt * (2.2 + this.voice * 7);
    if (cur.wave > 0.2 && !this.reduced && lv - this.lvSlow > 0.07 && this.t - this.lastOnset > 0.16) {
      this.lastOnset = this.t;
      this._pulse(this.onsetN++ % 5 === 4, 0.45 + lv * 0.6);
    }
    this.lvSlow += (lv - this.lvSlow) * Math.min(1, dt * 3);
    for (const s of this.strands) {
      const u = s.mat.uniforms;
      u.uLevel.value = this.voice;
      u.uFlow.value = this.voiceFlow;
      u.uAlpha.value = cur.wave * s.d.a * bootK * (0.45 + this.voice * 1.1);
    }

    const rp = (this.t - this.wakeAt) / 1.1;
    if (rp >= 0 && rp < 1) {
      const q = 1 - Math.pow(1 - rp, 3);
      this.ripple.scale.setScalar(0.55 + q * 1.1);
      this.rippleMat.uniforms.uAlpha.value = 0.55 * (1 - rp);
    } else this.rippleMat.uniforms.uAlpha.value = 0;

    for (const s of this.streaks) {
      s.mat.uniforms.uAlpha.value = s.a * Math.min(1.2, glow + 0.25) * (I ? Math.min(1, I.glow) : 1);
      s.mat.uniforms.uOrange.value = s.noOrange ? 0 : 0.6 + cur.orange + (I ? I.warm * 0.8 : 0);
    }
    this.vguide.mat.uniforms.uAlpha.value = this.vguide.a * bootK;
    this.flareMat.uniforms.uAlpha.value = Math.min(1, glow * 0.9 + wakeK);
    this.flareMat.uniforms.uBreath.value = this.reduced ? 0 : 1;

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/** Throws when WebGL is unavailable (the caller keeps the 2D reactor). */
export function createHoloCore(canvas, opts) {
  return new HoloCore(canvas, opts);
}

// ---------- boot intro: the star field (galaxy → JARVIS) ----------
// One Points object; every star morphs from its galaxy position to its role target. The math is
// the same as starPos() in renderer/ui/calm-intro-stars.js (the reference, also the 2D fallback).
// Positions are in stage px relative to the core centre; the clip space maps 1920 x 1080 stage px.
const STAR_VS = /* glsl */`
attribute vec3 aG;
attribute vec3 aT;
attribute vec4 aS; // role, seed, size, radius 0..1
uniform vec4 uM, uFade;
uniform float uFadeSat, uGform, uGcol, uAngle, uZoom, uPx, uTime;
uniform vec2 uSat[8];
varying vec4 vCol;
float mm(float m, float s) {
  float x = clamp(m * 1.5 - s * 0.5, 0.0, 1.0);
  return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0;
}
void main() {
  float role = aS.x, seed = aS.y, rn = aS.w;
  float m = role < 0.5 ? uM.x : role < 1.5 ? uM.y : role < 2.5 ? uM.z : role < 3.5 ? 0.0 : uM.w;
  float fade = role < 0.5 ? uFade.x : role < 1.5 ? uFade.y : role < 2.5 ? uFade.z : role < 3.5 ? uFade.w : uFadeSat;
  float sc = (role > 1.5 && role < 3.5) ? 1.0 - 0.88 * uGcol : 1.0;
  float a = uAngle * (1.5 - 1.1 * rn);
  float ca = cos(a), sa = sin(a);
  vec2 gxy = vec2(aG.x * ca - aG.y * sa, aG.x * sa + aG.y * ca) * sc;
  float gz = aG.z * sc;
  float y2 = gxy.y * cos(1.0) - gz * sin(1.0);
  float z2 = gxy.y * sin(1.0) + gz * cos(1.0);
  vec2 r2 = vec2(gxy.x * cos(-0.22) - y2 * sin(-0.22), gxy.x * sin(-0.22) + y2 * cos(-0.22));
  float k = 2600.0 / (2600.0 - z2);
  vec2 gs = r2 * k * uZoom;
  vec2 tp = aT.xy;
  if (role > 3.5) {
    int idx = int(aT.z + 0.5);
    for (int i = 0; i < 8; i++) if (i == idx) tp = uSat[i];
  }
  float e = mm(m, seed);
  vec2 d = tp - gs;
  float bow = (0.12 + 0.2 * seed) * sin(3.14159265 * e);
  vec2 p = gs + d * e + vec2(-d.y, d.x) * bow;
  gl_Position = vec4(p.x / 960.0, -p.y / 540.0, 0.0, 1.0);
  float cp = fract(seed * 7.31);
  float orange = (cp < 0.05 || (rn < 0.1 && cp < 0.2)) ? 1.0 : 0.0;
  vec3 col = mix(vec3(0.44, 0.87, 1.0), vec3(0.13, 0.72, 1.0), fract(seed * 3.7));
  if (cp > 0.55 && cp < 0.7) col = vec3(0.7, 0.85, 1.0);
  if (orange > 0.5) col = vec3(1.0, 0.61, 0.27);
  float tw = 0.7 + 0.3 * sin(seed * 60.0);
  float alpha = fade * min(1.0, uGform * 2.0) * tw * (role > 3.5 ? 1.0 : 1.25) * (1.0 + 0.9 * (1.0 - rn));
  vCol = vec4(col, alpha);
  gl_PointSize = aS.z * uPx * (0.7 + 0.3 * k);
}`;
const DEEP_VS = /* glsl */`
attribute vec3 aD; // x, y, layer
uniform float uDeep, uZoom, uPx, uTime;
varying vec4 vCol;
void main() {
  float layer = aD.z;
  float sp = 3.0 + layer * 6.0;
  float x = mod(aD.x + 1000.0 + uTime * sp, 2000.0) - 1000.0;
  vec2 p = vec2(x, aD.y) * (1.0 + (uZoom - 1.0) * (0.15 + layer * 0.3));
  gl_Position = vec4(p.x / 960.0, -p.y / 540.0, 0.0, 1.0);
  float tw = 0.6 + 0.4 * sin(uTime * (0.6 + layer * 0.5) + aD.x * 0.37);
  vCol = vec4(0.62, 0.82, 1.0, uDeep * tw * (0.35 + 0.2 * layer));
  gl_PointSize = (1.0 + layer * 0.8) * uPx;
}`;
const STAR_FS = /* glsl */`
varying vec4 vCol;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  gl_FragColor = vec4(vCol.rgb * a * vCol.a, a * vCol.a);
}`;

class IntroStars {
  /** @param {{ stars: object, deep: object, quality?: string }} o  data from ui/calm-intro-stars.js */
  constructor(canvas, { stars, deep, quality = 'high' }) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(); // unused: the shaders write clip space directly
    const n = quality === 'low' ? Math.min(stars.n, 3500) : stars.n;
    const g = new BufferGeometry();
    const aS = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) aS.set([stars.role[i], stars.seed[i], stars.size[i], stars.rn[i]], i * 4);
    g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aG', new BufferAttribute(stars.g.slice(0, n * 3), 3));
    g.setAttribute('aT', new BufferAttribute(stars.t.slice(0, n * 3), 3));
    g.setAttribute('aS', new BufferAttribute(aS, 4));
    this.u = {
      uM: { value: new Vector4() }, uFade: { value: new Vector4(1, 1, 1, 1) }, uFadeSat: { value: 1 },
      uGform: { value: 0 }, uGcol: { value: 0 }, uAngle: { value: 0 }, uZoom: { value: 1 },
      uPx: { value: 1 }, uTime: { value: 0 }, uDeep: { value: 0 },
      uSat: { value: Array.from({ length: 8 }, () => new Vector2()) },
    };
    this.mat = additive({ vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: this.u });
    this.points = new Points(g, this.mat);
    this.points.frustumCulled = false;
    const gd = new BufferGeometry();
    gd.setAttribute('position', new BufferAttribute(new Float32Array(deep.n * 3), 3));
    gd.setAttribute('aD', new BufferAttribute(deep.pos, 3));
    this.deepMat = additive({ vertexShader: DEEP_VS, fragmentShader: STAR_FS, uniforms: { uDeep: this.u.uDeep, uZoom: this.u.uZoom, uPx: this.u.uPx, uTime: this.u.uTime } });
    this.deepPoints = new Points(gd, this.deepMat);
    this.deepPoints.frustumCulled = false;
    this.scene.add(this.deepPoints, this.points);
    this.lost = false;
    this._onLost = (e) => { e.preventDefault(); this.lost = true; };
    canvas.addEventListener('webglcontextlost', this._onLost);
  }

  /** scale: stage px → window px. */
  resize(scale) {
    const k = Math.max(0.5, Math.min(2, scale * Math.min(window.devicePixelRatio || 1, 2)));
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(Math.round(1920 * k), Math.round(1080 * k), false);
    this.u.uPx.value = k;
  }

  /** f: intro frame, angle: galaxy rotation, sat: live satellite slots [x0, y0, x1, y1, …] relative to the core. */
  frame(f, angle, sec, sat) {
    if (this.lost) return;
    const u = this.u;
    u.uM.value.set(f.coreM, f.orbitM, f.letM, f.satM);
    u.uFade.value.set(f.fCore, f.fOrbit, f.fLet, f.dust);
    u.uFadeSat.value = f.fSat;
    u.uGform.value = f.gform;
    u.uGcol.value = f.gcol;
    u.uAngle.value = angle;
    u.uZoom.value = f.zoom;
    u.uDeep.value = f.deep;
    u.uTime.value = sec;
    for (let i = 0; i < 8; i++) u.uSat.value[i].set(sat[i * 2], sat[i * 2 + 1]);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    for (const o of [this.points, this.deepPoints]) { o.geometry.dispose(); o.material.dispose(); }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/** Throws when WebGL is unavailable (the intro then draws the same morph in 2D). */
export function createIntroStars(canvas, opts) {
  return new IntroStars(canvas, opts);
}
