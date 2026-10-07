import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
  resolvePickId,
} from '../../data/pickRegistry.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
import {
  applyFrameResult,
  CCTV_CARD_FADE_END_M,
  CCTV_CARD_FETCH_BURST_LIMIT,
  CCTV_FRAME_CANVAS_H,
  CCTV_FRAME_CANVAS_W,
  createCctvThumbnailOverlayEntry,
  createFrameSlot,
  declutterCctvCards,
  frameFetchDue,
  planFrameCachePrune,
} from '../../data/cctvCards.js';
// The CCTV layer's own icon, idle tint and card geometry — imported, not
// copied, so WSDOT cameras are pixel-identical to CCTV cameras by construction.
import {
  CAMERA_ICON,
  CARD_FETCH_TICK_MS,
  CARD_GAP_PX,
  CARD_VIEW_MARGIN,
  IDLE_CAMERA_COLOR,
} from '../cctv/policy.js';

const LAYER_ID = 'wsdot-cameras';
const PICK_PREFIX = 'wsdot-camera:';

// Window CustomEvent that hands a clicked camera's snapshot to the CCTV panel's
// frame preview (the "palette"). The panel listens for this and takes over its
// frame area while no live CCTV camera is active.
const CCTV_EXTERNAL_FRAME_EVENT = 'gev:cctv-external-frame';

// Performance tuning. Only cameras inside the current view (padded by this
// fraction on each side) render; the rest are hidden on camera moveEnd.
const VIEW_PADDING = 0.25;

// CCTV-style thumbnail cards. They share the CCTV cards' `ambient-card`
// collision group, so the two layers declutter against each other as one family.
const CARD_OVERLAY_SOURCE_ID = 'wsdot-cameras';
const CARD_LIMIT = 12;
const CARD_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: CARD_LIMIT,
  collisionCapacity: CARD_LIMIT,
  moving: true,
  solveIntervalMs: 125,
});
// WSDOT publishes a fresh still roughly every minute or two.
const FRAME_REFRESH_MS = 90_000;

/** The snapshot URL with a cadence tick, so a refresh is not served stale. */
const frameUrl = (url, nowMs) =>
  `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(nowMs / FRAME_REFRESH_MS)}`;

/**
 * Default frame presenter: dispatch the clicked camera's snapshot to the CCTV
 * panel via the application's `gev:` window event bus. Injectable for tests.
 */
function defaultPresentFrame(detail) {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function')
    return;
  window.dispatchEvent(new CustomEvent(CCTV_EXTERNAL_FRAME_EVENT, { detail }));
}

/**
 * WSDOT Highway Cameras overlay: live roadside snapshot cameras clamped to the
 * ground, each sending its latest still image to the CCTV panel preview on
 * click. Presented exactly like the CCTV camera layer — the same icon and tint,
 * and the same thumbnail cards (live snapshot + title) once zoomed in.
 *
 * Modeled on the single-file earthquakes layer (init/enable/disable/update/
 * destroy/getStats, a CustomDataSource, and an AbortController refresh guard),
 * with the cyclones-style pick arbitration: the layer registers a pick-owner
 * predicate so sibling click handlers leave camera picks alone, and installs
 * its own LEFT_CLICK handler to open the snapshot.
 *
 * @param {object} options
 * @param {object} [options.overlays] World-overlay host
 *   ({setEntries, clearSource, setVisible, hitTest}); without it the icons
 *   still render but no thumbnail cards are published.
 */
