// A mock resource authorization server, in process. Same rules as resource-as/ (RFC 8414 metadata, a JWKS, and a token
// endpoint that redeems ID-JAGs with the JWT bearer grant and nothing else): the ID-JAG's typ, issuer, audience, expiry,
// resource and client binding are all checked, a jti is accepted once, and the granted scope is never wider than the
// ID-JAG, the client or the IdP's cap. Its access tokens carry "mock": true. Clients and trusted IdPs come from
// the callers, so approving a Trusted IdP in the app changes what this server accepts, as it does with the real one.

import { createHash, timingSafeEqual } from 'node:crypto';
import * as jose from 'jose';
import { createEcKey, json, now, oauthError, parseRequest, rand, sign, words } from './util.js';
import { ID_JAG_TYP } from './pf.js';

const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const PROFILE = 'urn:ietf:params:oauth:grant-profile:id-jag';
const MAX_EVENTS = 50;
const trimSlash = (u) => String(u).replace(/\/$/, '');
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const sub = (v) => (typeof v === 'string' && v ? (v.includes('@') ? `${v[0]}***${v.slice(v.indexOf('@'))}` : `${v.slice(0, 4)}…`) : undefined);

/**
 * @param o.origin       the issuer
 * @param o.resource     the one resource (MCP server) this server issues tokens for
 * @param o.clients      () => [{ client_id, client_secret_hash?, scope }]  hashes are sha256 hex, as in resource-as
 * @param o.idps         () => [{ id, issuer, jwksUrl, clientAliases, scopes }]  the trusted IdPs
 * @param o.fetchJwks    (url) => Promise<jwks>  how an IdP's keys are read (the mock world only knows its own hosts)
 */
