import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OSM_STYLES,
  OSM_STYLE_IDS,
  OSM_STYLE_PALETTES,
  DEFAULT_OSM_STYLE_ID,
  osmStylePreset,
  drawOsmVectorTile,
  createOsmVectorStyleImagery,
  createMonochromePalette,
  normalizeOsmMonoColor,
  DEFAULT_OSM_MONO_COLOR,
} from './osmVectorStyle.js';

/** A context double that records the paint operations issued against it. */
function recordingContext() {
  const calls = [];
  const ctx = {
    fillStyle: null,
    strokeStyle: null,
    lineWidth: 0,
    lineJoin: null,
    lineCap: null,
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...a) => calls.push(['moveTo', ...a]),
    lineTo: (...a) => calls.push(['lineTo', ...a]),
    fill: (rule) => calls.push(['fill', rule, ctx.fillStyle]),
    stroke: () => calls.push(['stroke', ctx.strokeStyle, ctx.lineWidth]),
  };
  return { ctx, calls };
}

/** Build a vector-tile double from layer name -> features. */
function fakeTile(layers) {
  const built = {};
  for (const [name, features] of Object.entries(layers)) {
    built[name] = {
      extent: 4096,
      length: features.length,
      feature: (i) => ({
        properties: features[i].properties || {},
        loadGeometry: () => features[i].geometry,
      }),
    };
  }
  return { layers: built };
}

test('style presets expose default, the three OpenMapTiles styles and mono', () => {
  assert.equal(DEFAULT_OSM_STYLE_ID, 'default');
  assert.deepEqual(OSM_STYLE_IDS, [
    'default',
    'positron',
    'dark',
    'fiord',
    'mono',
  ]);
  assert.equal(OSM_STYLES.length, 5);
  for (const id of ['positron', 'dark', 'fiord'])
    assert.ok(OSM_STYLE_PALETTES[id].land, `${id} has a land colour`);
  assert.equal(OSM_STYLE_PALETTES.default, undefined);
});

test('createMonochromePalette derives every palette slot from one colour', () => {
  const green = createMonochromePalette('#00ff00');
  assert.deepEqual(
    Object.keys(green).sort(),
    Object.keys(OSM_STYLE_PALETTES.dark).sort(),
    'same slots as the preset palettes',
  );
  for (const [key, hex] of Object.entries(green)) {
    assert.match(hex, /^#[0-9a-f]{6}$/, key);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(g >= r && g >= b, `${key} stays green-hued (${hex})`);
  }
  const lum = (hex) => parseInt(hex.slice(3, 5), 16);
  assert.ok(lum(green.roadFill) > lum(green.land), 'roads brighter than land');
  assert.ok(lum(green.water) < lum(green.land), 'water darker than land');

  const grey = createMonochromePalette('#808080');
  for (const hex of Object.values(grey))
    assert.equal(hex.slice(1, 3), hex.slice(3, 5), 'grey input stays neutral');

  assert.deepEqual(
    createMonochromePalette('not a colour'),
    createMonochromePalette(DEFAULT_OSM_MONO_COLOR),
    'invalid input falls back to the default colour',
  );
});

test('normalizeOsmMonoColor accepts #rgb/#rrggbb and rejects the rest', () => {
  assert.equal(normalizeOsmMonoColor('#F80'), '#ff8800');
  assert.equal(normalizeOsmMonoColor('#FF3300'), '#ff3300');
  assert.equal(normalizeOsmMonoColor('red'), null);
  assert.equal(normalizeOsmMonoColor(undefined), null);
});

test('osmStylePreset normalises unknown or missing ids to default', () => {
  assert.equal(osmStylePreset('positron').id, 'positron');
  assert.equal(osmStylePreset('nonsense').id, 'default');
  assert.equal(osmStylePreset(undefined).id, 'default');
});

test('drawOsmVectorTile paints the land background then styled features', () => {
  const { ctx, calls } = recordingContext();
  const palette = OSM_STYLE_PALETTES.positron;
  const tile = fakeTile({
    water: [
      {
        properties: { class: 'lake' },
        geometry: [
          [
            { x: 0, y: 0 },
            { x: 4096, y: 0 },
            { x: 4096, y: 4096 },
            { x: 0, y: 4096 },
          ],
        ],
      },
    ],
    transportation: [
      {
        properties: { class: 'motorway' },
        geometry: [
          [
            { x: 0, y: 2048 },
            { x: 4096, y: 2048 },
          ],
        ],
      },
    ],
  });
  drawOsmVectorTile(ctx, tile, { palette, tileSize: 256, zoom: 12 });

  assert.deepEqual(calls[0], ['fillRect', 0, 0, 256, 256]);
  const fills = calls.filter((c) => c[0] === 'fill').map((c) => c[2]);
  assert.ok(fills.includes(palette.water), 'water polygon is filled');
  const strokes = calls.filter((c) => c[0] === 'stroke').map((c) => c[1]);
  assert.ok(strokes.includes(palette.roadCasing), 'motorway draws a casing');
  assert.ok(strokes.includes(palette.roadFill), 'motorway draws a fill');
});

test('createOsmVectorStyleImagery exposes a Cesium imagery provider shape', () => {
  const provider = createOsmVectorStyleImagery({
    styleId: 'dark',
    cesium: {
      WebMercatorTilingScheme: class {
        constructor() {
          this.rectangle = { id: 'mercator' };
        }
      },
      Credit: class {
        constructor(text) {
          this.text = text;
        }
      },
      Event: class {},
    },
  });
  assert.equal(provider.tileWidth, 256);
  assert.equal(provider.tileHeight, 256);
  assert.equal(provider.maximumLevel, 14);
  assert.equal(provider.ready, true);
  assert.equal(provider.rectangle.id, 'mercator');
  assert.equal(typeof provider.requestImage, 'function');
});

test('requestImage degrades to a flat land tile when the tile fetch fails', async () => {
  let getContextCalled = false;
  const painted = { fillStyle: null, rect: null };
  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: () => {
      getContextCalled = true;
      return {
        set fillStyle(v) {
          painted.fillStyle = v;
        },
        fillRect: (...a) => {
          painted.rect = a;
        },
      };
    },
  };
  const provider = createOsmVectorStyleImagery({
    styleId: 'fiord',
    cesium: {
      WebMercatorTilingScheme: class {
        constructor() {
          this.rectangle = {};
        }
      },
      Credit: class {},
      Event: class {},
    },
    createCanvas: () => fakeCanvas,
    fetchImpl: async (url) =>
      url.endsWith('/planet')
        ? { ok: true, json: async () => ({ tiles: ['x/{z}/{x}/{y}.pbf'] }) }
        : { ok: false, status: 404 },
    tileJsonUrl: 'https://tiles.openfreemap.org/planet',
  });
  const canvas = await provider.requestImage(1, 2, 3);
  assert.equal(canvas, fakeCanvas);
  assert.ok(getContextCalled);
  assert.equal(painted.fillStyle, OSM_STYLE_PALETTES.fiord.land);
  assert.deepEqual(painted.rect, [0, 0, 256, 256]);
});
