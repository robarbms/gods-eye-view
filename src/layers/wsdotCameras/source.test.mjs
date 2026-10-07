import test from 'node:test';
import assert from 'node:assert/strict';
import { createWsdotCamerasSource } from './source.js';

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

test('requests the proxy and returns normalized records', async () => {
  let requested = null;
  const source = createWsdotCamerasSource({
    fetchImpl: async (url, init) => {
      requested = { url, init };
      return jsonResponse({
        cameras: [
          {
            CameraID: 1,
            Title: 'SR 520 Bridge',
            DisplayLatitude: 47.64,
            DisplayLongitude: -122.25,
            ImageURL: 'https://img/1.jpg',
            IsActive: true,
            CameraLocation: { RoadName: '520' },
          },
        ],
      });
    },
  });
  const records = await source.getSnapshot();
  assert.equal(requested.url, '/api/wsdot-cameras');
  assert.equal(requested.init.cache, 'no-store');
  assert.equal(records.length, 1);
  assert.equal(records[0].id, '1');
  assert.equal(records[0].road, '520');
});

test('surfaces a keyless proxy as a keyRequired sentinel', async () => {
  const source = createWsdotCamerasSource({
    fetchImpl: async () =>
      jsonResponse({ error: 'no_key' }, { ok: false, status: 503 }),
  });
  assert.deepEqual(await source.getSnapshot(), { keyRequired: true });
});

test('throws on other HTTP errors and malformed bodies', async () => {
  await assert.rejects(
    () =>
      createWsdotCamerasSource({
        fetchImpl: async () => jsonResponse({}, { ok: false, status: 502 }),
      }).getSnapshot(),
    /WSDOT HTTP 502/,
  );
  await assert.rejects(
    () =>
      createWsdotCamerasSource({
        fetchImpl: async () => jsonResponse({ nope: true }),
      }).getSnapshot(),
    /Malformed WSDOT camera response/,
  );
});

test('honors an already-aborted signal before fetching', async () => {
  let called = false;
  const source = createWsdotCamerasSource({
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ cameras: [] });
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => source.getSnapshot({ signal: controller.signal }));
  assert.equal(called, false);
});
