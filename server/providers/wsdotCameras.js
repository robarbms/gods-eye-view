import path from 'node:path';
import { promises as fsp } from 'node:fs';

/**
 * WSDOT Highway Cameras proxy with a memory + disk cache.
 * Upstream: https://wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson?AccessCode={CODE}
 *
 * The WSDOT Traffic API requires a server-held AccessCode and returns no CORS
 * headers, so the browser cannot call it directly. This proxy injects the code
 * (WSDOT_ACCESS_CODE), caches the ~statewide camera list (it changes rarely),
 * and serves stale on upstream failure. Pattern mirrors firmsProxy.
 *
 * Routes:
 *   GET /api/wsdot-cameras        → {fetchedAt, stale, ttlMs, count, cameras}
 *   GET /api/wsdot-cameras/status → {hasKey, lastFetch, count, stale, ttlMs}
 *
 * Keyless (no WSDOT_ACCESS_CODE): /api/wsdot-cameras → 503 {error:'no_key'};
 * status → {hasKey:false}. Upstream is never touched without a code.
 *
 * @returns {import('vite').Plugin}
 */
export function wsdotCamerasProxy() {
  const TTL_MS = 5 * 60_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'wsdot-cameras.json');

  /** @type {?{at: number, cameras: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, cameras: Array<object>}>} single-flight refresh */
  let inflight = null;

  const accessCode = () => String(process.env.WSDOT_ACCESS_CODE || '').trim();

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.cameras))
        mem = parsed;
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn(
        '[wsdot-cameras-proxy] cache write failed:',
        err?.message || err,
      );
    }
  }

  /**
   * Fetch the full camera list. Throws on HTTP error or a non-array body
   * (WSDOT reports an invalid AccessCode as a non-200/HTML response). Never log
   * the URL — it embeds the AccessCode.
   */
  async function refreshUpstream(code) {
    const url = `https://wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson?AccessCode=${encodeURIComponent(code)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('non-array upstream response');
    return { at: Date.now(), cameras: body };
  }

  function buildPayload(entry, stale) {
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      count: entry.cameras.length,
      cameras: entry.cameras,
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/wsdot-cameras', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const subPath = String(req.url || '').split('?')[0];
        const code = accessCode();
        await readDiskOnce();

        if (subPath === '/status') {
          sendJson(200, {
            hasKey: Boolean(code),
            lastFetch: mem ? mem.at : null,
            count: mem ? mem.cameras.length : null,
            stale: mem ? Date.now() - mem.at >= TTL_MS : false,
            ttlMs: TTL_MS,
          });
          return;
        }

        if (!code) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const entry = mem;
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(entry, false));
          return;
        }
        // Stale or missing → refresh, single-flight. Capture the promise
        // locally BEFORE awaiting: .finally() nulls `inflight` once it settles.
        if (!inflight) {
          inflight = refreshUpstream(code)
            .then(async (fresh) => {
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[wsdot-cameras-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        const fresh = await inflight;
        if (fresh) {
          sendJson(200, buildPayload(fresh, false));
        } else if (entry) {
          sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
        } else {
          sendJson(502, {
            error: 'wsdot cameras fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[wsdot-cameras-proxy] error:', err?.message || err);
        sendJson(500, { error: 'wsdot cameras proxy error' });
      }
    });
  };
  return {
    name: 'wsdot-cameras-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
