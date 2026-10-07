import * as CesiumNS from 'cesium';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

/**
 * Client-side OpenMapTiles basemap styles for the OSM globe stack. Each style
 * rasterises OpenFreeMap vector tiles to a canvas per imagery tile, so the OSM
 * basemap can be re-styled without a keyed raster service. The three palettes
 * approximate the OpenMapTiles reference styles (Positron, Dark Matter, Fiord
 * Color); `mono` generates a monochrome palette from one user-picked colour.
 * Labels are intentionally omitted.
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
  { id: 'mono', label: 'Mono' },
]);

/** Starting colour of the user-tinted `mono` style. */
export const DEFAULT_OSM_MONO_COLOR = '#3cff7a';

/** Normalise `#rgb`/`#rrggbb` input to lowercase `#rrggbb`, or return null. */
export function normalizeOsmMonoColor(value) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? ''));
  if (!match) return null;
  const hex =
    match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  return `#${hex.toLowerCase()}`;
}

// Lightness (0–1) of each palette slot in the generated monochrome style: a dark
// ground with progressively brighter structures, so roads read as the "ink".
const MONO_LIGHTNESS = Object.freeze({
  land: 0.07,
  water: 0.03,
  waterway: 0.05,
  wood: 0.1,
  grass: 0.09,
  park: 0.11,
  farmland: 0.08,
  sand: 0.09,
  ice: 0.13,
  rock: 0.1,
  wetland: 0.09,
  residential: 0.09,
  commercial: 0.1,
  industrial: 0.09,
  building: 0.15,
  roadFill: 0.34,
  roadCasing: 0.04,
  railFill: 0.24,
  path: 0.2,
  boundary: 0.3,
});

// Lightness offsets from the picked colour for the `near` tone: land is the
// picked colour itself, water a step darker, built-up areas a touch lighter.
const MONO_NEAR_OFFSET = Object.freeze({
  land: 0,
  water: -0.14,
  waterway: -0.12,
  wood: -0.06,
  grass: -0.03,
  park: 0.04,
  farmland: -0.02,
  sand: 0.02,
  ice: 0.08,
  rock: -0.04,
  wetland: -0.05,
  residential: 0.02,
  commercial: 0.04,
  industrial: 0,
  building: 0.08,
  roadFill: 0.3,
  roadCasing: -0.3,
  railFill: 0.2,
  path: 0.15,
  boundary: 0.25,
});

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const byte = (v) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * Generate a full monochrome palette from one colour: its hue and saturation
 * are kept, and each map feature gets a fixed lightness step (dark ground,
 * bright roads). A grey pick yields a neutral greyscale map. With
 * `tone: 'near'` the fills instead sit just around the picked colour's own
 * lightness (used by the inverted outline variants, whose black/white lines
 * need a ground that reads as the chosen colour).
 * @param {string} color - Any `#rgb`/`#rrggbb` colour.
 * @param {{ tone?: 'dark'|'near' }} [options]
 * @returns {Record<string,string>} A palette with the same keys as the presets.
 */
export function createMonochromePalette(color, { tone = 'dark' } = {}) {
  const hex = normalizeOsmMonoColor(color) || DEFAULT_OSM_MONO_COLOR;
  const { h, s, l: pickedL } = hexToHsl(hex);
  const palette = {};
  for (const [key, l] of Object.entries(MONO_LIGHTNESS)) {
    const lightness =
      tone === 'near'
        ? Math.min(0.96, Math.max(0.04, pickedL + MONO_NEAR_OFFSET[key]))
        : l;
    palette[key] = hslToHex(h, s, lightness);
  }
  return Object.freeze(palette);
}

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

/**
 * Rendering variants layered on any vector style. Outline variants flatten every
 * fill to one ground colour and draw only roads, borders and coastlines; the
 * inverted ones keep the style's fills and ink those lines black or white.
 */
export const OSM_STYLE_VARIANTS = Object.freeze([
  { id: 'normal', label: 'None' },
  { id: 'outline', label: 'Outline' },
  { id: 'outline-light', label: 'Outline light' },
  { id: 'outline-inverted', label: 'Outline inverted' },
  { id: 'outline-light-inverted', label: 'Outline light inverted' },
]);

export const DEFAULT_OSM_STYLE_VARIANT = 'normal';

/** Resolve a variant id, falling back to `normal`. */
export function osmStyleVariant(id) {
  return OSM_STYLE_VARIANTS.find((v) => v.id === id) || OSM_STYLE_VARIANTS[0];
}

function relativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (hi + 0.05) / (lo + 0.05);
}

const MIN_OUTLINE_CONTRAST = 1.8;

/**
 * A style colour for an outline line on `ground`. When the style's own colour
 * would vanish (e.g. Positron's white roads on a white ground), the style colour
 * with the most contrast is used instead, then plain black/white as last resort.
 */
