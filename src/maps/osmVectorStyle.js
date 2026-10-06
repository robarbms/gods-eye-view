import * as CesiumNS from 'cesium';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

/**
 * Client-side OpenMapTiles basemap styles for the OSM globe stack. Each style
 * rasterises OpenFreeMap vector tiles to a canvas per imagery tile, so the OSM
 * basemap can be re-styled without a keyed raster service. The three palettes
 * approximate the OpenMapTiles reference styles (Positron, Dark Matter, Fiord
 * Color); labels are intentionally omitted.
 */

export const OPENFREEMAP_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const OPENFREEMAP_ORIGIN = 'https://tiles.openfreemap.org';
export const OSM_VECTOR_CREDIT =
  '© OpenStreetMap contributors, © OpenMapTiles, OpenFreeMap';

export const DEFAULT_OSM_STYLE_ID = 'default';

/** Selectable OSM basemap styles. `default` keeps the plain raster OSM tiles. */
export const OSM_STYLES = Object.freeze([
  { id: 'default', label: 'Default' },
  { id: 'positron', label: 'Positron' },
  { id: 'dark', label: 'Dark' },
  { id: 'fiord', label: 'Fiord' },
]);

export const OSM_STYLE_IDS = Object.freeze(OSM_STYLES.map((style) => style.id));

/** Resolve a style id to its descriptor, falling back to the default. */
export function osmStylePreset(id) {
  return OSM_STYLES.find((style) => style.id === id) || OSM_STYLES[0];
}

/** Per-style colour palettes keyed by the style id (no palette for `default`). */
export const OSM_STYLE_PALETTES = Object.freeze({
  positron: {
    land: '#f5f5f3',
    water: '#c0d2dd',
    waterway: '#bcd0dc',
    wood: '#e3ebdd',
    grass: '#e8efe2',
    park: '#e3ecd9',
    farmland: '#f1efe4',
    sand: '#f3eedd',
    ice: '#eff5f7',
    rock: '#e6e4e0',
    wetland: '#e0e9e2',
    residential: '#efefed',
    commercial: '#f2ece6',
    industrial: '#ededed',
    building: '#e0e0dd',
    roadFill: '#ffffff',
    roadCasing: '#dcdbd7',
    railFill: '#d5d5d2',
    path: '#e6e1d8',
    boundary: '#c7c2cc',
  },
  dark: {
    land: '#0d1013',
    water: '#11212b',
    waterway: '#13242e',
    wood: '#0f1619',
    grass: '#111a1a',
    park: '#0f1a1b',
    farmland: '#13160f',
    sand: '#1a1915',
    ice: '#18222a',
    rock: '#15181b',
    wetland: '#101a1d',
    residential: '#141618',
    commercial: '#17161a',
    industrial: '#131313',
    building: '#1c1f23',
    roadFill: '#2d3036',
    roadCasing: '#0c0f12',
    railFill: '#262a2f',
    path: '#1f242a',
    boundary: '#333c47',
  },
  fiord: {
    land: '#29313d',
    water: '#1b2430',
    waterway: '#1d2733',
    wood: '#2d3a43',
    grass: '#303e48',
    park: '#32414f',
    farmland: '#2c3744',
    sand: '#3a3f3b',
    ice: '#36434d',
    rock: '#323a44',
    wetland: '#2a3740',
    residential: '#2d3744',
    commercial: '#313b48',
    industrial: '#2b3340',
    building: '#38475a',
    roadFill: '#61738a',
    roadCasing: '#1f2833',
    railFill: '#47596d',
    path: '#3b4a5b',
    boundary: '#4c6079',
  },
});

const ROAD_BASE_WIDTH = Object.freeze({
  motorway: 3.2,
  trunk: 2.8,
  primary: 2.3,
  secondary: 1.9,
  tertiary: 1.6,
  minor: 1.2,
  service: 0.9,
  track: 0.7,
  path: 0.6,
  pedestrian: 0.8,
  rail: 0.9,
  transit: 0.8,
});

const SKIPPED_ROAD_CLASSES = new Set(['ferry', 'aerialway', 'platform']);
const UNCASED_ROAD_CLASSES = new Set([
  'rail',
  'transit',
  'path',
  'track',
  'footway',
  'cycleway',
  'bridleway',
  'steps',
]);

function roadWidth(roadClass, zoom) {
  const base = ROAD_BASE_WIDTH[roadClass] ?? 1;
  const t = Math.max(0, Math.min(1, (zoom - 5) / 9));
  return base * (0.55 + 0.75 * t);
}

