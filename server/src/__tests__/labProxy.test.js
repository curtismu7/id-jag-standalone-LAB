import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { labAllowedHosts } from '../config.js';
import { allowedHosts } from '../hostCheck.js';
import { requestBase, requestOrigin } from '../requestOrigin.js';

// Behind the lab-proxy the kit sees Host = its own proxy name, X-Forwarded-Host/-Proto from the proxy and the browser's
// Origin = the proxy's origin. Those are believed only when Host is a LAB_ALLOWED_HOSTS name (loopback does not count).
// Example names only (.example); the real names live in deploy/docker-compose.yml.
const LAB_HOST = 'kit.lab.example';
const PROXY_ORIGIN = 'https://front.example:8443';
const fwd = { 'x-forwarded-host': 'front.example:8443', 'x-forwarded-proto': 'https' };

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-labproxy-')); // mode switches persist mode.json: keep it out of the shared .data
  vi.stubEnv('DATA_DIR', dir);
  vi.stubEnv('APP_ORIGIN', 'http://localhost:4720');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret');
  vi.stubEnv('ALLOWED_HOSTS', '');
  vi.stubEnv('LAB_ALLOWED_HOSTS', LAB_HOST);
  vi.stubEnv('PROXY_ORIGIN', PROXY_ORIGIN);
  vi.stubEnv('PROXY_BASE', '/id-jag-kit');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

const req = (headers) => ({ headers });
const proxied = (host = `${LAB_HOST}:4720`, extra = {}) => ({ host, ...fwd, ...extra });

describe('LAB_ALLOWED_HOSTS parsing', () => {
  it('keeps bare DNS names, lowercased and de-duplicated; drops ports, schemes, paths, spaces and junk', () => {
    expect(labAllowedHosts('A.Example, a.example ,b.example')).toEqual(['a.example', 'b.example']);
    for (const bad of ['a.example:4720', 'http://a.example', 'a.example/x', 'a b.example', '-a.example', 'a..example', '@a.example', '', ' ', undefined]) {
      expect(labAllowedHosts(bad), String(bad)).toEqual([]);
    }
  });
  it('unset means loopback only (plus the APP_ORIGIN host)', () => {
    vi.stubEnv('LAB_ALLOWED_HOSTS', '');
    expect([...allowedHosts()].sort()).toEqual(['127.0.0.1', '[::1]', 'localhost']);
  });
});

describe('Host check', () => {
  const get = (host) => request(createApp()).get('/api/health').set('Host', host);
  it('answers the LAB_ALLOWED_HOSTS name (any port), and still refuses an unlisted name', async () => {
    expect((await get(`${LAB_HOST}:4720`)).status).toBe(200);
    expect((await get(LAB_HOST.toUpperCase())).status).toBe(200);
    const bad = await get('other.example:4720');
    expect([bad.status, bad.body.error]).toEqual([403, 'invalid_host']);
    expect((await get(`x.${LAB_HOST}`)).status).toBe(403);
  });
  it('is invalid_host for that name when LAB_ALLOWED_HOSTS is unset (the old behaviour)', async () => {
    vi.stubEnv('LAB_ALLOWED_HOSTS', '');
    const r = await get(`${LAB_HOST}:4720`);
    expect([r.status, r.body.error]).toEqual([403, 'invalid_host']);
  });
});

describe('requestOrigin / requestBase', () => {
  it('through the proxy: the proxy origin for CSRF and origin + base path for redirect URIs', () => {
    expect(requestOrigin(req(proxied()))).toBe(PROXY_ORIGIN);
    expect(requestBase(req(proxied()))).toBe(`${PROXY_ORIGIN}/id-jag-kit`);
    expect(requestOrigin(req(proxied(LAB_HOST, { 'x-forwarded-proto': undefined })))).toBe(PROXY_ORIGIN); // proto absent: believed as the proxy's
  });
  it('direct: APP_ORIGIN, and forwarded headers are ignored', () => {
    expect(requestOrigin(req({ host: 'localhost:4720' }))).toBe('http://localhost:4720');
    expect(requestBase(req({ host: LAB_HOST }))).toBe('http://localhost:4720'); // listed Host but no forwarded headers
  });
  it('ignores the forwarded headers on a loopback Host, an unlisted Host, a wrong forwarded host or proto, or unset settings', () => {
    for (const host of ['localhost:4720', '127.0.0.1:4720', '[::1]:4720', 'other.example:4720', `x.${LAB_HOST}`, '']) {
      expect(requestOrigin(req(proxied(host))), host).toBe('http://localhost:4720');
      expect(requestBase(req(proxied(host))), host).toBe('http://localhost:4720');
    }
    for (const extra of [{ 'x-forwarded-host': 'evil.example' }, { 'x-forwarded-host': '' }, { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'ftp' }]) {
      expect(requestOrigin(req(proxied(LAB_HOST, extra))), JSON.stringify(extra)).toBe('http://localhost:4720');
    }
    vi.stubEnv('LAB_ALLOWED_HOSTS', '');
    expect(requestOrigin(req(proxied()))).toBe('http://localhost:4720');
    vi.stubEnv('LAB_ALLOWED_HOSTS', LAB_HOST);
    vi.stubEnv('PROXY_ORIGIN', '');
    expect(requestOrigin(req(proxied()))).toBe('http://localhost:4720');
  });
});

describe('same-origin writes through the app', () => {
  const post = (path, headers) => request(createApp()).post(path).set(headers).send({ mode: path.endsWith('/api/mode') ? 'mock' : 'pf-as' });
  const MODE_PATHS = ['/api/mode', '/api/id-jag-playground/mode'];
  it.each(MODE_PATHS)('%s: accepted with the proxy origin on the listed Host', async (path) => {
    const r = await post(path, proxied(`${LAB_HOST}:4720`, { origin: PROXY_ORIGIN }));
    expect([path, r.status]).toEqual([path, 200]);
  });
  it.each(MODE_PATHS)('%s: refused with a foreign origin or the wrong scheme/port on the listed Host', async (path) => {
    for (const origin of ['https://evil.example', 'https://front.example:9999', 'http://front.example:8443', 'http://localhost:4720']) {
      const r = await post(path, proxied(`${LAB_HOST}:4720`, { origin }));
      expect([path, origin, r.status, r.body.error]).toEqual([path, origin, 403, 'invalid_origin']);
    }
    const none = await post(path, proxied());
    expect([none.status, none.body.error]).toEqual([403, 'invalid_origin']);
  });
  it.each(MODE_PATHS)('%s: the proxy origin is NOT believed on a loopback Host or when LAB_ALLOWED_HOSTS is unset', async (path) => {
    for (const host of ['localhost:4720', '127.0.0.1:4720']) {
      const r = await post(path, proxied(host, { origin: PROXY_ORIGIN }));
      expect([path, host, r.status, r.body.error]).toEqual([path, host, 403, 'invalid_origin']);
    }
    vi.stubEnv('LAB_ALLOWED_HOSTS', '');
    const r = await post(path, proxied(`${LAB_HOST}:4720`, { origin: PROXY_ORIGIN }));
    expect([r.status, r.body.error]).toEqual([403, 'invalid_host']);
  });
  it.each(MODE_PATHS)('%s: direct use on localhost keeps working with APP_ORIGIN', async (path) => {
    const r = await post(path, { host: 'localhost:4720', origin: 'http://localhost:4720' });
    expect([path, r.status]).toEqual([path, 200]);
  });
});
