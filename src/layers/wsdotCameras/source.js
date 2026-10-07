import { normalizeWsdotCameras } from './model.js';

/**
 * Construct the WSDOT Highway Cameras feed without making a request.
 *
 * The browser cannot call WSDOT directly: the Traffic API requires a
 * server-held AccessCode and sends no CORS headers. All access goes through the
 * dev/preview server's `/api/wsdot-cameras` proxy. When no access code is
 * configured the proxy answers `503 {error:'no_key'}`, returned here as a
 * `{keyRequired:true}` sentinel so the layer reports a clean "access code
 * required" state rather than failing to start.
 */
export function createWsdotCamerasSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/wsdot-cameras', {
        signal,
        cache: 'no-store',
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        /* status below remains authoritative */
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        if (response.status === 503 && payload?.error === 'no_key')
          return { keyRequired: true };
        throw new Error(`WSDOT HTTP ${response.status}`);
      }
      const records = normalizeWsdotCameras(payload);
      if (!records) throw new Error('Malformed WSDOT camera response');
      return records;
    },
  };
}