function roadColor(roadClass, palette) {
  if (roadClass === 'rail' || roadClass === 'transit') return palette.railFill;
  if (UNCASED_ROAD_CLASSES.has(roadClass)) return palette.path;
  return palette.roadFill;
}

function landcoverColor(properties, palette) {
  switch (properties.class) {
    case 'farmland':
      return palette.farmland;
    case 'ice':
      return palette.ice;
    case 'wood':
    case 'forest':
      return palette.wood;
    case 'wetland':
      return palette.wetland;
    case 'sand':
      return palette.sand;
    case 'rock':
      return palette.rock;
    case 'grass':
    case 'meadow':
    case 'grassland':
      return palette.grass;
    default:
      return palette.grass;
  }
}

function landuseColor(properties, palette) {
  switch (properties.class) {
    case 'residential':
    case 'suburb':
    case 'neighbourhood':
    case 'quarter':
      return palette.residential;
    case 'commercial':
    case 'retail':
      return palette.commercial;
    case 'industrial':
    case 'garages':
    case 'railway':
      return palette.industrial;
    case 'cemetery':
    case 'park':
    case 'recreation_ground':
    case 'playground':
    case 'pitch':
    case 'stadium':
    case 'golf_course':
    case 'dog_park':
    case 'garden':
      return palette.park;
    case 'wood':
    case 'forest':
      return palette.wood;
    case 'grass':
    case 'meadow':
    case 'village_green':
      return palette.grass;
    case 'farmland':
      return palette.farmland;
    default:
      return null;
  }
}

function tracePath(ctx, points, scale) {
  if (!points.length) return;
  ctx.moveTo(points[0].x * scale, points[0].y * scale);
  for (let i = 1; i < points.length; i++)
    ctx.lineTo(points[i].x * scale, points[i].y * scale);
}

function fillPolygonLayer(ctx, layer, tileSize, colorFor) {
  const scale = tileSize / layer.extent;
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const color = colorFor(feature.properties);
    if (!color) continue;
    ctx.beginPath();
    for (const ring of feature.loadGeometry()) tracePath(ctx, ring, scale);
    ctx.fillStyle = color;
    ctx.fill('evenodd');
  }
}

function strokeLineLayer(ctx, layer, tileSize, { colorFor, widthFor, filter }) {
  const scale = tileSize / layer.extent;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (filter && !filter(feature.properties)) continue;
    const color = colorFor(feature.properties);
    if (!color) continue;
    ctx.beginPath();
    for (const line of feature.loadGeometry()) tracePath(ctx, line, scale);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.2, widthFor(feature.properties));
    ctx.stroke();
  }
}

function drawRoads(ctx, layer, tileSize, zoom, palette) {
  const scale = tileSize / layer.extent;
  const roads = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const roadClass = feature.properties.class;
    if (SKIPPED_ROAD_CLASSES.has(roadClass)) continue;
    roads.push({
      roadClass,
      geom: feature.loadGeometry(),
      width: roadWidth(roadClass, zoom),
    });
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Casing under every motor road so fills read as outlined ribbons.
  ctx.strokeStyle = palette.roadCasing;
  for (const road of roads) {
    if (UNCASED_ROAD_CLASSES.has(road.roadClass)) continue;
    ctx.beginPath();
    for (const line of road.geom) tracePath(ctx, line, scale);
    ctx.lineWidth = road.width + 1.6;
    ctx.stroke();
  }
  for (const road of roads) {
    ctx.beginPath();
    for (const line of road.geom) tracePath(ctx, line, scale);
    ctx.strokeStyle = roadColor(road.roadClass, palette);
    ctx.lineWidth = Math.max(0.2, road.width);
    ctx.stroke();
  }
}

/**
 * Paint one decoded OpenMapTiles vector tile onto a 2D context using a palette.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('@mapbox/vector-tile').VectorTile} vectorTile
 * @param {{ palette: object, tileSize: number, zoom: number }} options
 */