export function createMockResourceAs({ origin, resource, clients, idps, fetchJwks }) {
  const key = createEcKey('mock-resource-as-1');
  const seen = new Map(); // `${iss} ${jti}` -> exp
  let events = [];
  const metadata = {
    issuer: origin, authorization_endpoint: `${origin}/authorize`, response_types_supported: [], token_endpoint: `${origin}/token`,
    jwks_uri: `${origin}/jwks`, grant_types_supported: [JWT_BEARER], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    authorization_grant_profiles_supported: [PROFILE],
  };

  const record = (decision, ctx, extra = {}) => {
    events = [{ at: new Date().toISOString(), decision, ...extra, iss: ctx.iss, client_id: ctx.client_id, sub: sub(ctx.sub), aud: ctx.aud, scope: ctx.scope,
      jti: typeof ctx.jti === 'string' && ctx.jti ? `${ctx.jti.slice(0, 8)}…` : undefined }, ...events].slice(0, MAX_EVENTS);
  };

  function authenticate(req, ctx) {
    let id = req.form.get('client_id');
    let secret = req.form.get('client_secret');
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1];
    if (basic) {
      const d = Buffer.from(basic, 'base64').toString('utf8');
      const i = d.indexOf(':');
      if (i < 0) throw Object.assign(new Error('malformed Basic credentials'), { oauth: ['invalid_client', 401] });
      id = d.slice(0, i); secret = d.slice(i + 1);
    }
    ctx.client_id = id ?? undefined;
    const client = clients().find((c) => c.client_id === id);
    const ok = client?.client_secret_hash && secret
      && timingSafeEqual(Buffer.from(sha256hex(secret), 'hex'), Buffer.from(client.client_secret_hash, 'hex'));
    if (!ok) throw Object.assign(new Error('client authentication failed'), { oauth: ['invalid_client', 401] });
    return client;
  }

  async function verifyIdJag(assertion, idp, clientId) {
    let payload;
    try {
      const keys = jose.createLocalJWKSet(await fetchJwks(idp.jwksUrl));
      ({ payload } = await jose.jwtVerify(assertion, keys, {
        algorithms: ['ES256', 'RS256'], typ: ID_JAG_TYP, issuer: idp.issuer, audience: origin, clockTolerance: 5,
        requiredClaims: ['iss', 'sub', 'aud', 'client_id', 'jti', 'exp', 'iat'],
      }));
    } catch (err) {
      throw Object.assign(new Error(`ID-JAG verification failed: ${err.message}`), { oauth: ['invalid_grant', 400] });
    }
    if (Array.isArray(payload.aud) && payload.aud.length !== 1) throw Object.assign(new Error('ID-JAG aud must name exactly one authorization server'), { oauth: ['invalid_grant', 400] });
    if (typeof payload.resource !== 'string' || trimSlash(payload.resource) !== trimSlash(resource)) {
      throw Object.assign(new Error(`ID-JAG resource "${payload.resource}" is not served by this authorization server`), { oauth: ['invalid_target', 400] });
    }
    // Strict binding: client_id must be one this IdP may write, and map to the redeeming client.
    if (typeof payload.client_id !== 'string' || !Object.hasOwn(idp.clientAliases || {}, payload.client_id) || idp.clientAliases[payload.client_id] !== clientId) {
      throw Object.assign(new Error('ID-JAG client_id is not assigned to this IdP'), { oauth: ['invalid_grant', 400] });
    }
    return { ...payload, resource };
  }

  async function redeem(req, ctx) {
    const client = authenticate(req, ctx);
    const grant = req.form.get('grant_type');
    if (!grant) throw Object.assign(new Error('grant_type is required'), { oauth: ['invalid_request', 400] });
    if (grant !== JWT_BEARER) throw Object.assign(new Error(`only ${JWT_BEARER} is supported`), { oauth: ['unsupported_grant_type', 400] });
    const assertion = req.form.get('assertion');
    if (!assertion) throw Object.assign(new Error('assertion is required'), { oauth: ['invalid_request', 400] });
    try { const u = jose.decodeJwt(assertion); ctx.iss = u.iss; ctx.jti = u.jti; } catch { /* untrusted below */ }
    const idp = idps().find((t) => t.issuer === ctx.iss);
    if (!idp) throw Object.assign(new Error('ID-JAG issuer is not trusted'), { oauth: ['invalid_grant', 400] });
    const claims = await verifyIdJag(assertion, idp, client.client_id);
    ctx.sub = claims.sub;
    const asked = req.form.getAll('resource');
    if (asked.length > 1) throw Object.assign(new Error('request at most one resource'), { oauth: ['invalid_target', 400] });
    if (asked[0] && trimSlash(asked[0]) !== trimSlash(claims.resource)) throw Object.assign(new Error('requested resource differs from the ID-JAG resource'), { oauth: ['invalid_target', 400] });
    // Granted = ID-JAG scope AND client scope AND request scope (when sent) AND IdP cap (when set). Never widened.
    const allowed = new Set(words(client.scope));
    const requested = new Set(words(req.form.get('scope')));
    const cap = new Set(words(idp.scopes));
    const granted = [...new Set(words(claims.scope))].filter((s) => allowed.has(s) && (!requested.size || requested.has(s)) && (!cap.size || cap.has(s)));
    if (!granted.length) throw Object.assign(new Error('ID-JAG grants no scope this client may use for this request'), { oauth: ['invalid_scope', 400] });
    const at = `${claims.iss} ${claims.jti}`;
    for (const [k, exp] of seen) if (exp < Date.now() / 1000) seen.delete(k);
    if (seen.has(at)) throw Object.assign(new Error('ID-JAG already redeemed (replay rejected)'), { oauth: ['invalid_grant', 400] });
    seen.set(at, claims.exp + 5);
    const scope = granted.join(' ');
    Object.assign(ctx, { aud: claims.resource, scope });
    const iat = now();
    const access_token = await sign(key, { typ: 'at+jwt' }, { iss: origin, sub: claims.sub, aud: claims.resource, client_id: client.client_id, scope, iat, exp: iat + 3600, jti: rand() });
    return { access_token, token_type: 'Bearer', expires_in: 3600, scope };
  }

  async function handle(url, init) {
    const req = parseRequest(url, init);
    if (req.method === 'GET' && req.path === '/.well-known/oauth-authorization-server') return json(200, metadata);
    if (req.method === 'GET' && req.path === '/jwks') return json(200, { keys: [key.jwk] });
    if (req.method === 'GET' && req.path === '/events') return json(200, { issuer: origin, events });
    if (req.path === '/authorize') return oauthError(400, 'unsupported_response_type', `this authorization server only redeems ID-JAGs (${JWT_BEARER} at /token)`);
    if (req.path !== '/token') return json(404, { error: 'not_found' });
    if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'use POST');
    const ctx = {};
    try {
      const body = await redeem(req, ctx);
      record('accepted', ctx);
      return json(200, body);
    } catch (err) {
      const [error, status] = err.oauth || ['server_error', 500];
      record('refused', ctx, { error, reason: String(err.message).slice(0, 200) });
      return oauthError(status, error, err.oauth ? err.message : 'internal error');
    }
  }

  return {
    origin, publicKey: key.publicKey, handle,
    reset() { seen.clear(); events = []; },
  };
}
