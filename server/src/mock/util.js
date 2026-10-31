// Shared bits of the mock servers: keys, signed tokens, and the small HTTP helpers that make a fetch Response.
// Keys come from createECDH + createPrivateKey (generateKeyPair is never used for EC: it aborts on some Node builds).
import crypto from 'node:crypto';
import * as jose from 'jose';

export const MARK = { mock: true }; // every token the mock issues carries this claim: it is simulated

/** A P-256 signing key and the JWK that publishes it. */
export function createEcKey(kid) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  const x = pub.subarray(1, 33).toString('base64url');
  const y = pub.subarray(33, 65).toString('base64url');
  const privateKey = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x, y, d: ecdh.getPrivateKey().toString('base64url') }, format: 'jwk' });
  return { kid, privateKey, publicKey: crypto.createPublicKey(privateKey), jwk: { kty: 'EC', crv: 'P-256', x, y, kid, alg: 'ES256', use: 'sig' } };
}

export const rand = (n = 18) => crypto.randomBytes(n).toString('base64url');
export const now = () => Math.floor(Date.now() / 1000);

/** A compact JWT signed ES256 by `key`. `claims` already hold iss/sub/aud/exp as the caller wants them. */
export function sign(key, header, claims) {
  return new jose.SignJWT({ ...MARK, ...claims }).setProtectedHeader({ alg: 'ES256', kid: key.kid, ...header }).sign(key.privateKey);
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** A parsed view of the fetch() call: method, URL, headers, raw body, and the body as a form. */
export function parseRequest(url, init = {}) {
  const u = new URL(url);
  const headers = new Headers(init.headers || {});
  const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : '';
  return { method: String(init.method || 'GET').toUpperCase(), url: u, path: u.pathname, headers, body, form: new URLSearchParams(body) };
}

export const oauthError = (status, error, description) => json(status, { error, error_description: description });

/** Client credentials from Basic or from the body; undefined fields when absent. */
export function clientCredentials(req) {
  const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) return { id: decoded.slice(0, i), secret: decoded.slice(i + 1) };
  }
  return { id: req.form.get('client_id') ?? undefined, secret: req.form.get('client_secret') ?? undefined };
}

export function sameSecret(a, b) {
  const h = (v) => crypto.createHash('sha256').update(String(v ?? '')).digest();
  return Boolean(b) && crypto.timingSafeEqual(h(a), h(b));
}

export const words = (s) => String(s ?? '').split(/\s+/).filter(Boolean);
export const sha256b64 = (s) => crypto.createHash('sha256').update(s).digest('base64url');
