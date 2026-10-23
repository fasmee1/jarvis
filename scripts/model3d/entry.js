// Source of renderer/ui/vendor/model3d.min.js (bundled by scripts/build-model3d.js).
// Orbit viewer for a "model" Result Viewer payload: a list of simple parts
// (box, cylinder, sphere, torus, cone, capsule, extrude) that Claude describes as JSON.
// Drag to orbit, wheel to zoom, right-drag to pan. Draws only while something moves.

import {
  WebGLRenderer, Scene, PerspectiveCamera, Mesh, MeshStandardMaterial, Group, Color, Box3, Vector3,
  BoxGeometry, CylinderGeometry, SphereGeometry, TorusGeometry, ConeGeometry, CapsuleGeometry,
  ExtrudeGeometry, Shape, Path, Vector2, MathUtils, PMREMGenerator, GridHelper, DirectionalLight, ACESFilmicToneMapping,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const MAX_PARTS = 300;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec3 = (v, d) => (Array.isArray(v) ? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])] : d);
const pts = (a) => (Array.isArray(a) ? a.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => new Vector2(p[0], p[1])) : []);

function geometryFor(p) {
  const size = vec3(p.size, [1, 1, 1]);
  switch (p.shape) {
    case 'box':
      return p.radius > 0
        ? new RoundedBoxGeometry(size[0], size[1], size[2], 4, Math.min(num(p.radius, 0), Math.min(...size) / 2))
        : new BoxGeometry(size[0], size[1], size[2]);
    case 'cylinder': return new CylinderGeometry(num(p.radiusTop, num(p.radius, 0.5)), num(p.radius, 0.5), num(p.height, 1), 48);
    case 'cone': return new ConeGeometry(num(p.radius, 0.5), num(p.height, 1), 48);
    case 'sphere': return new SphereGeometry(num(p.radius, 0.5), 48, 32);
    case 'torus': return new TorusGeometry(num(p.radius, 0.5), num(p.tube, 0.1), 24, 64);
    case 'capsule': return new CapsuleGeometry(num(p.radius, 0.25), num(p.length, 1), 8, 24);
    case 'extrude': {
      const outline = pts(p.points);
      if (outline.length < 3) return null;
      const shape = new Shape(outline);
      for (const hole of Array.isArray(p.holes) ? p.holes : []) {
        if (hole && typeof hole === 'object' && !Array.isArray(hole)) {
          const path = new Path();
          path.absarc(num(hole.cx, 0), num(hole.cy, 0), Math.max(0.001, num(hole.r, 0.5)), 0, Math.PI * 2, true);
          shape.holes.push(path);
        } else {
          const hp = pts(hole);
          if (hp.length >= 3) shape.holes.push(new Path(hp));
        }
      }
      const bevel = Math.max(0, num(p.bevel, 0));
      return new ExtrudeGeometry(shape, {
        depth: Math.max(0.001, num(p.depth, 1)), bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 32,
      });
    }
    default: return null;
  }
}

function buildModel(spec) {
  const group = new Group();
  for (const p of (Array.isArray(spec.parts) ? spec.parts : []).slice(0, MAX_PARTS)) {
    if (!p || typeof p !== 'object') continue;
    const geo = geometryFor(p);
    if (!geo) continue;
    const color = typeof p.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : '#9aa7b4';
    const emissive = typeof p.emissive === 'string' && /^#[0-9a-f]{3,8}$/i.test(p.emissive) ? p.emissive : '#000000';
    const mat = new MeshStandardMaterial({
      color: new Color(color), emissive: new Color(emissive), emissiveIntensity: emissive === '#000000' ? 0 : 1.2,
      metalness: MathUtils.clamp(num(p.metalness, 0.3), 0, 1), roughness: MathUtils.clamp(num(p.roughness, 0.5), 0, 1),
      transparent: num(p.opacity, 1) < 1, opacity: MathUtils.clamp(num(p.opacity, 1), 0.05, 1),
    });
    const mesh = new Mesh(geo, mat);
    const pos = vec3(p.position, [0, 0, 0]);
    const rot = vec3(p.rotation, [0, 0, 0]);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.rotation.set(MathUtils.degToRad(rot[0]), MathUtils.degToRad(rot[1]), MathUtils.degToRad(rot[2]));
    group.add(mesh);
  }
  return group;
}

// A glb is only loaded from this app's own origin or a blob: URL (the CSP blocks other hosts anyway).
function glbUrl(src) {
  if (typeof src !== 'string' || !src) return null;
  try {
    const u = new URL(src, window.location.href);
    return u.protocol === 'blob:' || u.origin === window.location.origin ? u.href : null;
  } catch { return null; }
}

function loadGlb(url) {
  const draco = new DRACOLoader().setDecoderPath(new URL('./draco/', import.meta.url).href);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  return loader.loadAsync(url).finally(() => draco.dispose()).then((gltf) => gltf.scene);
}

export function createModelViewer(container, spec) {
  const glb = glbUrl(spec.glb);
  if (spec.glb && !glb) throw new Error('glb url not allowed');
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  container.append(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color('#0b1118');
  const pmrem = new PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  const sun = new DirectionalLight('#ffffff', 1.4);
  sun.position.set(3, 5, 4);
  scene.add(sun);

  const camera = new PerspectiveCamera(40, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = spec.autoRotate !== false;
  controls.autoRotateSpeed = 1.6;
  renderer.domElement.addEventListener('pointerdown', () => { controls.autoRotate = false; });

  let radius = 1;
  let grid = null;
  // Centre the model on the origin, then size the grid, camera and zoom limits to it.
  const frameModel = (model) => {
    const box = new Box3().setFromObject(model);
    const center = box.getCenter(new Vector3());
    radius = Math.max(0.001, box.getSize(new Vector3()).length() / 2);
    model.position.sub(center); // so orbiting pivots on the model
    if (grid) { scene.remove(grid); grid.dispose(); }
    grid = new GridHelper(radius * 5, 20, '#1d4a5c', '#14303c');
    grid.position.y = -(box.max.y - box.min.y) / 2 - radius * 0.02;
    scene.add(grid);
    camera.near = radius / 50;
    camera.far = radius * 60;
    camera.updateProjectionMatrix();
    controls.minDistance = radius * 0.4;
    controls.maxDistance = radius * 12;
    camera.position.set(radius * 1.6, radius * 1.1, radius * 2.2);
    controls.target.set(0, 0, 0);
    controls.update();
  };

  let alive = true;
  if (glb) {
    loadGlb(glb).then((model) => {
      if (!alive) return;
      scene.add(model);
      frameModel(model);
      if (spec.onLoaded) spec.onLoaded();
    }).catch((err) => { if (alive && spec.onError) spec.onError(err); });
  } else {
    const model = buildModel(spec);
    if (!model.children.length) throw new Error('no drawable parts');
    scene.add(model);
    frameModel(model);
  }

  let visible = true;
  let raf = 0;
  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const frame = () => {
    raf = 0;
    if (!alive || !visible) return;
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  frame();

  return {
    setAutoRotate: (on) => { controls.autoRotate = !!on; },
    isAutoRotating: () => controls.autoRotate,
    resetView: () => { camera.position.set(radius * 1.6, radius * 1.1, radius * 2.2); controls.target.set(0, 0, 0); controls.update(); },
    pause: () => { visible = false; },
    resume: () => { if (!visible) { visible = true; if (!raf) frame(); } },
    dispose: () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
