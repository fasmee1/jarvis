// Lightweight 3D map for the Result Viewer (map + weather radar), on MapLibre GL.
// Loaded lazily: the ~1 MB library is only imported the first time a map opens.
// Starts flat (cheap); 3D adds building extrusions + terrain and tilts the camera.
// Satellite mode drapes real-colour aerial imagery under the labels and 3D buildings.
// Sources need no API key: OpenFreeMap vector tiles, AWS terrarium DEM, Esri imagery, RainViewer radar.
// Any failure (no WebGL, offline, style error) rejects so callers can fall back.

const LIB_DIR = new URL('../../node_modules/maplibre-gl/dist/', import.meta.url).href;
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// Esri World Imagery: real-colour aerial photos, no key (attribution required).
const SAT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SAT_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics';
const RADAR_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
const LOAD_TIMEOUT_MS = 10000;
const PITCH_3D = 55;

let libPromise = null;

function loadLib() {
  if (!libPromise) {
    libPromise = (async () => {
      if (!document.querySelector('link[data-maplibre]')) {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = `${LIB_DIR}maplibre-gl.css`;
        css.dataset.maplibre = '1';
        document.head.append(css);
      }
      const lib = await import(`${LIB_DIR}maplibre-gl.mjs`);
      // import.meta.url inside the library is app://, which it can't resolve a worker from.
      lib.setWorkerUrl(`${LIB_DIR}maplibre-gl-worker.mjs`);
      return lib;
    })();
    libPromise.catch(() => { libPromise = null; });
  }
  return libPromise;
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Latest past radar frame → raster tile template, or null. */
async function radarTiles() {
  const res = await fetch(RADAR_INDEX);
  if (!res.ok) return null;
  const j = await res.json();
  const past = (j.radar && j.radar.past) || [];
  const last = past[past.length - 1];
  if (!last || !j.host) return null;
  return `${j.host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`;
}

function addBuildings(map) {
  const style = map.getStyle();
  const existing = style.layers.filter((l) => l.type === 'fill-extrusion').map((l) => l.id);
  if (existing.length) return existing;
  const src = Object.keys(style.sources).find((k) => style.sources[k].type === 'vector');
  if (!src) return [];
  const before = style.layers.find((l) => l.type === 'symbol');
  map.addLayer({
    id: 'jv-buildings-3d',
    type: 'fill-extrusion',
    source: src,
    'source-layer': 'building',
    minzoom: 14,
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': '#9fb4c4',
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.85,
    },
  }, before && before.id);
  return ['jv-buildings-3d'];
}

/**
 * Mount a map in `el`. Resolves once the style has loaded:
 *   { toggle3D(on?) → boolean, is3D(), toggleSatellite(on?) → boolean, isSatellite(), resize(), center() → {lat, lon}, dispose() }
 * opts: { lat, lon, zoom?, view3d?, satellite?, radar?, interactive? }
 */
export async function createMap3D(el, opts) {
  if (!webglAvailable()) throw new Error('webgl unavailable');
  const lib = await loadLib();
  const map = new lib.Map({
    container: el,
    style: STYLE_URL,
    center: [opts.lon, opts.lat],
    zoom: opts.zoom || 14,
    maxPitch: 60,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
    fadeDuration: 0,
    canvasContextAttributes: { antialias: false, powerPreference: 'low-power' },
    attributionControl: { compact: true },
    interactive: opts.interactive !== false,
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('map load timeout')), LOAD_TIMEOUT_MS);
      map.once('load', () => { clearTimeout(timer); resolve(); });
      map.once('error', (e) => { if (!map.loaded()) { clearTimeout(timer); reject(e.error || new Error('map error')); } });
    });
  } catch (err) {
    map.remove();
    throw err;
  }

  new lib.Marker({ color: '#00d8ff' }).setLngLat([opts.lon, opts.lat]).addTo(map);
  if (opts.interactive !== false) map.addControl(new lib.NavigationControl({ visualizePitch: true }), 'top-right');

  const buildings = addBuildings(map);
  map.addSource('jv-dem', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 });

  let on3D = false;
  const toggle3D = (want = !on3D) => {
    on3D = !!want;
    for (const id of buildings) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on3D ? 'visible' : 'none');
    map.setTerrain(on3D ? { source: 'jv-dem', exaggeration: 1.3 } : null);
    map.easeTo({ pitch: on3D ? PITCH_3D : 0, bearing: on3D ? -20 : 0, duration: 800 });
    return on3D;
  };
  // Hide any extrusions the style ships with until 3D is asked for.
  for (const id of buildings) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');

  // Satellite imagery sits above the vector fills but below labels and buildings.
  const firstSymbol = () => (map.getStyle().layers.find((l) => l.type === 'symbol') || {}).id;
  map.addSource('jv-sat', { type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 19, attribution: SAT_ATTRIBUTION });
  map.addLayer({ id: 'jv-sat', type: 'raster', source: 'jv-sat', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } }, firstSymbol());
  for (const id of buildings) if (map.getLayer(id)) map.moveLayer(id, firstSymbol());
  const paintOf = (id) => ({ color: map.getPaintProperty(id, 'fill-extrusion-color'), opacity: map.getPaintProperty(id, 'fill-extrusion-opacity') });
  const origPaint = new Map(buildings.filter((id) => map.getLayer(id)).map((id) => [id, paintOf(id)]));
  let onSat = false;
  const toggleSatellite = (want = !onSat) => {
    onSat = !!want;
    map.setLayoutProperty('jv-sat', 'visibility', onSat ? 'visible' : 'none');
    // Translucent warm-grey blocks let the photo's colours show through the buildings.
    for (const [id, p] of origPaint) {
      map.setPaintProperty(id, 'fill-extrusion-color', onSat ? '#d9d3c7' : p.color);
      map.setPaintProperty(id, 'fill-extrusion-opacity', onSat ? 0.6 : p.opacity);
    }
    return onSat;
  };

  if (opts.view3d) toggle3D(true);
  if (opts.satellite) toggleSatellite(true);

  if (opts.radar) {
    radarTiles().then((tiles) => {
      if (!tiles || !map.getStyle()) return;
      map.addSource('jv-radar', { type: 'raster', tiles: [tiles], tileSize: 256, maxzoom: 7 });
      map.addLayer({ id: 'jv-radar', type: 'raster', source: 'jv-radar', paint: { 'raster-opacity': 0.7 } });
    }).catch(() => { /* radar is optional */ });
  }

  return {
    toggle3D,
    is3D: () => on3D,
    toggleSatellite,
    isSatellite: () => onSat,
    resize: () => map.resize(),
    center: () => { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; },
    dispose: () => { try { map.remove(); } catch { /* already gone */ } },
  };
}
