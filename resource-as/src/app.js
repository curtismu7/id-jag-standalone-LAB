// Resource authorization server: RFC 8414 metadata, its JWKS, and a token
// endpoint that redeems ID-JAGs (jwt-bearer grant) and nothing else.
import { createHash, createPublicKey, randomUUID, timingSafeEqual } from 'node:crypto';
import * as jose from 'jose';
import { ID_JAG_GRANT_PROFILE, JWT_BEARER_GRANT, OAuthError, createReplayStore, trimSlash, verifyIdJag } from './idjag.js';
import { createTrustedIdps, getJson } from './trusted-idps.js';
import { createEvents, renderPage } from './events.js';

const MAX_BODY_BYTES = 64 * 1024;
const words = (s) => (s || '').split(' ').filter(Boolean);
const sha256 = (s) => createHash('sha256').update(s).digest();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new OAuthError('invalid_request', 'request body too large', 413);
  }
  return body;
}

/**
 * @param config.signingKey  RSA private KeyObject
 * @param config.clients     [{ client_id, client_secret_hash?, scope }]; no hash = public client
 * @param config.reloadClients () => clients; called on every token request when set (clients provisioned or rotated at runtime)
 * @param config.idps        trusted IdPs from TRUSTED_IDPS_FILE (win issuer collisions)
 * @param config.registry    { url, token, caFile, cacheMs } or undefined
 * @param config.replayFile  persist the jti replay cache here (optional)
 */