export function createWsdotCamerasLayer({
  source,
  cesium = Cesium,
  presentFrame = defaultPresentFrame,
  overlays = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('WSDOT cameras require a snapshot source');

  // Shared, immutable style objects — built once and reused across every camera
  // entity so a statewide catalog (thousands of cameras) never allocates a
  // Color/Scalar per billboard. Values mirror the CCTV billboard exactly.
  const BILLBOARD_SCALE_BY_DISTANCE = new cesium.NearFarScalar(
    350,
    1.25,
    4_000_000,
    0.42,
  );

  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _clickHandler = null;
  let _cullRemover = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _keyRequired = false;
  let _enabled = false;
  // Cache key for the last rendered camera set — a refresh whose payload is
  // unchanged skips the expensive entity rebuild entirely.
  let _dataSignature = '';
  const _cameras = new Map();
  // Parallel list of rendered entities with their pre-computed radian position
  // for fast per-move viewport culling without re-reading entity geometry.
  const _entities = [];
  const _itemByPickId = new Map();
  const _scratchViewRect = new cesium.Rectangle();
  // Card tier: kept card ids (pick ids), stable per-camera frame slots the
  // overlay reads live, and the paced snapshot fetcher's bookkeeping.
  let _cardIds = [];
  const _frameSlots = new Map();
  const _fetchImages = new Set();
  let _fetchTimer = 0;

  const ownsPickId = (id) =>
    typeof id === 'string' && id.startsWith(PICK_PREFIX) && _cameras.has(id);

  function installSelection() {
    if (
      _clickHandler ||
      !_viewer?.scene?.canvas ||
      typeof cesium.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const handler = new cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
    _clickHandler = handler;
    handler.setInputAction((click) => {
      if (!_enabled || _clickHandler !== handler || !isPointerFree()) return;
      if (!click?.position) return;
      const picked = _viewer.scene.pick(click.position);
      let id = resolvePickId(picked);
      // No scene object under the pointer: the click may land on one of this
      // layer's painted cards, which opens its camera exactly like the icon
      // (the CCTV layer's card-click contract). Only our own source is tested.
      if (id === null && typeof overlays?.hitTest === 'function') {
        id =
          overlays.hitTest(click.position.x, click.position.y, {
            sourceId: CARD_OVERLAY_SOURCE_ID,
          })?.entryId ?? null;
      }
      if (!ownsPickId(id)) return;
      const record = _cameras.get(id);
      if (record?.imageUrl)
        presentFrame({
          imageUrl: record.imageUrl,
          title: record.title,
          road: record.road,
          milepost: record.milepost,
          id: record.id,
          source: 'WSDOT',
        });
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeSelection() {
    const handler = _clickHandler;
    _clickHandler = null;
    if (handler && !handler.isDestroyed?.()) handler.destroy();
  }

  /**
   * (Re)builds the camera entities from a record set, reusing the shared style
   * objects. Caches each entity with its radian position for viewport culling.
   */
  function buildEntities(records) {
    _dataSource.entities.removeAll();
    _cameras.clear();
    _entities.length = 0;
    _itemByPickId.clear();
    for (const record of records) {
      const pickId = `${PICK_PREFIX}${record.id}`;
      _cameras.set(pickId, record);
      const position = cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      const entity = _dataSource.entities.add(
        new cesium.Entity({
          id: pickId,
          position,
          // The CCTV billboard, field for field: same icon, idle tint, size and
          // distance scaling. Titles live on the thumbnail cards, as in CCTV.
          billboard: {
            image: CAMERA_ICON,
            width: 24,
            height: 24,
            color: IDLE_CAMERA_COLOR,
            heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
            verticalOrigin: cesium.VerticalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: BILLBOARD_SCALE_BY_DISTANCE,
          },
        }),
      );
      _entities.push({
        entity,
        pickId,
        record,
        position,
        longitude: cesium.Math.toRadians(record.lon),
        latitude: cesium.Math.toRadians(record.lat),
      });
      _itemByPickId.set(pickId, _entities[_entities.length - 1]);
    }
    _count = _cameras.size;
  }

  /**
   * Hides cameras outside the padded view rectangle so a crowded statewide
   * catalog only pays render cost for what is on screen. Runs on camera moveEnd
   * (settled camera) and after each rebuild — never per frame.
   */
  function applyViewCulling() {
    if (!_enabled || !_viewer || !_entities.length) return;
    let rect = null;
    try {
      rect = _viewer.camera.computeViewRectangle(
        _viewer.scene?.globe?.ellipsoid,
        _scratchViewRect,
      );
    } catch {
      rect = null;
    }
    // No rectangle (sky/horizon) or an antimeridian-spanning view: show all
    // rather than hide cameras incorrectly.
    if (!rect || rect.east < rect.west) {
      for (const item of _entities) item.entity.show = true;
      return;
    }
    const padX = (rect.east - rect.west) * VIEW_PADDING;
    const padY = (rect.north - rect.south) * VIEW_PADDING;
    const west = rect.west - padX;
    const east = rect.east + padX;
    const south = rect.south - padY;
    const north = rect.north + padY;
    for (const item of _entities) {
      item.entity.show =
        item.longitude >= west &&
        item.longitude <= east &&
        item.latitude >= south &&
        item.latitude <= north;
    }
  }

  function installCulling() {
    if (_cullRemover || !_viewer?.camera?.moveEnd) return;
    _cullRemover = _viewer.camera.moveEnd.addEventListener(() => {
      if (!_enabled) return;
      applyViewCulling();
      refreshCards();
    });
  }

  function removeCulling() {
    if (_cullRemover) {
      _cullRemover();
      _cullRemover = null;
    }
  }

  // ---------------------------------------------------------------------------
  // CCTV-style thumbnail cards
  // ---------------------------------------------------------------------------

  function ensureFrameSlot(pickId) {
    let slot = _frameSlots.get(pickId);
    if (!slot) {
      slot = createFrameSlot();
      _frameSlots.set(pickId, slot);
    }
    return slot;
  }

  /** Publish the kept cards to the shared world overlay (CCTV's card entry). */
  function publishCards() {
    if (!overlays) return;
    const entries = [];
    let rank = 0;
    for (const pickId of _cardIds) {
      const item = _itemByPickId.get(pickId);
      if (!item) continue;
      entries.push(
        createCctvThumbnailOverlayEntry({
          id: pickId,
          position: item.position,
          gapPx: CARD_GAP_PX,
          title: item.record.title,
          frameSlot: ensureFrameSlot(pickId),
          rank: rank++,
        }),
      );
    }
    overlays.setEntries(
      CARD_OVERLAY_SOURCE_ID,
      entries,
      CARD_OVERLAY_SOURCE_OPTIONS,
    );
  }

  function clearCards() {
    _cardIds = [];
    overlays?.clearSource?.(CARD_OVERLAY_SOURCE_ID);
  }

  /**
   * Rebuilds the card selection on the settled camera (moveEnd/rebuild/enable,
   * never per frame): horizon + viewport projection of the already-culled
   * cameras, nearest-first, then CCTV's own screen-space declutter. Above the
   * CCTV card ceiling cards would be fully faded anyway, so none are selected
   * (and no snapshots are fetched) — the globe shows just the icons.
   */
  function refreshCards() {
    if (!_enabled || !_viewer || !overlays) return;
    const height = _viewer.camera.positionCartographic?.height;
    const closeRange = Number.isFinite(height) && height < CCTV_CARD_FADE_END_M;
    if (!closeRange || !_entities.length) {
      clearCards();
      return;
    }

    const scene = _viewer.scene;
    const width = scene.canvas.clientWidth || scene.canvas.width || 0;
    const viewH = scene.canvas.clientHeight || scene.canvas.height || 0;
    const marginX = width * CARD_VIEW_MARGIN;
    const marginY = viewH * CARD_VIEW_MARGIN;
    const occluder = horizonOccluder(_viewer.camera);
    const eye = _viewer.camera.positionWC;
    const candidates = [];
    for (const item of _entities) {
      if (!item.entity.show || !occluder.isPointVisible(item.position))
        continue;
      const screen = scene.cartesianToCanvasCoordinates(item.position);
      if (
        !screen ||
        !Number.isFinite(screen.x) ||
        !Number.isFinite(screen.y) ||
        screen.x < -marginX ||
        screen.x > width + marginX ||
        screen.y < -marginY ||
        screen.y > viewH + marginY
      )
        continue;
      candidates.push({
        id: item.pickId,
        sx: screen.x,
        sy: screen.y,
        distanceKm: cesium.Cartesian3.distance(eye, item.position) / 1000,
      });
    }
    _cardIds = declutterCctvCards(candidates, { limit: CARD_LIMIT });

    // Bounded thumbnail LRU — live cards always keep their persisted frame.
    for (const id of planFrameCachePrune(
      [..._frameSlots].map(([id, slot]) => ({ id, stamp: slot.stamp })),
      _cardIds,
    ))
      _frameSlots.delete(id);
    publishCards();
  }

  /**
   * Paced snapshot fetcher (CCTV's card cadence): at most one launch per tick
   * and a small in-flight cap, honoring each slot's refresh and retry backoff.
   * A failed fetch keeps the last good frame (the no-flicker rule).
   */
  function fetchTick() {
    if (!_enabled || !_cardIds.length) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (_fetchImages.size >= CCTV_CARD_FETCH_BURST_LIMIT) return;
    const now = Date.now();
    const inFlight = new Set([..._fetchImages].map((img) => img._wsdotPickId));
    const pickId = _cardIds.find(
      (id) =>
        !inFlight.has(id) &&
        _cameras.get(id)?.imageUrl &&
        frameFetchDue(ensureFrameSlot(id), FRAME_REFRESH_MS, now),
    );
    if (!pickId) return;
    const slot = ensureFrameSlot(pickId);
    slot.lastAttemptAt = now;
    const image = new Image();
    image._wsdotPickId = pickId;
    _fetchImages.add(image);
    const settle = (ok) => {
      image.onload = null;
      image.onerror = null;
      if (!_fetchImages.delete(image)) return;
      let frame = null;
      if (ok) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = CCTV_FRAME_CANVAS_W;
          canvas.height = CCTV_FRAME_CANVAS_H;
          canvas
            .getContext('2d')
            .drawImage(image, 0, 0, canvas.width, canvas.height);
          frame = canvas;
        } catch {
          frame = null;
        }
      }
      Object.assign(
        slot,
        applyFrameResult(slot, { ok: !!frame, frame }, Date.now()),
      );
      _viewer?.scene?.requestRender?.();
    };
    image.onload = () => settle(true);
    image.onerror = () => settle(false);
    image.src = frameUrl(_cameras.get(pickId).imageUrl, now);
  }

  function startFrameLoop() {
    if (_fetchTimer || !overlays || typeof Image === 'undefined') return;
    _fetchTimer = setInterval(fetchTick, CARD_FETCH_TICK_MS);
  }

  function stopFrameLoop() {
    if (_fetchTimer) {
      clearInterval(_fetchTimer);
      _fetchTimer = 0;
    }
    for (const image of _fetchImages) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute?.('src');
    }
    _fetchImages.clear();
  }

  const layer = {
    id: LAYER_ID,
    name: 'Traffic Cameras',
    icon: '📷',
    source: 'WSDOT',
    updateInterval: 300000,

    // No standalone toggle: the CCTV ("Cameras") layer owns this layer's
    // enablement and cascades enable/disable to it, so roadside WSDOT snapshots
    // appear as part of the unified Cameras contact family.
    showInTogglePanel: false,

    init(viewer) {
      if (_viewer)
        throw new Error('WSDOT cameras layer is already initialized');
      _viewer = viewer;
      _dataSource = new cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _keyRequired = false;
      _enabled = false;
      _dataSignature = '';
      _cameras.clear();
      _entities.length = 0;
      _itemByPickId.clear();
    },

    enable() {
      if (!_viewer || _enabled) return;
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      registerPickOwner(LAYER_ID, (id) => _enabled && ownsPickId(id));
      installSelection();
      installCulling();
      applyViewCulling();
      overlays?.setVisible?.(CARD_OVERLAY_SOURCE_ID, true);
      startFrameLoop();
      refreshCards();
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      _keyRequired = false;
      unregisterPickOwner(LAYER_ID);
      removeSelection();
      removeCulling();
      stopFrameLoop();
      clearCards();
      overlays?.setVisible?.(CARD_OVERLAY_SOURCE_ID, false);
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_enabled || !_dataSource) return;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const result = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled) return;

        // Keyless proxy: the layer enables cleanly and reports the missing
        // access code through its stats rather than rejecting the lifecycle.
        if (result && result.keyRequired === true) {
          buildEntities([]);
          clearCards();
          _dataSignature = '';
          _keyRequired = true;
          _lastError = null;
          return true;
        }

        const records = Array.isArray(result) ? result : [];
        // Cache guard: the statewide camera catalog is effectively static, so a
        // refresh with an identical payload skips the full entity rebuild.
        const signature = `${records.length}:${records[0]?.id ?? ''}:${
          records[records.length - 1]?.id ?? ''
        }`;
        if (
          signature !== _dataSignature ||
          _entities.length !== records.length
        ) {
          buildEntities(records);
          _dataSignature = signature;
          applyViewCulling();
          refreshCards();
        }

        _keyRequired = false;
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled) return;
        // A failed refresh leaves the layer enabled but degraded — surface the
        // reason through stats and retry next interval; never reject enable.
        _lastError = e?.message || 'WSDOT cameras unavailable';
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      unregisterPickOwner(LAYER_ID);
      removeSelection();
      removeCulling();
      stopFrameLoop();
      clearCards();
      _frameSlots.clear();
      _cameras.clear();
      _entities.length = 0;
      _itemByPickId.clear();
      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
      }
      _dataSource = null;
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _keyRequired = false;
      _dataSignature = '';
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _keyRequired ? 'ACCESS CODE REQUIRED' : _lastError,
        keyRequired: _keyRequired,
        source: 'WSDOT',
      };
    },
  };
  return layer;
}

export { normalizeWsdotCameras } from './model.js';
export { createWsdotCamerasSource } from './source.js';
