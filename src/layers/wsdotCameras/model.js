const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const text = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/**
 * Normalize a WSDOT Highway Cameras payload into the records the layer renders.
 *
 * The upstream `GetCamerasAsJson` endpoint returns an array of Camera objects
 * (served through the `/api/wsdot-cameras` proxy as `{cameras:[...]}`). Only
 * active cameras with a finite display coordinate and a snapshot image URL are
 * renderable; everything else is dropped rather than drawn at (0,0) or linked
 * to a dead image.
 *
 * @param {{cameras: Array<object>}|Array<object>|null|undefined} payload
 * @returns {Array<object>|null} Normalized records, or null when the payload is
 *   not a recognizable camera collection.
 */
export function normalizeWsdotCameras(payload) {
  const cameras = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.cameras)
      ? payload.cameras
      : null;
  if (!cameras) return null;

  const records = [];
  const seen = new Set();
  for (const camera of cameras) {
    if (!camera || typeof camera !== 'object') continue;
    if (camera.IsActive === false) continue;

    const location = camera.CameraLocation || {};
    const lat = finite(camera.DisplayLatitude) ?? finite(location.Latitude);
    const lon = finite(camera.DisplayLongitude) ?? finite(location.Longitude);
    if (lat === null || lon === null) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const imageUrl = text(camera.ImageURL);
    if (!imageUrl) continue;

    const rawId = camera.CameraID;
    const id =
      typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : text(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    records.push({
      id,
      title: text(camera.Title) || text(location.Description) || `Camera ${id}`,
      road: text(location.RoadName),
      milepost: finite(location.MilePost),
      lat,
      lon,
      imageUrl,
      description: text(camera.Description),
      owner: text(camera.CameraOwner),
      region: text(camera.Region),
    });
  }
  return records;
}
