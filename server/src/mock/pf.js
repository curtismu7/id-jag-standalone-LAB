// A mock PingFederate, in process. It answers what the app asks of the real one: OIDC discovery and JWKS, the pi.flow
// sign-in (code + PKCE), the token endpoint (authorization code, RFC 8693 exchange for an ID-JAG, RFC 7523 JWT bearer)
// and RFC 7009 revocation, plus the small slice of the admin API pfAdmin.js uses. It checks what the real one checks
// (client secret, PKCE, redirect URI, subject token ownership, audience, single use), so a failure here is a real failure.
// Everything it signs carries "mock": true and a kid starting "mock-". It opens no socket.

import crypto from 'node:crypto';
import * as jose from 'jose';
import { createEcKey, clientCredentials, json, now, oauthError, parseRequest, rand, sameSecret, sha256b64, sign, words } from './util.js';

export const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';
export const ID_JAG_TYP = 'oauth-id-jag+jwt';
const REFRESH_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:refresh_token';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ID_JAG_TTL = 300;
const FLOW_TTL_MS = 5 * 60 * 1000;

const column = (name, value) => ({ name, value });
const userRow = (username, password) => ({ defaultRow: false, fields: [
  column('Username', username), column('Relax Password Requirements', 'true'), column('Password', password), column('Confirm Password', password)] });
const field = (row, name) => row.fields.find((f) => f.name === name)?.value;

/**
 * @param o.origin      the issuer, e.g. https://pf.mock.invalid
 * @param o.label       short name used in kids
 * @param o.clients     { id: { secret, scope, idJagClientId? } } scope = what this client may be granted in an ID-JAG; idJagClientId =
 *                      the client_id the ID-JAG names (the SP connection maps the exchange client to the client at the redeemer)
 * @param o.user        { username, password, name } the first (anchor) user of the kit validator
 * @param o.validatorId id of the kit's password credential validator (the admin API path)
 * @param o.admin       { user, password } for the admin API
 */
