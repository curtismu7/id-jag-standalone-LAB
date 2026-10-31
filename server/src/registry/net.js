// Outbound fetches on behalf of signed-in users (issuer discovery, "Test this IdP"). https only,
// no redirects, 4 s timeout, size cap, and an SSRF guard: private, loopback and link-local
// addresses are refused, checked on the addresses the connection actually uses (no DNS-rebinding
// gap). ALLOW_PRIVATE_ISSUERS=true turns the guard off for local development.

import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const fail = (status, message) => Object.assign(new Error(message), { status });
const allowPrivate = () => process.env.ALLOW_PRIVATE_ISSUERS === 'true';

// One list per family: a BlockList checks IPv4 against IPv4-mapped IPv6 rules too, so ::ffff:0:0/96
// in a shared list would block every IPv4 address.
const blockList = (family, subnets) => {
  const b = new net.BlockList();
  for (const [a, p] of subnets) b.addSubnet(a, p, family);
  return b;
};
const blockedV4 = blockList('ipv4', [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]);
// ::/96 covers ::, ::1 and IPv4-compatible ::a.b.c.d; ::ffff:0:0/96 IPv4-mapped; ::ffff:0:0:0/96 IPv4-translated.
const blockedV6 = blockList('ipv6', [['::', 96], ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]);

/** True for private, loopback, link-local, CGNAT, multicast, reserved and IPv4-mapped addresses (and non-addresses). */
export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return blockedV4.check(ip, 'ipv4');
  return family === 6 ? blockedV6.check(ip, 'ipv6') : true;
}

/** Must be https; hosts that are private before any DNS (literal IPs, localhost) are refused. Returns the URL as typed. */
export function publicHttpsUrl(value, field) {
  const s = typeof value === 'string' ? value.trim() : '';
  let u;
  try { u = new URL(s); } catch { /* below */ }
  if (u?.protocol !== 'https:') throw fail(400, `${field} must be an https URL`);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate() && (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isPrivateAddress(host)))) {
    throw fail(400, `${field} points at a private or loopback address`);
  }
  return s;
}

/** A net lookup() that refuses hostnames resolving to any private address. */
export function guardedLookup(resolve = dns.lookup) {
  return (hostname, opts, cb) => resolve(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!allowPrivate() && addrs.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error(`${hostname} resolves to a private or loopback address`), { code: 'EPRIVATE' }));
    }
    return opts?.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });
}

/** GET a JSON document from a public https URL. */
export function getJson(url, { timeoutMs = 4000, maxBytes = 512 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    try { publicHttpsUrl(url, 'URL'); } catch (err) { return reject(err); }
    const req = https.get(url, { lookup: guardedLookup(), signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(fail(502, `${url} answered HTTP ${res.statusCode}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(fail(502, `${url} sent more than ${maxBytes} bytes`));
        else chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(fail(502, `${url} did not answer JSON`)); }
      });
      return undefined;
    });
    req.on('error', (err) => reject(err.status ? err : fail(502, err.name === 'AbortError'
      ? `${url} did not answer within ${timeoutMs / 1000} s` : `${url}: ${err.message}`)));
    return undefined;
  });
}

/** Issuer -> jwks_uri via OIDC discovery, then RFC 8414. The metadata issuer must match exactly. */
export async function discover(issuerInput, { fetchJson = getJson } = {}) {
  const issuer = publicHttpsUrl(issuerInput, 'issuer');
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  const urls = [`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, `${u.origin}/.well-known/oauth-authorization-server${path}`];
  const errors = [];
  for (const url of urls) {
    let meta;
    try { meta = await fetchJson(url); } catch (err) { errors.push(err.message); continue; }
    if (meta?.issuer !== issuer) { errors.push(`${url} names issuer ${JSON.stringify(meta?.issuer)}, not ${issuer} (they must match exactly)`); continue; }
    return { issuer, jwksUrl: publicHttpsUrl(meta.jwks_uri, 'jwks_uri'), metadataUrl: url, tokenEndpoint: meta.token_endpoint || null };
  }
  throw fail(422, `Discovery failed: ${errors.join('; ')}`);
}

/** Fetch an IdP's JWKS and report what a redeemer will see. */
export async function testIdp({ jwksUrl, targets } = {}, { fetchJson = getJson } = {}) {
  const url = publicHttpsUrl(jwksUrl, 'jwksUrl');
  const jwks = await fetchJson(url);
  const keys = Array.isArray(jwks?.keys) ? jwks.keys.filter((k) => k && typeof k === 'object') : [];
  // A static JWKS can list one key under several kids: count keys, not entries.
  const distinctRsaKeys = new Set(keys.filter((k) => k.kty === 'RSA').map((k) => `${k.n}.${k.e}`)).size;
  const warnings = [];
  if (!keys.length) warnings.push('The JWKS has no keys: no ID-JAG from this IdP can verify.');
  if (distinctRsaKeys > 1 && Array.isArray(targets) && targets.includes('pingfederate')) {
    warnings.push(`${distinctRsaKeys} distinct RSA keys. PingFederate's JWT-bearer consumer cannot pick a key by x5t; publish a single-key JWKS.`);
  }
  return {
    jwksUrl: url, keyCount: keys.length, distinctRsaKeys,
    withKid: keys.filter((k) => k.kid).length, withX5t: keys.filter((k) => k.x5t).length,
    keys: keys.map((k) => ({ kty: k.kty ?? null, alg: k.alg ?? null, use: k.use ?? null, kid: k.kid ?? null, x5t: k.x5t ?? null })),
    warnings,
  };
}
