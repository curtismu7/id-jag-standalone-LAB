// The netguard (server/src/netguard.js) with node:test: in mock mode every outbound call except the in-process mock and
// loopback is refused and counted, and the real fetch and the real sockets are never reached. Its self-test (which the
// doctor runs) is proved to fail when the guard leaks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NetguardRefused, classify, createNetguard } from '../server/src/netguard.js';
import { httpSend } from '../server/src/idp/pfAdmin.js';
import { _forceMode } from '../server/src/mode.js';
import { netguard as appGuard, outboundFetch } from '../server/src/outbound.js';

const MOCK = 'https://pf.mock.invalid';
const mockFetch = async () => new Response('{"from":"mock"}', { status: 200 });

function guardWith({ mode = 'mock', origins = new Set([MOCK]), onReal = () => {} } = {}) {
  const real = [];
  const g = createNetguard({ mode: () => mode, mock: { origins, fetch: mockFetch }, realFetch: async (url) => { real.push(String(url)); onReal(url); return new Response('{"from":"real"}'); } });
  return { g, real };
}

test('mock mode: a real host is refused, counted, and never reaches the real fetch', async () => {
  const { g, real } = guardWith();
  await assert.rejects(() => g.fetch('https://example.com/'), NetguardRefused);
  await assert.rejects(() => g.fetch('https://login.example.org/token', { method: 'POST' }), (e) => e.code === 'NETGUARD_REFUSED');
  assert.deepEqual(real, []);
  assert.deepEqual(g.stats(), { mock: 0, loopback: 0, live: 0, refused: 2 });
});

test('mock mode: the in-process mock answers its own hosts, loopback goes on, both are counted', async () => {
  const { g, real } = guardWith();
  assert.equal((await (await g.fetch(`${MOCK}/pf/JWKS`)).json()).from, 'mock');
  assert.equal((await (await g.fetch('http://127.0.0.1:4720/api/health')).json()).from, 'real');
  assert.equal((await (await g.fetch('http://localhost:4720/')).json()).from, 'real');
  assert.deepEqual(real, ['http://127.0.0.1:4720/api/health', 'http://localhost:4720/']);
  assert.deepEqual(g.stats(), { mock: 1, loopback: 2, live: 0, refused: 0 });
});

test('mock mode: look-alikes of loopback and of the mock host are refused', async () => {
  const { g, real } = guardWith();
  for (const url of [
    'http://localhost.example.com/', 'http://127.0.0.1.example.com/', 'http://[::ffff:7f00:1]/', 'http://0.0.0.0/',
    'https://pf.mock.invalid.example.com/', 'https://evil.pf.mock.invalid/', 'http://pf.mock.invalid/', 'https://pf.mock.invalid:8443/',
    'ftp://127.0.0.1/', 'not a url', '',
  ]) {
    await assert.rejects(() => g.fetch(url), NetguardRefused, url);
  }
  assert.deepEqual(real, []);
  assert.equal(g.stats().refused, 11);
});

test('mock mode: the socket door (node:http, node:https) refuses real hosts too', () => {
  const { g } = guardWith();
  assert.throws(() => g.assertAllowed('https://pf.example.com:9999/pf-admin-api/v1/x'), NetguardRefused);
  assert.doesNotThrow(() => g.assertAllowed('http://127.0.0.1:9999/'));
  assert.deepEqual(g.stats(), { mock: 0, loopback: 1, live: 0, refused: 1 });
});

test('live mode: calls go on to the real fetch, as before', async () => {
  const { g, real } = guardWith({ mode: 'live' });
  await g.fetch('https://pf.example.net/.well-known/openid-configuration');
  assert.deepEqual(real, ['https://pf.example.net/.well-known/openid-configuration']);
  assert.equal(g.stats().live, 1);
});

test('classify: a URL object and a Request are read like a string', () => {
  const origins = new Set([MOCK]);
  assert.equal(classify(new URL(`${MOCK}/x`), origins).kind, 'mock');
  assert.equal(classify(new Request('http://127.0.0.1/x'), origins).kind, 'loopback');
});

test('self-test: passes on a sound guard, leaves the counters as they were', async () => {
  const { g } = guardWith();
  await assert.rejects(() => g.fetch('https://example.com/'));
  const before = g.stats();
  const t = await g.selfTest();
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.checks.length, 5);
  assert.deepEqual(g.stats(), before);
});

test('self-test: FAILS when the guard leaks (a guard that treats every origin as the mock)', async () => {
  const leaky = guardWith({ origins: { has: () => true } });
  const t = await leaky.g.selfTest();
  assert.equal(t.ok, false);
  assert.ok(t.checks.some((c) => !c.ok && /refuses a real host/.test(c.name)), JSON.stringify(t));
});

test('the app\'s guard in mock mode: zero real attempts, and the pfAdmin socket door is shut', async () => {
  _forceMode('mock');
  appGuard._reset();
  try {
    await assert.rejects(() => outboundFetch('https://idp.xaa.dev/.well-known/openid-configuration'), NetguardRefused);
    await assert.rejects(() => outboundFetch('https://auth.resource.xaa.dev/token', { method: 'POST' }), NetguardRefused);
    assert.throws(() => httpSend('https://pf.example.net:9999/pf-admin-api/v1/oauth/clients/x', { method: 'GET', headers: {} }), NetguardRefused);
    const s = appGuard.stats();
    assert.deepEqual(s, { mock: 0, loopback: 0, live: 0, refused: 3 });
    assert.equal((await appGuard.selfTest()).ok, true);
  } finally {
    _forceMode(null);
    appGuard._reset();
  }
});
