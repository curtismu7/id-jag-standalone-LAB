// The netguard: the one door out of this app. Every outbound call goes through it.
//   mock  a call to a host of the in-process mock is answered by the mock; a call to a loopback address goes on; everything
//         else is refused before any socket exists, and counted. The real network is never touched.
//   live  every call goes on, as it always did (the live settings name the servers; see the README for what is called).
// It counts what it did, so a test (and the doctor) can assert that mock mode made zero real attempts.

export class NetguardRefused extends Error {
  constructor(host) {
    super(`Mock mode: outbound call to ${host} refused (only the in-process mock and loopback are allowed)`);
    this.name = 'NetguardRefused';
    this.code = 'NETGUARD_REFUSED';
  }
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopback = (hostname) => LOOPBACK_NAMES.has(hostname) || /^127(\.\d{1,3}){3}$/.test(hostname);

/** What a URL is, for the guard: 'mock' (a host of the mock world), 'loopback', or 'other' (also anything unparsable). */
export function classify(url, mockOrigins) {
  let u;
  try { u = new URL(typeof url === 'object' && url !== null && 'url' in url ? url.url : String(url)); } catch { return { kind: 'other', host: 'an invalid URL' }; }
  if (mockOrigins.has(u.origin)) return { kind: 'mock', host: u.host };
  return { kind: isLoopback(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:') ? 'loopback' : 'other', host: u.host };
}

/**
 * @param o.mode         () => 'mock' | 'live'
 * @param o.mock         { origins: Set<string>, fetch }  the in-process mock
 * @param o.realFetch    the fetch used for loopback and for live mode (looked up at call time, so tests may replace it)
 */
export function createNetguard({ mode, mock, realFetch = (...a) => globalThis.fetch(...a) }) {
  const stats = { mock: 0, loopback: 0, live: 0, refused: 0 };

  /** For callers that open sockets themselves (node:http, node:https): throws unless the call may go on. */
  function assertAllowed(url) {
    if (mode() !== 'mock') { stats.live += 1; return; }
    const { kind, host } = classify(url, mock.origins);
    if (kind === 'loopback') { stats.loopback += 1; return; }
    stats.refused += 1;
    throw new NetguardRefused(host);
  }

  async function fetchImpl(url, init) {
    if (mode() !== 'mock') { stats.live += 1; return realFetch(url, init); }
    const { kind, host } = classify(url, mock.origins);
    if (kind === 'mock') { stats.mock += 1; return mock.fetch(url, init); }
    if (kind === 'loopback') { stats.loopback += 1; return realFetch(url, init); }
    stats.refused += 1;
    throw new NetguardRefused(host);
  }

  /**
   * Proves the guard holds, without touching the network: in mock mode a real host must be refused and the real fetch must
   * not be called, for fetch and for the socket door. The counters are put back afterwards. Live mode has nothing to prove.
   */
  async function selfTest() {
    if (mode() !== 'mock') return { ok: true, checks: [{ name: 'live mode: calls go on to the configured servers', ok: true }] };
    const before = { ...stats };
    let realCalled = 0;
    const probe = createNetguard({ mode, mock, realFetch: () => { realCalled += 1; return Promise.reject(new Error('real fetch called')); } });
    const refused = async (fn) => { try { await fn(); return false; } catch (e) { return e instanceof NetguardRefused; } };
    const checks = [
      { name: 'mock mode refuses a real host (fetch)', ok: await refused(() => probe.fetch('https://example.com/')) },
      { name: 'mock mode refuses a real host (sockets)', ok: await refused(() => probe.assertAllowed('https://example.com/')) },
      { name: 'mock mode refuses an unparsable URL', ok: await refused(() => probe.fetch('not a url')) },
      { name: 'mock mode counts the refusals', ok: probe.stats().refused === 3 },
      { name: 'mock mode never calls the real fetch', ok: realCalled === 0 },
    ];
    Object.assign(stats, before);
    return { ok: checks.every((c) => c.ok), checks };
  }

  return { fetch: fetchImpl, assertAllowed, selfTest, stats: () => ({ ...stats }), _reset: () => Object.assign(stats, { mock: 0, loopback: 0, live: 0, refused: 0 }) };
}
