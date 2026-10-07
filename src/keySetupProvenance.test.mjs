import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { knownKeySetupEnvVars } from './keySetupCore.mjs';
import { PINOKIO_CONFIG_FIELDS } from '../scripts/pinokio-environment.mjs';

/** Drive the status middleware and return its parsed JSON payload. */
function readStatus(plugin) {
  let handler = null;
  plugin.configureServer({
    middlewares: {
      use(route, fn) {
        if (route === '/api/setup/status') handler = fn;
      },
    },
  });
  const req = {
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:5173' },
  };
  let body = '';
  handler(req, {
    statusCode: 0,
    setHeader() {},
    end(text) {
      body = text;
    },
  });
  return JSON.parse(body);
}

/**
 * The boot snapshot is memoized on globalThis so an in-process dev-server
 * restart cannot reclassify the panel's own saves as external. That memo also
 * means a registry which GREW since boot has names the snapshot never captured —
 * reading one back must mean "absent at boot", not "externally supplied".
 *
 * Regression: comparing the missing entry straight to '' made `undefined !== ''`
 * true, so a newly registered provider rendered read-only ("configured
 * externally") with no input, and POSTing it answered 409.
 */
test('a registry key added after boot stays editable in its own store', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-key-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const name = 'WSDOT_ACCESS_CODE';
  writeFileSync(path.join(root, '.env'), `${name}=stored-code\n`);

  // A snapshot taken before `name` joined the registry: every OTHER provider is
  // present and empty, this one is simply absent.
  const stale = Object.fromEntries(
    [...knownKeySetupEnvVars()]
      .filter((envVar) => envVar !== name)
      .map((envVar) => [envVar, '']),
  );
  const previousSnapshot = globalThis.__GEV_PROVIDER_ENV_AT_BOOT;
  const previousValue = process.env[name];
  const previousLauncher = process.env.GEV_LAUNCHER;
  globalThis.__GEV_PROVIDER_ENV_AT_BOOT = Object.freeze(stale);
  process.env[name] = 'stored-code';
  delete process.env.GEV_LAUNCHER;
  t.after(() => {
    globalThis.__GEV_PROVIDER_ENV_AT_BOOT = previousSnapshot;
    if (previousValue === undefined) delete process.env[name];
    else process.env[name] = previousValue;
    if (previousLauncher === undefined) delete process.env.GEV_LAUNCHER;
    else process.env.GEV_LAUNCHER = previousLauncher;
  });

  const { keySetupEndpoint } = await import('../server/standalone/key-setup.js');
  const status = readStatus(keySetupEndpoint({ sourceRoot: root }));
  const entry = status.keys.find((key) => key.envVars.includes(name));

  assert.ok(entry, `${name} must appear in the panel payload`);
  assert.equal(entry.set, true);
  assert.equal(
    entry.managed,
    'file',
    'a value this store holds must stay editable, even when the boot snapshot predates it',
  );
});

/**
 * Pinokio applies ONLY the fields it enumerates back onto process.env, so a
 * provider missing from that list would be written by the panel and then
 * silently never take effect under that launcher.
 */
test('every provider credential is forwarded by the Pinokio launcher', () => {
  const forwarded = new Set(PINOKIO_CONFIG_FIELDS);
  for (const envVar of knownKeySetupEnvVars()) {
    assert.ok(
      forwarded.has(envVar),
      `${envVar} must be listed in PINOKIO_CONFIG_FIELDS`,
    );
  }
});