function outlineInk(color, ground, palette) {
  if (contrastRatio(color, ground) >= MIN_OUTLINE_CONTRAST) return color;
  let best = color;
  for (const candidate of Object.values(palette))
    if (contrastRatio(candidate, ground) > contrastRatio(best, ground))
      best = candidate;
  if (contrastRatio(best, ground) >= MIN_OUTLINE_CONTRAST) return best;
  return ground === '#000000' ? '#ffffff' : '#000000';
}

/**
 * Resolve the paint plan for a palette + variant: the palette actually used for
 * fills/lines, whether motor roads get casings, and the coastline stroke colour
 * (null = no coast outline).
 * @returns {{ palette: object, cased: boolean, coast: string|null }}
 */
export function resolveOsmVariantPaint(palette, variant) {
  const id = osmStyleVariant(variant).id;
  if (id === 'normal') return { palette, cased: true, coast: null };
  if (id === 'outline' || id === 'outline-light') {
    const ground = id === 'outline' ? '#000000' : '#ffffff';
    const flat = {};
    for (const key of Object.keys(palette)) flat[key] = ground;
    const coast = outlineInk(palette.water, ground, palette);
    return {
      palette: {
        ...flat,
        roadFill: outlineInk(palette.roadFill, ground, palette),
        railFill: outlineInk(palette.railFill, ground, palette),
        path: outlineInk(palette.path, ground, palette),
        boundary: outlineInk(palette.boundary, ground, palette),
        waterway: coast,
      },
      cased: false,
      coast,
    };
  }
  const ink = id === 'outline-inverted' ? '#000000' : '#ffffff';
  return {
    palette: {
      ...palette,
      roadFill: ink,
      railFill: ink,
      path: ink,
      boundary: ink,
      waterway: ink,
    },
    cased: false,
    coast: ink,
  };
}

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

function drawRoads(ctx, layer, tileSize, zoom, palette, cased = true) {
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
    if (!cased) break;
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
 * @param {{ palette: object, tileSize: number, zoom: number, variant?: string }} options
 */
export function drawOsmVectorTile(
  ctx,
  vectorTile,
  { palette: basePalette, tileSize, zoom, variant = DEFAULT_OSM_STYLE_VARIANT },
) {
  const { palette, cased, coast } = resolveOsmVariantPaint(
    basePalette,
    variant,
  );
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
  // Coastline = the water polygons' edges. Tile-clipped edges sit in the tile
  // buffer outside the canvas, so only real shorelines are drawn.
  if (coast && layers.water)
    strokeLineLayer(ctx, layers.water, tileSize, {
      colorFor: () => coast,
      widthFor: () => 0.9,
    });
  if (layers.waterway)
    strokeLineLayer(ctx, layers.waterway, tileSize, {
      colorFor: () => palette.waterway,
      widthFor: (p) => (p.class === 'river' ? 1.1 : 0.6),
    });
  if (zoom >= 14 && layers.building)
    fillPolygonLayer(ctx, layers.building, tileSize, () => palette.building);
  if (layers.transportation)
    drawRoads(ctx, layers.transportation, tileSize, zoom, palette, cased);
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
 * `color` only applies to the `mono` style; `variant` is an
 * `OSM_STYLE_VARIANTS` id.
 * @returns {object} A Cesium `ImageryProvider`-shaped object.
 */
export function createOsmVectorStyleImagery({
  styleId,
  color = DEFAULT_OSM_MONO_COLOR,
  variant = DEFAULT_OSM_STYLE_VARIANT,
  cesium = CesiumNS,
  fetchImpl = (...args) => globalThis.fetch(...args),
  createCanvas = () => document.createElement('canvas'),
  tileJsonUrl = OPENFREEMAP_TILEJSON_URL,
  tileSize = 256,
  maximumLevel = 14,
  credit = OSM_VECTOR_CREDIT,
} = {}) {
  const preset = osmStylePreset(styleId);
  const variantId = osmStyleVariant(variant).id;
  const palette =
    preset.id === 'mono'
      ? createMonochromePalette(color, {
          tone: variantId.endsWith('-inverted') ? 'near' : 'dark',
        })
      : OSM_STYLE_PALETTES[preset.id];
  if (!palette)
    throw new Error(`No vector palette for OSM style: ${String(styleId)}`);
  const groundColor = resolveOsmVariantPaint(palette, variantId).palette.land;
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
      ctx.fillStyle = groundColor;
      ctx.fillRect(0, 0, tileSize, tileSize);
      try {
        const template = await resolveTemplate();
        const url = new URL(
          template
            .replace('{z}', String(level))
            .replace('{x}', String(x))
            .replace('{y}', String(y)),
          OPENFREEMAP_ORIGIN,
        ).href;
        const response = await fetchImpl(url, { redirect: 'error' });
        if (!response.ok) return canvas;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const tile = new VectorTile(new PbfReader(bytes));
        drawOsmVectorTile(ctx, tile, {
          palette,
          tileSize,
          zoom: level,
          variant: variantId,
        });
      } catch {
        // Keep the flat land-colour tile on any fetch/decode failure.
      }
      return canvas;
    },
  };
}
