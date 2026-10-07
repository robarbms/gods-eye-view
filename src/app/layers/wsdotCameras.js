import { createWsdotCamerasLayer } from '../../layers/wsdotCameras/index.js';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';

// The shared world-overlay host that paints the CCTV thumbnail cards — WSDOT
// publishes its own cards through it so both camera families look identical.
const overlays = Object.freeze({
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});

/** Wire the WSDOT Highway Cameras layer into the application catalog. */
export function createApplicationWsdotCameras(options) {
  return createWsdotCamerasLayer({ overlays, ...options });
}
