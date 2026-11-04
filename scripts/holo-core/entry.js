// Source of renderer/ui/vendor/holo-core.min.js (bundled by scripts/build-holo-core.js).
// Calm style reactor: a holographic energy core in WebGL. Overlapping transparent
// ribbons (fresnel edges, fine wires, speckle), thin orbital lines with travelling
// light points, a few thousand particles, an inner waveform ring and a horizontal
// light streak behind the J.A.R.V.I.S wordmark (the wordmark itself is HTML).
// Driven only by real app state + real audio (setState / setSignals / pulseActivity / wake);
// see renderer/ui/holo-state.js for the state → visual mapping.

import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, Points, LineLoop, LineSegments,
  BufferGeometry, BufferAttribute, PlaneGeometry, ShaderMaterial, AdditiveBlending, DoubleSide, Color, Vector4,
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
uniform float uTime, uGlow, uOrange, uOAt, uOW, uSeed, uCamZ;
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
uniform float uAlpha, uDash, uHead, uHeadA, uCamZ;
varying float vU;
varying float vDepth;
void main() {
  float a = uAlpha;
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
uniform float uTime, uPhase, uPush, uPx, uCamZ, uGlow;
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
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.55 + 0.45 * sin(uTime * aSeed.y + aSeed.w * 80.0);
  vA = tw * uGlow * mix(0.4, 1.0, smoothstep(-uCamZ - 1.6, -uCamZ + 1.2, mv.z));
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

// ---------- waveform ring (camera-facing) ----------
const WAVE_VS = /* glsl */`
attribute float aU;
uniform float uBands[${BANDS}];
uniform float uAmp, uTime, uR;
varying float vU;
void main() {
  vU = aU;
  float m = abs(aU * 2.0 - 1.0);                // mirrored left / right of 12 o'clock
  float f = m * ${BANDS - 1}.0;
  int i0 = int(floor(f));
  float b0 = 0.0, b1 = 0.0;
  for (int i = 0; i < ${BANDS}; i++) { if (i == i0) b0 = uBands[i]; if (i == i0 + 1) b1 = uBands[i]; }
  float band = mix(b0, b1, fract(f));
  float r = uR * (1.0 + uAmp * band * 0.16 + uAmp * 0.006 * sin(aU * 6.2831 * 24.0 + uTime * 3.0));
  float t = aU * 6.2831853 + 1.5707963;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(cos(t) * r, sin(t) * r, 0.0, 1.0);
}`;
const WAVE_FS = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
void main() { gl_FragColor = vec4(uColor * uAlpha, uAlpha); }`;

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
    this.lastAct = -1e9;
    this.wakeAt = -1e9;
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
    const shared = { uTime: { value: 0 }, uCamZ: { value: CAM_Z }, uPx: { value: 1 } };
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
          uGlow: { value: 0 }, uOrange: { value: 0 }, uOAt: { value: def.oAt }, uOW: { value: def.oW }, uSeed: { value: i * 17.3 },
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
          uCamZ: shared.uCamZ, uColor: { value: C.holo }, uHeadC: { value: i === 1 ? C.warm : C.cyan },
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
        uniforms: { uCamZ: shared.uCamZ, uColor: { value: C.holo }, uHeadC: { value: C.cyan }, uAlpha: { value: 0.1 }, uDash: { value: 0 }, uHead: { value: 0 }, uHeadA: { value: 0 } },
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
          uPhase: { value: 0 }, uPush: { value: 0 }, uGlow: { value: 0 }, uOrangeShare: { value: 0.3 },
          uBlue: { value: C.holo }, uCyan: { value: C.cyan }, uOrangeC: { value: C.warm },
        },
      });
      this.particles = new Points(g, this.partMat);
      this.cluster.add(this.particles);
    }

    // inner waveform: two thin loops following the real audio bands
    this.waves = [0.6, 0.63].map((R, i) => {
      const n = 256;
      const pos = new Float32Array(n * 3);
      const u = new Float32Array(n);
      for (let k = 0; k < n; k++) u[k] = k / n;
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('aU', new BufferAttribute(u, 1));
      g.boundingSphere = null;
      const mat = additive({
        vertexShader: WAVE_VS, fragmentShader: WAVE_FS,
        uniforms: { uBands: bandsU, uAmp: { value: i ? 0.7 : 1 }, uTime: shared.uTime, uR: { value: R }, uColor: { value: i ? C.holo : C.cyan }, uAlpha: { value: 0 } },
      });
      const line = new LineLoop(g, mat);
      line.frustumCulled = false;
      this.flat.add(line);
      return mat;
    });

    // wake ripple
    this.rippleMat = additive({
      vertexShader: LINE_VS, fragmentShader: LINE_FS,
      uniforms: { uCamZ: shared.uCamZ, uColor: { value: C.cyan }, uHeadC: { value: C.cyan }, uAlpha: { value: 0 }, uDash: { value: 0 }, uHead: { value: 0 }, uHeadA: { value: 0 } },
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
    const tgt = holoTarget(this.state, this.level, { reduced: this.reduced });
    easeToward(this.cur, tgt, dt, 2.6);
    const cur = this.cur;
    if (!this.reduced) this.t += dt;
    this.phase += dt * cur.speed;
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
      u.uOrange.value = cur.orange;
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
    this.ticks.rotation.z = -this.phase * 0.004;
    this.ticksMat.uniforms.uAlpha.value = 0.09 * bootK;

    this.partMat.uniforms.uPhase.value = this.phase * (0.035 + cur.swarm * 0.05);
    this.partMat.uniforms.uPush.value = cur.swarm * (0.4 + cur.level * 1.6);
    this.partMat.uniforms.uGlow.value = Math.min(1.2, glow * 0.85 + wakeK);
    this.partMat.uniforms.uOrangeShare.value = cur.orange;

    this.waves[0].uniforms.uAlpha.value = cur.wave * 0.55 * bootK;
    this.waves[1].uniforms.uAlpha.value = cur.wave * 0.28 * bootK;

    const rp = (this.t - this.wakeAt) / 1.1;
    if (rp >= 0 && rp < 1) {
      const q = 1 - Math.pow(1 - rp, 3);
      this.ripple.scale.setScalar(0.55 + q * 1.1);
      this.rippleMat.uniforms.uAlpha.value = 0.55 * (1 - rp);
    } else this.rippleMat.uniforms.uAlpha.value = 0;

    for (const s of this.streaks) {
      s.mat.uniforms.uAlpha.value = s.a * Math.min(1.2, glow + 0.25);
      s.mat.uniforms.uOrange.value = s.noOrange ? 0 : 0.6 + cur.orange;
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
