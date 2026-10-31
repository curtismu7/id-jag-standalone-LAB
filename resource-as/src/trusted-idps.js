// The IdPs whose ID-JAGs this AS redeems: entries from TRUSTED_IDPS_FILE plus
// an optional registry (the playground server's
// GET /api/id-jag-playground/trusted-idps/registry).
//
// The registry decides whose assertions we accept, so the fetch is
// authenticated both ways: we send a bearer token, and we verify the server's
// TLS certificate against REGISTRY_CA_FILE when set, else the default trust
// store (system roots + NODE_EXTRA_CA_CERTS). Never skipped. A failed fetch
// keeps the last good list (warned once) and never throws.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const TIMEOUT_MS = 3_000;

/** GET a JSON document. Rejects on non-200, bad JSON, TLS failure or timeout. */
export function getJson(url, { headers = {}, ca } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers, ca, timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`invalid JSON from ${url}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timed out fetching ${url}`)));
    req.on('error', reject);
  });
}

/** Keep well-formed entries only, in the shape the token endpoint uses. */
export function normalizeIdps(list) {
  if (!Array.isArray(list)) throw new Error('expected an array of trusted IdPs');
  return list
    .filter((e) => e && typeof e.issuer === 'string' && e.issuer && typeof e.jwksUrl === 'string' && e.jwksUrl)
    .map((e) => ({
      id: String(e.id ?? e.issuer),
      issuer: e.issuer,
      jwksUrl: e.jwksUrl,
      clientAliases: Object.fromEntries(Object.entries(e.clientAliases && typeof e.clientAliases === 'object' ? e.clientAliases : {})
        .filter(([, v]) => typeof v === 'string')),
      scopes: typeof e.scopes === 'string' ? e.scopes : '',
    }));
}

/**
 * Returns `async () => TrustedIdp[]`: file entries first (they win an issuer
 * collision), then the cached registry, refreshed when older than cacheMs.
 */
export function createTrustedIdps({ fileIdps = [], registry, log = console.warn }) {
  let fromRegistry = [];
  let fetchedAt = 0;
  let inflight = null;
  let warned = false;
  const cacheMs = registry?.cacheMs ?? 30_000;

  async function refresh() {
    if (Date.now() - fetchedAt < cacheMs) return;
    inflight ??= (async () => {
      try {
        const data = await getJson(registry.url, {
          headers: registry.token ? { authorization: `Bearer ${registry.token}` } : {},
          ca: registry.caFile ? fs.readFileSync(registry.caFile) : undefined,
        });
        fromRegistry = normalizeIdps(data?.idps);
        warned = false;
      } catch (err) {
        if (!warned) {
          log(`[resource-as] trusted-IdP registry fetch failed (${registry.url}); keeping last good list: ${err.message}`);
          warned = true;
        }
      } finally {
        fetchedAt = Date.now(); // failures also wait out the cache window: no hammering
        inflight = null;
      }
    })();
    await inflight;
  }

  return async function trustedIdps() {
    if (registry?.url) await refresh();
    const fileIssuers = new Set(fileIdps.map((i) => i.issuer));
    return [...fileIdps, ...fromRegistry.filter((r) => !fileIssuers.has(r.issuer))];
  };
}
