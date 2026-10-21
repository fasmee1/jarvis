// Source of renderer/ui/vendor/earth3d.min.js (bundled by scripts/build-earth3d.js).
// Google Photorealistic 3D Tiles ("Google Earth" mode) on three.js + 3d-tiles-renderer,
// tuned for a light machine:
//  - Google's recommended level of detail (errorTarget 20) and a capped tile cache (~300 MB)
//  - pixel ratio 1, no antialias, low-power GPU hint
//  - draws only when the camera moves or a tile arrives; stops while hidden
// The page passes the Draco decoder folder (vendor/draco/) and one credential:
//  - apiKey: a Google Maps Platform key (Map Tiles API), or
//  - ionToken: a Cesium ion token — ion serves the same Google tiles (asset 2275207),
//    and its free Community plan needs no credit card.

import { WebGLRenderer, Scene, PerspectiveCamera, Matrix4, MathUtils } from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer, EnvironmentControls } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin,
  CesiumIonAuthPlugin,
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  UpdateOnChangePlugin,
  UnloadTilesPlugin,
  ReorientationPlugin,
} from '3d-tiles-renderer/plugins';

const ION_GOOGLE_ASSET = '2275207'; // "Google Photorealistic 3D Tiles" on Cesium ion

const QUALITY = {
  lite: { errorTarget: 20, maxBytes: 300 * 2 ** 20 },
  normal: { errorTarget: 20, maxBytes: 500 * 2 ** 20 },
};

/**
 * Mount Google 3D tiles in `el` looking at lat/lon (degrees).
 * opts: { apiKey | ionToken, lat, lon, height? (camera metres), dracoPath, quality?: 'lite'|'normal', onAttribution?(text), onError?(err) }
 * onError fires once if the root tileset can't load (bad key, API not enabled, offline).
 * Returns { resize(), pause(), resume(), dispose() }.
 */
export function createEarth3D(el, opts) {
  const q = QUALITY[opts.quality] || QUALITY.lite;
  const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x0b1118);
  el.append(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 1, 160000);
  const h = opts.height || 450;
  // oblique view (~30° above the horizon) so building walls show, like Google Earth tilted
  camera.position.set(0, h * 0.6, h * 1.05);
  camera.lookAt(0, 0, 0);

  const draco = new DRACOLoader().setDecoderPath(opts.dracoPath);
  const tiles = new TilesRenderer();
  if (opts.ionToken) tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: opts.ionToken, assetId: ION_GOOGLE_ASSET, autoRefreshToken: true }));
  else tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: opts.apiKey, autoRefreshToken: true }));
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new UpdateOnChangePlugin());
  tiles.registerPlugin(new UnloadTilesPlugin());
  tiles.registerPlugin(new ReorientationPlugin({ lat: opts.lat * MathUtils.DEG2RAD, lon: opts.lon * MathUtils.DEG2RAD, recenter: true }));
  tiles.errorTarget = q.errorTarget;
  tiles.lruCache.maxBytesSize = q.maxBytes;
  tiles.lruCache.minBytesSize = q.maxBytes * 0.6;
  tiles.setCamera(camera);
  scene.add(tiles.group);

  const controls = new EnvironmentControls(scene, camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 30;
  controls.maxAltitude = MathUtils.degToRad(85);

  let dirty = true;
  let running = true;
  let raf = 0;
  const lastCam = new Matrix4();
  const markDirty = () => { dirty = true; };
  tiles.addEventListener('needs-update', markDirty);
  tiles.addEventListener('needs-render', markDirty);
  tiles.addEventListener('load-model', markDirty);
  controls.addEventListener('change', markDirty);


  let lastAttr = '';
  const attribution = () => {
    if (!opts.onAttribution) return;
    const text = tiles.getAttributions().filter((a) => a.type === 'string').map((a) => a.value).join(' · ');
    if (text !== lastAttr) { lastAttr = text; opts.onAttribution(text); }
  };
  tiles.addEventListener('load-model', attribution);

  let rootLoaded = false;
  let failed = false;
  tiles.addEventListener('load-root-tileset', () => { rootLoaded = true; });
  tiles.addEventListener('load-error', (e) => {
    if (rootLoaded || failed || !opts.onError) return;
    failed = true;
    opts.onError(e.error || new Error('tileset load failed'));
  });

  const resize = () => {
    const w = el.clientWidth || 1;
    const hh = el.clientHeight || 1;
    renderer.setSize(w, hh);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
    tiles.setResolutionFromRenderer(camera, renderer);
    dirty = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();

  const frame = () => {
    raf = 0;
    if (!running) return;
    controls.update();
    camera.updateMatrixWorld();
    if (!camera.matrixWorld.equals(lastCam)) { lastCam.copy(camera.matrixWorld); dirty = true; }
    if (dirty) {
      dirty = false;
      tiles.update();
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    resize,
    pause: () => { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
    resume: () => { if (running) return; running = true; dirty = true; raf = requestAnimationFrame(frame); },
    dispose: () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      tiles.dispose();
      draco.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