export function drawOsmVectorTile(
  ctx,
  vectorTile,
  { palette, tileSize, zoom },
) {
  ctx.fillStyle = palette.land;
  ctx.fillRect(0, 0, tileSize, tileSize);
  const layers = vectorTile.layers || {};
  if (layers.landcover)
    fillPolygonLayer(ctx, layers.landcover, tileSize, (p) =>
      landcoverColor(p, palette),
    );
  if (layers.landuse)
    fillPolygonLayer(ctx, layers.landuse, tileSize, (p) =>
      landuseColor(p, palette),
    );
  if (layers.park)
    fillPolygonLayer(ctx, layers.park, tileSize, () => palette.park);
  if (layers.water)
    fillPolygonLayer(ctx, layers.water, tileSize, () => palette.water);
  if (layers.waterway)
    strokeLineLayer(ctx, layers.waterway, tileSize, {
      colorFor: () => palette.waterway,
      widthFor: (p) => (p.class === 'river' ? 1.1 : 0.6),
    });
  if (zoom >= 14 && layers.building)
    fillPolygonLayer(ctx, layers.building, tileSize, () => palette.building);
  if (layers.transportation)
    drawRoads(ctx, layers.transportation, tileSize, zoom, palette);
  if (layers.boundary)
    strokeLineLayer(ctx, layers.boundary, tileSize, {
      colorFor: () => palette.boundary,
      widthFor: () => 0.7,
      filter: (p) =>
        Number(p.admin_level) <= 6 && p.maritime !== 1 && p.maritime !== true,
    });
}

/**
 * Lazily resolve the current OpenFreeMap tile URL template. The planet TileJSON
 * carries a dated path, so the template cannot be hard-coded; it is fetched once
 * and memoised, and the resolved origin is pinned to OpenFreeMap.
 */
function createTemplateResolver(fetchImpl, tileJsonUrl) {
  let pending = null;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const response = await fetchImpl(tileJsonUrl, { redirect: 'error' });
      if (!response.ok)
        throw new Error(`TileJSON unavailable (HTTP ${response.status})`);
      const json = await response.json();
      const url = json?.tiles?.[0];
      if (
        typeof url !== 'string' ||
        !['{z}', '{x}', '{y}'].every((token) => url.includes(token))
      )
        throw new Error('Invalid OpenFreeMap TileJSON');
      const probe = new URL(
        url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'),
        OPENFREEMAP_ORIGIN,
      );
      if (probe.origin !== OPENFREEMAP_ORIGIN)
        throw new Error('Invalid OpenFreeMap tile origin');
      return url;
    })().catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

/**
 * Build a Cesium-compatible imagery provider that renders an OpenMapTiles vector
 * style to raster tiles. Mirrors the duck-typed provider shape used elsewhere in
 * the app (see `src/layers/weather/rasterTiles.js`); tiles are fetched lazily by
 * `requestImage` and a fetch/decode failure degrades to a flat land-colour tile.
 * @returns {object} A Cesium `ImageryProvider`-shaped object.
 */
export function createOsmVectorStyleImagery({
  styleId,
  cesium = CesiumNS,
  fetchImpl = (...args) => globalThis.fetch(...args),
  createCanvas = () => document.createElement('canvas'),
  tileJsonUrl = OPENFREEMAP_TILEJSON_URL,
  tileSize = 256,
  maximumLevel = 14,
  credit = OSM_VECTOR_CREDIT,
} = {}) {
  const preset = osmStylePreset(styleId);
  const palette = OSM_STYLE_PALETTES[preset.id];
  if (!palette)
    throw new Error(`No vector palette for OSM style: ${String(styleId)}`);
  const tilingScheme = new cesium.WebMercatorTilingScheme();
  const resolveTemplate = createTemplateResolver(fetchImpl, tileJsonUrl);
  return {
    tilingScheme,
    rectangle: tilingScheme.rectangle,
    tileWidth: tileSize,
    tileHeight: tileSize,
    minimumLevel: 0,
    maximumLevel,
    ready: true,
    tileDiscardPolicy: undefined,
    credit:
      typeof credit === 'string' ? new cesium.Credit(credit, true) : credit,
    errorEvent: new cesium.Event(),
    hasAlphaChannel: false,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    async requestImage(x, y, level) {
      const canvas = createCanvas();
      canvas.width = tileSize;
      canvas.height = tileSize;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = palette.land;
      ctx.fillRect(0, 0, tileSize, tileSize);
      try {
        const template = await resolveTemplate();
        const url = template
          .replace('{z}', String(level))
          .replace('{x}', String(x))
          .replace('{y}', String(y));
        const response = await fetchImpl(url, { redirect: 'error' });
        if (!response.ok) return canvas;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const tile = new VectorTile(new PbfReader(bytes));
        drawOsmVectorTile(ctx, tile, { palette, tileSize, zoom: level });
      } catch {
        // Keep the flat land-colour tile on any fetch/decode failure.
      }
      return canvas;
    },
  };
}