export function createHandler({
  issuer, acceptedResources, clients, reloadClients, allowPublicClients = false, accessTokenTtl = 3600,
  signingKey, idps = [], registry, replayFile, log = console.log,
}) {
  const { kty, n, e } = createPublicKey(signingKey).export({ format: 'jwk' });
  const kid = createHash('sha256').update(JSON.stringify({ e, kty, n })).digest('base64url'); // RFC 7638 thumbprint
  const jwks = { keys: [{ kty, n, e, kid, use: 'sig', alg: 'RS256' }] };
  const metadata = {
    issuer,
    // RFC 8414 lets an AS with no redirect grants omit these two, but MCP SDK clients (mcpc, VS Code) require
    // them: advertise no response types, and an /authorize that says so.
    authorization_endpoint: `${issuer}/authorize`,
    response_types_supported: [],
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    grant_types_supported: [JWT_BEARER_GRANT],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', ...(allowPublicClients ? ['none'] : [])],
    authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
  };
  let clientsById = new Map(clients.map((c) => [c.client_id, c]));
  // ponytail: re-reads the (small) file per token request; watch it instead if redemptions get hot.
  function currentClients() {
    if (!reloadClients) return clientsById;
    try {
      clientsById = new Map(reloadClients().map((c) => [c.client_id, c]));
    } catch (err) {
      log(`[resource-as] CLIENTS_FILE reload failed; keeping the last good list: ${err.message}`);
    }
    return clientsById;
  }
  const trustedIdps = createTrustedIdps({ fileIdps: idps, registry, log });
  const replay = createReplayStore(replayFile);
  const decisions = createEvents();
  const remoteJwks = new Map();

  function keyResolver(idp) {
    return async (header, token) => {
      // PingFederate identifies certificate-backed keys by x5t, and a static PF
      // key set lists the same key under several kids. jose's JWKS selector only
      // matches kid, so resolve x5t here and require one DISTINCT key behind it.
      if (header.x5t) {
        const { keys = [] } = await getJson(idp.jwksUrl);
        const matches = keys.filter((k) => k.x5t === header.x5t && (!k.alg || k.alg === header.alg));
        const distinct = new Map(matches.map((k) => [`${k.kty}.${k.n}.${k.e}.${k.crv}.${k.x}.${k.y}`, k]));
        if (distinct.size !== 1) throw new Error(`expected one JWKS key for x5t ${header.x5t}, found ${distinct.size}`);
        return jose.importJWK([...distinct.values()][0], header.alg);
      }
      if (!remoteJwks.has(idp.jwksUrl)) remoteJwks.set(idp.jwksUrl, jose.createRemoteJWKSet(new URL(idp.jwksUrl)));
      return remoteJwks.get(idp.jwksUrl)(header, token);
    };
  }

  function authenticateClient(req, params, ctx) {
    const clientsById = currentClients();
    let id = params.get('client_id');
    let secrets = [params.get('client_secret')].filter(Boolean);
    const header = req.headers.authorization || '';
    if (/^basic /i.test(header)) {
      if (secrets.length) throw new OAuthError('invalid_request', 'use one client authentication method, not two');
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon < 0) throw new OAuthError('invalid_client', 'malformed Basic credentials', 401);
      // RFC 6749 §2.3.1 form-encodes id and secret before Basic, but curl -u and
      // most libraries send them raw: accept either spelling.
      const unform = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
      const rawId = decoded.slice(0, colon);
      id = clientsById.has(rawId) ? rawId : unform(rawId);
      secrets = [decoded.slice(colon + 1), unform(decoded.slice(colon + 1))];
    }
    ctx.client_id = id ?? undefined;
    const client = id ? clientsById.get(id) : undefined;
    if (!client) throw new OAuthError('invalid_client', 'client authentication failed', 401);
    if (client.client_secret_hash) {
      const expected = Buffer.from(client.client_secret_hash, 'hex');
      if (!secrets.some((s) => timingSafeEqual(sha256(s), expected))) {
        throw new OAuthError('invalid_client', 'client authentication failed', 401);
      }
    } else if (!allowPublicClients) {
      throw new OAuthError('invalid_client', 'public clients are not allowed (ALLOW_PUBLIC_CLIENTS is off)', 401);
    }
    return client;
  }

  async function redeem(req, params, ctx) {
    const client = authenticateClient(req, params, ctx);
    const grantType = params.get('grant_type');
    if (!grantType) throw new OAuthError('invalid_request', 'grant_type is required');
    if (grantType !== JWT_BEARER_GRANT) throw new OAuthError('unsupported_grant_type', `only ${JWT_BEARER_GRANT} is supported`);
    const assertion = params.get('assertion');
    if (!assertion) throw new OAuthError('invalid_request', 'assertion is required');
    const resources = params.getAll('resource');
    if (resources.length > 1) throw new OAuthError('invalid_target', 'request at most one resource');

    // Pick the IdP by the UNVERIFIED iss; verifyIdJag then checks everything
    // against that IdP alone.
    try {
      const unverified = jose.decodeJwt(assertion);
      ctx.iss = unverified.iss;
      ctx.jti = unverified.jti; // for the decision record; replay protection still uses the verified claims
    } catch { /* malformed: not trusted below */ }
    const idp = (await trustedIdps()).find((t) => t.issuer === ctx.iss);
    if (!idp) throw new OAuthError('invalid_grant', 'ID-JAG issuer is not trusted');

    const claims = await verifyIdJag(assertion, {
      idp, ownIssuer: issuer, acceptedResources, clientId: client.client_id, getKey: keyResolver(idp),
    });
    ctx.sub = claims.sub;
    if (resources[0] && trimSlash(resources[0]) !== trimSlash(claims.resource)) {
      throw new OAuthError('invalid_target', 'requested resource differs from the ID-JAG resource');
    }

    // Granted = ID-JAG scope AND client scope AND request scope (when sent) AND
    // IdP cap (when set). Never widened, never defaulted: empty is an error.
    const allowed = new Set(words(client.scope));
    const requested = new Set(words(params.get('scope')));
    const cap = new Set(words(idp.scopes));
    const granted = [...new Set(words(claims.scope))].filter((s) =>
      allowed.has(s) && (!requested.size || requested.has(s)) && (!cap.size || cap.has(s)));
    if (!granted.length) throw new OAuthError('invalid_scope', 'ID-JAG grants no scope this client may use for this request');

    if (!replay.consume(claims.iss, claims.jti, claims.exp)) {
      throw new OAuthError('invalid_grant', 'ID-JAG already redeemed (replay rejected)');
    }

    const scope = granted.join(' ');
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new jose.SignJWT({ client_id: client.client_id, scope })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid })
      .setIssuer(issuer)
      .setSubject(claims.sub)
      .setAudience(claims.resource) // RFC 8707: the token is good for this one resource only
      .setIssuedAt(now)
      .setExpirationTime(now + accessTokenTtl)
      .setJti(randomUUID())
      .sign(signingKey);
    Object.assign(ctx, { aud: claims.resource, scope });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: accessTokenTtl, scope };
  }

  return async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname === '/.well-known/oauth-authorization-server') return send(res, 200, metadata);
    if (req.method === 'GET' && pathname === '/jwks') return send(res, 200, jwks);
    if (pathname === '/authorize') {
      return send(res, 400, { error: 'unsupported_response_type', error_description: `this authorization server only redeems ID-JAGs (${JWT_BEARER_GRANT} at /token)` });
    }
    if (req.method === 'GET' && pathname === '/events') {
      return send(res, 200, { issuer, events: decisions.events }, { 'cache-control': 'no-store' });
    }
    if (req.method === 'GET' && pathname === '/') {
      const idps = (await trustedIdps()).map(({ id, issuer }) => ({ id, issuer }));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
      });
      return res.end(renderPage({ issuer, idps, events: decisions.events }));
    }
    if (pathname !== '/token') return send(res, 404, { error: 'not_found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'invalid_request', error_description: 'use POST' }, { allow: 'POST' });

    const ctx = {};
    try {
      const body = await redeem(req, new URLSearchParams(await readBody(req)), ctx);
      log(JSON.stringify({ decision: 'accepted', ...ctx }));
      decisions.record('accepted', ctx);
      send(res, 200, body, { 'cache-control': 'no-store' });
    } catch (err) {
      const oauth = err instanceof OAuthError ? err : new OAuthError('server_error', 'internal error', 500);
      log(JSON.stringify({ decision: 'refused', error: oauth.error, reason: err.message, ...ctx }));
      decisions.record('refused', ctx, { error: oauth.error, reason: oauth.message });
      const headers = { 'cache-control': 'no-store' };
      if (oauth.status === 401 && /^basic /i.test(req.headers.authorization || '')) headers['www-authenticate'] = 'Basic realm="resource-as"';
      send(res, oauth.status, { error: oauth.error, error_description: oauth.message }, headers);
    }
  };
}