export function createMockPf({ origin, label, clients, user, validatorId, admin }) {
  const key = createEcKey(`mock-${label}-1`);
  const flows = new Map();
  const codes = new Map();
  const refresh = new Map();
  const consumed = new Set(); // jti of ID-JAGs this server already accepted (RFC 7523 / draft single use)
  const peers = new Map(); // issuer -> public key of another mock PingFederate whose ID-JAGs this one accepts
  const validator = { id: validatorId, configuration: { tables: [{ name: 'Users', rows: [userRow(user.username, user.password)] }] } };
  const users = () => validator.configuration.tables.find((t) => t.name === 'Users').rows;
  const nameOf = (username) => (username === user.username ? user.name : username);

  const metadata = {
    issuer: origin,
    authorization_endpoint: `${origin}/as/authorization.oauth2`,
    token_endpoint: `${origin}/as/token.oauth2`,
    jwks_uri: `${origin}/pf/JWKS`,
    revocation_endpoint: `${origin}/as/revoke_token.oauth2`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', TOKEN_EXCHANGE, JWT_BEARER],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['ES256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  };

  const authenticate = (req) => {
    const { id, secret } = clientCredentials(req);
    const c = id && Object.hasOwn(clients, id) ? clients[id] : null;
    return c && sameSecret(secret, c.secret) ? { id, ...c } : null;
  };

  const accessToken = (claims) => sign(key, { typ: 'at+jwt' }, { iss: origin, iat: now(), exp: now() + 3600, jti: rand(), ...claims });

  async function authorize(req) {
    const q = req.url.searchParams;
    const c = Object.hasOwn(clients, q.get('client_id') ?? '') ? clients[q.get('client_id')] : null;
    if (!c) return oauthError(400, 'invalid_client', 'unknown client_id');
    if (q.get('response_type') !== 'code') return oauthError(400, 'unsupported_response_type', 'only code is supported');
    if (q.get('response_mode') !== 'pi.flow') return oauthError(400, 'invalid_request', 'this mock PingFederate signs in with pi.flow only (no redirect login)');
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return oauthError(400, 'invalid_request', 'PKCE (S256) is required');
    const id = rand(12);
    const cookie = rand(12);
    flows.set(id, { clientId: q.get('client_id'), redirectUri: q.get('redirect_uri'), state: q.get('state'), nonce: q.get('nonce'),
      challenge: q.get('code_challenge'), scope: q.get('scope') || '', cookie, at: Date.now() });
    return json(200, { id, status: 'USERNAME_PASSWORD_REQUIRED' }, { 'set-cookie': `PF=${cookie}; Path=/; HttpOnly` });
  }

  function credentials(req) {
    const id = req.path.split('/').pop();
    const flow = flows.get(id);
    if (!flow || Date.now() - flow.at > FLOW_TTL_MS) return json(404, { code: 'RESOURCE_NOT_FOUND', message: 'unknown flow' });
    if (req.headers.get('x-xsrf-header') !== 'PingFederate') return json(403, { code: 'ACCESS_FAILED', message: 'missing X-XSRF-Header' });
    if (!(req.headers.get('cookie') || '').split(/;\s*/).includes(`PF=${flow.cookie}`)) return json(403, { code: 'ACCESS_FAILED', message: 'flow cookie missing' });
    let body;
    try { body = JSON.parse(req.body); } catch { return json(400, { code: 'VALIDATION_ERROR', message: 'bad JSON' }); }
    const row = users().find((r) => String(field(r, 'Username')).toLowerCase() === String(body?.username ?? '').toLowerCase());
    if (!row || !sameSecret(body.password, field(row, 'Password'))) {
      return json(400, { code: 'VALIDATION_ERROR', details: [{ code: 'CREDENTIAL_VALIDATION_FAILED', userMessage: 'Invalid username or password' }] });
    }
    flows.delete(id);
    const code = rand(18);
    codes.set(code, { ...flow, username: String(field(row, 'Username')), at: Date.now() });
    return json(200, { id, status: 'COMPLETED', authorizeResponse: { code, state: flow.state } });
  }

  async function idTokenFor(rec) {
    return sign(key, { typ: 'JWT' }, {
      iss: origin, sub: rec.username, aud: rec.clientId, iat: now(), exp: now() + 300, nonce: rec.nonce, auth_time: now(),
      email: rec.username, email_verified: true, name: nameOf(rec.username),
    });
  }

  async function fromCode(req, c) {
    const f = req.form;
    const rec = codes.get(f.get('code') ?? '');
    codes.delete(f.get('code') ?? ''); // single use, whether or not it checks out
    if (!rec || Date.now() - rec.at > 60_000 || rec.clientId !== c.id) return oauthError(400, 'invalid_grant', 'the authorization code is invalid, expired or not yours');
    if (rec.redirectUri !== f.get('redirect_uri')) return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    if (sha256b64(f.get('code_verifier') ?? '') !== rec.challenge) return oauthError(400, 'invalid_grant', 'PKCE verification failed');
    const scope = words(rec.scope);
    const out = { token_type: 'Bearer', expires_in: 3600, scope: scope.join(' '), access_token: await accessToken({ sub: rec.username, client_id: c.id, scope: scope.join(' ') }) };
    if (scope.includes('offline_access')) {
      out.refresh_token = `mock-rt-${rand(24)}`;
      refresh.set(out.refresh_token, { clientId: c.id, username: rec.username, scope: scope.join(' '), active: true });
    }
    if (scope.includes('openid')) out.id_token = await idTokenFor(rec);
    return json(200, out);
  }

  async function exchange(req, c) {
    const f = req.form;
    if (f.get('requested_token_type') !== ID_JAG_TOKEN_TYPE) return oauthError(400, 'invalid_request', `requested_token_type must be ${ID_JAG_TOKEN_TYPE}`);
    if (f.get('subject_token_type') !== REFRESH_TOKEN_TYPE) return oauthError(400, 'invalid_request', `this mock accepts subject_token_type ${REFRESH_TOKEN_TYPE} only`);
    const audience = f.get('audience');
    if (!audience) return oauthError(400, 'invalid_request', 'audience is required');
    const rt = refresh.get(f.get('subject_token') ?? '');
    // A refresh token belongs to the client it was issued to, and a revoked one is dead.
    if (!rt || !rt.active || rt.clientId !== c.id) return oauthError(400, 'invalid_request', 'the subject token is invalid, revoked or was issued to another client');
    const allowed = words(c.scope);
    const asked = words(f.get('scope'));
    const granted = (asked.length ? asked : allowed).filter((s) => allowed.includes(s));
    if (!granted.length) return oauthError(400, 'invalid_scope', 'none of the requested scopes may be granted to this client');
    const resource = f.get('resource');
    const claims = { iss: origin, sub: rt.username, aud: audience, client_id: c.idJagClientId || c.id, jti: rand(), iat: now(), exp: now() + ID_JAG_TTL, scope: granted.join(' '), ...(resource ? { resource } : {}) };
    return json(200, { access_token: await sign(key, { typ: ID_JAG_TYP }, claims), issued_token_type: ID_JAG_TOKEN_TYPE, token_type: 'N_A', expires_in: ID_JAG_TTL, scope: granted.join(' ') });
  }

  async function redeem(req, c) {
    const assertion = req.form.get('assertion');
    if (!assertion) return oauthError(400, 'invalid_request', 'assertion is required');
    let iss;
    try { iss = jose.decodeJwt(assertion).iss; } catch { return oauthError(400, 'invalid_grant', 'the assertion is not a JWT'); }
    const peer = peers.get(iss);
    if (!peer) return oauthError(400, 'invalid_grant', 'the assertion issuer is not trusted by this server');
    let payload;
    try {
      ({ payload } = await jose.jwtVerify(assertion, peer, { algorithms: ['ES256'], typ: ID_JAG_TYP, issuer: iss, audience: origin, clockTolerance: 5 }));
    } catch (err) {
      return oauthError(400, 'invalid_grant', `ID-JAG verification failed: ${err.message}`);
    }
    if (!payload.jti || !payload.sub) return oauthError(400, 'invalid_grant', 'the assertion needs jti and sub');
    if (payload.client_id !== c.id) return oauthError(400, 'invalid_grant', 'client_id in the ID-JAG does not identify the redeeming client');
    if (consumed.has(`${iss} ${payload.jti}`)) return oauthError(400, 'invalid_grant', 'ID-JAG already redeemed (replay rejected)');
    const asked = words(req.form.get('scope'));
    const have = words(payload.scope);
    const scope = (asked.length ? have.filter((s) => asked.includes(s)) : have);
    if (!scope.length) return oauthError(400, 'invalid_scope', 'no scope is left to grant');
    consumed.add(`${iss} ${payload.jti}`);
    return json(200, { access_token: await accessToken({ sub: payload.sub, client_id: c.id, scope: scope.join(' '), aud: req.form.get('resource') || payload.resource || origin }), token_type: 'Bearer', expires_in: 3600, scope: scope.join(' ') });
  }

  async function token(req) {
    const c = authenticate(req);
    if (!c) return oauthError(401, 'invalid_client', 'client authentication failed');
    switch (req.form.get('grant_type')) {
      case 'authorization_code': return fromCode(req, c);
      case TOKEN_EXCHANGE: return exchange(req, c);
      case JWT_BEARER: return redeem(req, c);
      default: return oauthError(400, 'unsupported_grant_type', 'unsupported grant_type');
    }
  }

  function revoke(req) {
    if (!authenticate(req)) return oauthError(401, 'invalid_client', 'client authentication failed');
    const rt = refresh.get(req.form.get('token') ?? '');
    if (rt) rt.active = false;
    return new Response(null, { status: 200 }); // RFC 7009: 200 whether or not the token existed
  }

  async function handle(url, init) {
    const req = parseRequest(url, init);
    const p = req.path;
    const get = req.method === 'GET';
    if (get && p === '/.well-known/openid-configuration') return json(200, metadata);
    if (get && p === '/pf/JWKS') return json(200, { keys: [key.jwk] });
    if (get && p === '/as/authorization.oauth2') return authorize(req);
    if (req.method === 'POST' && p.startsWith('/pf-ws/authn/flows/')) return credentials(req);
    if (req.method === 'POST' && p === '/as/token.oauth2') return token(req);
    if (req.method === 'POST' && p === '/as/revoke_token.oauth2') return revoke(req);
    return json(404, { error: 'not_found' });
  }

  // The admin API slice pfAdmin.js calls. Same shape as pfAdmin's `send`: (url, { method, headers, body }) -> { status, body }.
  async function adminSend(url, { method, headers = {}, body }) {
    const want = `Basic ${Buffer.from(`${admin.user}:${admin.password}`).toString('base64')}`;
    if (headers.Authorization !== want) return { status: 401, body: { message: 'bad credentials' } };
    const p = new URL(url).pathname.replace(/^\/pf-admin-api\/v1/, '');
    if (p === `/passwordCredentialValidators/${validatorId}`) {
      if (method === 'GET') return { status: 200, body: structuredClone(validator) };
      if (method === 'PUT') {
        const next = JSON.parse(body || '{}')?.configuration?.tables?.find((t) => t.name === 'Users');
        if (!next?.rows?.length) return { status: 422, body: { validationErrors: [{ message: 'at least one user is required' }] } };
        validator.configuration.tables.find((t) => t.name === 'Users').rows = next.rows;
        return { status: 200, body: structuredClone(validator) };
      }
    }
    const client = /^\/oauth\/clients\/([^/]+)$/.exec(p);
    if (method === 'GET' && client) {
      const id = decodeURIComponent(client[1]);
      return Object.hasOwn(clients, id) ? { status: 200, body: { clientId: id, allowAuthenticationApiInit: true } } : { status: 404, body: { message: 'no such client' } };
    }
    return { status: 404, body: { message: 'not found' } };
  }

  return {
    origin, publicKey: key.publicKey, handle, adminSend,
    trust: (issuer, publicKey) => peers.set(issuer, publicKey),
    /** Forget sign-in state, refresh tokens and used ID-JAGs (the demo's reset). Users are removed through the admin API, as for a real server. */
    reset() { flows.clear(); codes.clear(); refresh.clear(); consumed.clear(); },
  };
}
