// The mock world of the "gateway redeem" playground mode (Ping release claim 2026-11-02, UNVERIFIED on our tenant).
//   exchange issuer  the company IdP. It signs the caller's token and answers RFC 8693 token exchange with an ID-JAG (leg 1).
//   partner issuer   a second exchange issuer the target app does not trust (the "untrusted issuer" refusal).
//   target issuer    the target app's OWN issuer. It redeems an ID-JAG with the JWT bearer grant (RFC 7523, leg 2).
//   target API       the target app's resource server. It accepts the redeemed access token and nothing else.
// All of it is in this process, reached through fetch(url) like the other mocks (netguard.js hands it the calls). Nothing here
// opens a socket. Every token carries "mock": true. Client secrets are random for each run of the process; the registered
// client keys exist only in this object. The test hooks at the bottom are for tests and never reach an HTTP route.

import { AsyncLocalStorage } from 'node:async_hooks';
import * as jose from 'jose';
import { ORIGINS } from './env.js';
import { ID_JAG_TYP } from './pf.js';
import { createEcKey, json, now, oauthError, parseRequest, rand, sameSecret, sign, words } from './util.js';

export const TOKEN_TYPES = {
  accessToken: 'urn:ietf:params:oauth:token-type:access_token',
  jwt: 'urn:ietf:params:oauth:token-type:jwt',
  idJag: 'urn:ietf:params:oauth:token-type:id-jag',
};
export const AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'private_key_jwt'];
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ID_JAG_TTL = 300;
export { ID_JAG_TTL };
const MAX_EVENTS = 50;

export const GATEWAY_RESOURCE = `${ORIGINS.gwGateway}/mcp`; // the audience of the caller's token
export const API_AUDIENCE = `${ORIGINS.gwApi}/ledger`; // the audience of the access token the target issuer mints
export const CALLER_CLIENT_ID = 'agent-app';
export const CALLER_USER = 'alice@mock.example';
export const SCOPES = 'ledger:read ledger:write';

/** Per-call context: a fault to inject into the next ID-JAG (tests and scenarios), set with runWith(). */
const callContext = new AsyncLocalStorage();
export const runWith = (ctx, fn) => callContext.run(ctx, fn);
const fault = () => callContext.getStore()?.fault ?? null;

const clip = (v, n = 200) => String(v ?? '').slice(0, n);
const pem = (k) => k.privateKey.export({ type: 'pkcs8', format: 'pem' });

/** A refusal that names the check that failed: { check, error, status, description }. */
const refuse = (check, error, description, status = 400) => Object.assign(new Error(description), { refusal: { check, error, status, description } });

/** Client authentication at a token endpoint: Basic, a secret in the body, or a signed client assertion. */
function createClientAuth({ origin, tokenUrl, clients }) {
  const seen = new Map(); // jti -> exp (client assertions are single use)
  return async function authenticate(req) {
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1];
    const assertion = req.form.get('client_assertion');
    let method = 'none';
    let id = req.form.get('client_id') ?? undefined;
    let secret;
    if (basic) {
      const d = Buffer.from(basic, 'base64').toString('utf8');
      const i = d.indexOf(':');
      if (i < 1) throw refuse('client authentication', 'invalid_client', 'malformed Basic credentials', 401);
      method = 'client_secret_basic'; id = d.slice(0, i); secret = d.slice(i + 1);
    } else if (assertion || req.form.get('client_assertion_type')) {
      method = 'private_key_jwt';
      try { id = jose.decodeJwt(assertion).iss; } catch { id = undefined; }
    } else if (req.form.get('client_secret')) {
      method = 'client_secret_post'; secret = req.form.get('client_secret');
    }
    const reg = id && Object.hasOwn(clients, id) ? clients[id] : null;
    if (!reg) throw refuse('client authentication', 'invalid_client', 'client authentication failed', 401);
    if (!reg.methods.includes(method)) {
      throw refuse('client authentication method', 'invalid_client', `client ${clip(id, 80)} may authenticate with ${reg.methods.join(' or ')} here, not ${method}`, 401);
    }
    if (method === 'private_key_jwt') {
      if (req.form.get('client_assertion_type') !== CLIENT_ASSERTION_TYPE) throw refuse('client authentication', 'invalid_client', `client_assertion_type must be ${CLIENT_ASSERTION_TYPE}`, 401);
      let payload;
      try {
        const kid = jose.decodeProtectedHeader(assertion).kid;
        if (kid !== reg.jwk.kid) throw new Error(`key id ${clip(kid, 60)} is not registered for this client`);
        ({ payload } = await jose.jwtVerify(assertion, jose.createLocalJWKSet({ keys: [reg.jwk] }), {
          algorithms: ['ES256'], issuer: id, subject: id, audience: [tokenUrl, origin], clockTolerance: 5, requiredClaims: ['jti', 'exp'],
        }));
      } catch (err) {
        throw refuse('client assertion', 'invalid_client', `client assertion did not verify: ${clip(err.message, 160)}`, 401);
      }
      if (payload.exp - now() > 300) throw refuse('client assertion', 'invalid_client', 'client assertion lives longer than 5 minutes', 401);
      for (const [k, exp] of seen) if (exp < now()) seen.delete(k);
      if (seen.has(`${id} ${payload.jti}`)) throw refuse('client assertion', 'invalid_client', 'client assertion jti already used', 401);
      seen.set(`${id} ${payload.jti}`, payload.exp + 5);
    } else if (!sameSecret(secret, reg.secret)) {
      throw refuse('client authentication', 'invalid_client', 'client authentication failed', 401);
    }
    return { id, reg, method };
  };
}

const eventLog = () => {
  let events = [];
  return {
    add(e) { events = [{ at: new Date().toISOString(), ...e }, ...events].slice(0, MAX_EVENTS); },
    list: () => events.map((e) => ({ ...e })),
    clear() { events = []; },
  };
};

/**
 * An issuer that answers RFC 8693 token exchange. The subject token is a caller token signed by `callerKey`.
 * requested_token_type id-jag gives an ID-JAG (typ oauth-id-jag+jwt, aud = the resource asked for, sub = the user, act = the
 * calling client); access_token gives a plain access token, which is NOT an ID-JAG and so cannot be redeemed.
 */
function createExchangeIssuer({ origin, label, clients, callerKey, callerIssuer }) {
  const key = createEcKey(`mock-${label}-1`);
  const verifyKey = callerKey === 'self' ? key.publicKey : callerKey;
  const authenticate = createClientAuth({ origin, tokenUrl: `${origin}/token`, clients });
  const events = eventLog();
  const metadata = {
    issuer: origin, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`, grant_types_supported: [TOKEN_EXCHANGE],
    token_endpoint_auth_methods_supported: AUTH_METHODS, token_endpoint_auth_signing_alg_values_supported: ['ES256'],
  };

  async function exchange(req, c, ctx) {
    const f = req.form;
    if (f.get('grant_type') !== TOKEN_EXCHANGE) throw refuse('grant type', 'unsupported_grant_type', `only ${TOKEN_EXCHANGE} is supported`);
    const requested = f.get('requested_token_type');
    if (![TOKEN_TYPES.idJag, TOKEN_TYPES.accessToken].includes(requested)) throw refuse('requested_token_type', 'invalid_request', `requested_token_type ${clip(requested, 100)} is not supported (id-jag or access_token)`);
    const subjectType = f.get('subject_token_type');
    if (![TOKEN_TYPES.accessToken, TOKEN_TYPES.jwt].includes(subjectType)) throw refuse('subject_token_type', 'invalid_request', `subject_token_type ${clip(subjectType, 100)} is not supported (access_token or jwt)`);
    let caller;
    try {
      ({ payload: caller } = await jose.jwtVerify(f.get('subject_token') ?? '', verifyKey, { algorithms: ['ES256'], issuer: callerIssuer, typ: 'at+jwt', clockTolerance: 5 }));
    } catch (err) {
      throw refuse('subject token', 'invalid_grant', `the subject token did not verify: ${clip(err.message, 160)}`);
    }
    ctx.sub = caller.sub;
    const resource = f.get('resource');
    try { if (!resource || !/^https?:$/.test(new URL(resource).protocol)) throw new Error('no'); } catch { throw refuse('resource', 'invalid_target', 'resource must be an absolute http(s) URL'); }
    const allowed = words(c.reg.scopes);
    const have = new Set(words(caller.scope));
    const asked = words(f.get('scope'));
    const denied = asked.filter((s) => !allowed.includes(s) || !have.has(s));
    if (denied.length) throw refuse('scope', 'invalid_scope', `scope ${denied.join(' ')} is not granted to this client for this caller`);
    const granted = (asked.length ? asked : allowed).filter((s) => allowed.includes(s) && have.has(s));
    if (!granted.length) throw refuse('scope', 'invalid_scope', 'no scope can be granted');
    ctx.scope = granted.join(' ');
    const t = now();
    const base = { iss: origin, sub: caller.sub, aud: resource, scope: granted.join(' '), act: { sub: caller.client_id }, jti: rand(), iat: t, exp: t + (requested === TOKEN_TYPES.idJag ? ID_JAG_TTL : 3600) };
    if (requested === TOKEN_TYPES.accessToken) {
      return { access_token: await sign(key, { typ: 'at+jwt' }, { ...base, client_id: c.id }), issued_token_type: TOKEN_TYPES.accessToken, token_type: 'Bearer', expires_in: 3600, scope: base.scope };
    }
    const f1 = fault();
    const claims = { ...base, client_id: c.reg.idJagClientId || c.id };
    if (f1 === 'expired') Object.assign(claims, { iat: t - 900, exp: t - 600 });
    let token = await sign(key, { typ: ID_JAG_TYP }, claims);
    if (f1 === 'bad-signature') { const [h, p, s] = token.split('.'); token = `${h}.${p}.${s.slice(0, -4)}${s.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`; }
    return { access_token: token, issued_token_type: TOKEN_TYPES.idJag, token_type: 'N_A', expires_in: ID_JAG_TTL, scope: base.scope };
  }

  async function token(req) {
    const ctx = {};
    try {
      const c = await authenticate(req);
      ctx.client_id = c.id; ctx.method = c.method;
      const body = await exchange(req, c, ctx);
      events.add({ decision: 'accepted', ...ctx });
      return json(200, body);
    } catch (err) {
      if (!err.refusal) throw err;
      const { check, error, status, description } = err.refusal;
      events.add({ decision: 'refused', check, error, reason: clip(description), ...ctx });
      return oauthError(status, error, description);
    }
  }

  async function handle(url, init) {
    const req = parseRequest(url, init);
    if (req.method === 'GET' && req.path === '/.well-known/openid-configuration') return json(200, metadata);
    if (req.method === 'GET' && req.path === '/jwks') return json(200, { keys: [key.jwk] });
    if (req.method === 'GET' && req.path === '/events') return json(200, { issuer: origin, events: events.list() });
    if (req.path === '/token') return req.method === 'POST' ? token(req) : oauthError(405, 'invalid_request', 'use POST');
    return json(404, { error: 'not_found' });
  }
  /** The caller's token: an access token for the gateway, issued to the agent app for a signed-in user (company IdP only). */
  const issueCallerToken = ({ sub = CALLER_USER, clientId = CALLER_CLIENT_ID, scope = `gateway:use ${SCOPES}`, ttl = 600 } = {}) => {
    const t = now();
    return sign(key, { typ: 'at+jwt' }, { iss: origin, sub, aud: GATEWAY_RESOURCE, client_id: clientId, scope, iat: t, exp: t + ttl, jti: rand() });
  };
  return { origin, key, publicKey: key.publicKey, handle, events, issueCallerToken };
}
export { createExchangeIssuer };

/** The target app's own issuer: redeems an ID-JAG from a trusted issuer with the JWT bearer grant. The ID-JAG is single use. */
function createTargetIssuer({ origin, clients, trusted }) {
  const key = createEcKey('mock-target-idp-1');
  const authenticate = createClientAuth({ origin, tokenUrl: `${origin}/token`, clients });
  const consumed = new Map(); // `${iss} ${jti}` -> exp
  const events = eventLog();
  const metadata = {
    issuer: origin, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`, grant_types_supported: [JWT_BEARER],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt'], authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],
  };

  async function redeem(req, c, ctx) {
    if (req.form.get('grant_type') !== JWT_BEARER) throw refuse('grant type', 'unsupported_grant_type', `only ${JWT_BEARER} is supported`);
    const assertion = req.form.get('assertion');
    if (!assertion) throw refuse('assertion', 'invalid_request', 'assertion is required');
    let iss;
    try { iss = jose.decodeJwt(assertion).iss; } catch { throw refuse('assertion', 'invalid_grant', 'the assertion is not a JWT'); }
    ctx.iss = clip(iss, 120);
    const peer = trusted.get(iss);
    if (!peer) throw refuse('issuer', 'invalid_grant', `the assertion issuer ${clip(iss, 120)} is not trusted by this authorization server`);
    let claims;
    try {
      ({ payload: claims } = await jose.jwtVerify(assertion, peer, {
        algorithms: ['ES256'], typ: ID_JAG_TYP, issuer: iss, audience: origin, clockTolerance: 5, requiredClaims: ['iss', 'sub', 'aud', 'client_id', 'jti', 'exp', 'iat'],
      }));
    } catch (err) {
      const aud = (() => { try { return jose.decodeJwt(assertion).aud; } catch { return undefined; } })();
      if (err.code === 'ERR_JWT_EXPIRED') throw refuse('expiry', 'invalid_grant', 'the ID-JAG has expired');
      if (err.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') throw refuse('signature', 'invalid_grant', 'the ID-JAG signature does not verify against the trusted issuer keys');
      if (err.claim === 'aud') throw refuse('audience', 'invalid_grant', `the ID-JAG aud ${clip(JSON.stringify(aud), 140)} is not this authorization server (${origin})`);
      if (err.claim === 'typ' || err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') throw refuse(err.claim || 'claims', 'invalid_grant', `the ID-JAG failed the ${err.claim || 'claims'} check`);
      throw refuse('signature', 'invalid_grant', `the ID-JAG did not verify: ${clip(err.message, 160)}`);
    }
    ctx.sub = claims.sub;
    if (claims.client_id !== c.id) throw refuse('client binding', 'invalid_grant', 'client_id in the ID-JAG does not identify the authenticating client');
    const allowed = words(c.reg.scopes);
    const asked = words(req.form.get('scope'));
    const have = words(claims.scope);
    const extra = asked.filter((s) => !have.includes(s));
    if (extra.length) throw refuse('scope', 'invalid_scope', `the ID-JAG does not grant ${extra.join(' ')}`);
    const granted = (asked.length ? asked : have).filter((s) => allowed.includes(s));
    if (!granted.length) throw refuse('scope', 'invalid_scope', 'no scope is left to grant');
    for (const [k, exp] of consumed) if (exp < now()) consumed.delete(k);
    const at = `${iss} ${claims.jti}`;
    if (consumed.has(at)) throw refuse('replay', 'invalid_grant', 'ID-JAG already redeemed (jti is single use)');
    consumed.set(at, claims.exp + 5);
    ctx.scope = granted.join(' ');
    const t = now();
    const access_token = await sign(key, { typ: 'at+jwt' }, { iss: origin, sub: claims.sub, aud: API_AUDIENCE, client_id: c.id, scope: granted.join(' '), act: claims.act, iat: t, exp: t + 3600, jti: rand() });
    return { access_token, token_type: 'Bearer', expires_in: 3600, scope: granted.join(' ') };
  }

  async function token(req) {
    const ctx = {};
    try {
      const c = await authenticate(req);
      ctx.client_id = c.id; ctx.method = c.method;
      const body = await redeem(req, c, ctx);
      events.add({ decision: 'accepted', ...ctx });
      return json(200, body);
    } catch (err) {
      if (!err.refusal) throw err;
      const { check, error, status, description } = err.refusal;
      events.add({ decision: 'refused', check, error, reason: clip(description), ...ctx });
      return oauthError(status, error, description);
    }
  }

  async function handle(url, init) {
    const req = parseRequest(url, init);
    if (req.method === 'GET' && req.path === '/.well-known/openid-configuration') return json(200, metadata);
    if (req.method === 'GET' && req.path === '/jwks') return json(200, { keys: [key.jwk] });
    if (req.method === 'GET' && req.path === '/events') return json(200, { issuer: origin, events: events.list() });
    // A token endpoint that answers with a redirect: the gateway must refuse to follow it (redirect: 'error').
    if (req.path === '/token-redirect') return new Response(null, { status: 302, headers: { location: `${ORIGINS.pf}/as/token.oauth2` } });
    if (req.path === '/token') return req.method === 'POST' ? token(req) : oauthError(405, 'invalid_request', 'use POST');
    return json(404, { error: 'not_found' });
  }
  return { origin, key, publicKey: key.publicKey, handle, events, reset() { consumed.clear(); events.clear(); } };
}

/** The target app's API. It names the check that failed, and it knows an ID-JAG when it sees one. */
function createTargetApi({ origin, issuer, issuerKey }) {
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
  const challenge = (params = '') => ({ 'www-authenticate': `Bearer ${params}resource_metadata="${metadataUrl}"` });

  async function checkBearer(authorization) {
    const verified = [];
    const pass = (check, detail) => verified.push({ check, ok: true, detail });
    const fail = (check, detail, error = 'invalid_token') => { verified.push({ check, ok: false, detail }); return { verified, error, detail }; };
    const raw = /^Bearer\s+(\S+)$/i.exec(authorization || '')?.[1];
    if (!raw) return fail('bearer', 'No Authorization: Bearer header.', 'invalid_request');
    pass('bearer', 'Authorization: Bearer present.');
    let header;
    try { header = jose.decodeProtectedHeader(raw); } catch { return fail('token type', 'Not a JWT.'); }
    const typ = String(header.typ || '').toLowerCase().replace(/^application\//, '');
    if (typ === 'oauth-id-jag+jwt') return fail('token type', 'This is an ID-JAG (typ oauth-id-jag+jwt): a grant for an authorization server to redeem, never an access token for an API.');
    if (typ !== 'at+jwt') return fail('token type', `typ is "${header.typ ?? '(none)'}", not at+jwt.`);
    pass('token type', 'JWT access token (typ at+jwt), not an ID-JAG.');
    let token;
    try {
      ({ payload: token } = await jose.jwtVerify(raw, issuerKey, { algorithms: ['ES256'], requiredClaims: ['exp'] }));
    } catch (err) {
      if (err.code === 'ERR_JWT_EXPIRED') return fail('expiry', 'The token has expired.');
      return fail('signature', "Does not verify against the target app issuer's keys. Only tokens the target app's own issuer minted are accepted.");
    }
    pass('signature', "Verified against the target app issuer's keys.");
    pass('expiry', `${token.exp - now()} s left.`);
    if (token.iss !== issuer) return fail('issuer', `iss "${clip(token.iss, 100)}" is not the target app issuer.`);
    pass('issuer', `iss ${issuer} is the target app issuer.`);
    if (![token.aud].flat().includes(API_AUDIENCE)) return fail('audience', `aud ${clip(JSON.stringify(token.aud), 120)} is not this API (${API_AUDIENCE}).`);
    pass('audience', `aud ${API_AUDIENCE} is this API.`);
    return { verified, token };
  }

  const entriesFor = (sub) => {
    const n = [...String(sub)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 7);
    return [1, 2, 3].map((i) => ({ id: `led-${(n * i) % 900 + 100}`, memo: `entry ${i} for ${sub}`, cents: ((n * 7 + i * 1311) % 90000) + 1000 }));
  };

  async function entries(req) {
    const page = `${origin}/ledger/entries`;
    const auth = await checkBearer(req.headers.get('authorization'));
    if (auth.error) {
      return json(401, { resource: page, error: auth.error, error_description: auth.detail, verified: auth.verified }, challenge(auth.error === 'invalid_token' ? 'error="invalid_token", ' : ''));
    }
    const { token, verified } = auth;
    const scope = typeof token.scope === 'string' ? token.scope : '';
    if (!scope.split(' ').includes('ledger:read')) {
      verified.push({ check: 'scope', ok: false, detail: `Needs ledger:read; the token has "${scope}".` });
      return json(403, { resource: page, error: 'insufficient_scope', error_description: 'ledger:read scope required', verified }, challenge('error="insufficient_scope", scope="ledger:read", '));
    }
    verified.push({ check: 'scope', ok: true, detail: 'Has ledger:read.' });
    return json(200, { resource: page, verified, principal: { sub: token.sub, client_id: token.client_id ?? null, scope, act: token.act ?? null }, data: { entries: entriesFor(token.sub) } });
  }

  async function handle(url, init) {
    const req = parseRequest(url, init);
    if (req.method === 'GET' && req.path.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: API_AUDIENCE, authorization_servers: [issuer], scopes_supported: words(SCOPES), bearer_methods_supported: ['header'] });
    if (req.method === 'GET' && req.path === '/ledger/entries') return entries(req);
    return json(404, { error: 'not_found' });
  }
  return { origin, handle };
}

/** Builds the whole world. The test hooks (underscore names) are for tests and never reach an HTTP route. */
export function createGatewayWorld() {
  const secrets = { obo: rand(24), redeem: rand(24), peer: rand(24) };
  const oboKey = createEcKey('obo-key-1');
  const redeemKey = createEcKey('gw-redeem-1');
  const exchangeClients = {
    'gateway-obo': { secret: secrets.obo, methods: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'], jwk: oboKey.jwk, scopes: SCOPES, idJagClientId: 'gateway-redeem' },
  };
  const targetClients = {
    'gateway-redeem': { secret: secrets.redeem, methods: ['client_secret_post', 'private_key_jwt'], jwk: redeemKey.jwk, scopes: SCOPES },
    // Another registered app of the target issuer. A test authenticates as it to prove an ID-JAG is bound to the client it names.
    'peer-app': { secret: secrets.peer, methods: ['client_secret_post'], jwk: redeemKey.jwk, scopes: SCOPES },
  };
  // The company IdP signs the caller's token with its own key and trusts it; the partner issuer trusts the same key, so it can
  // exchange the same token, but the target app does not trust the partner.
  const company = createExchangeIssuer({ origin: ORIGINS.gwIdp, label: 'exchange-idp', clients: exchangeClients, callerKey: 'self', callerIssuer: ORIGINS.gwIdp });
  const partner = createExchangeIssuer({ origin: ORIGINS.gwPartner, label: 'partner-idp', clients: exchangeClients, callerKey: company.publicKey, callerIssuer: ORIGINS.gwIdp });
  const target = createTargetIssuer({ origin: ORIGINS.gwTarget, clients: targetClients, trusted: new Map([[ORIGINS.gwIdp, company.publicKey]]) });
  const api = createTargetApi({ origin: ORIGINS.gwApi, issuer: ORIGINS.gwTarget, issuerKey: target.publicKey });

  return {
    services: [company, partner, target, api],
    company, partner, target, api,
    allowedOrigins: [ORIGINS.gwIdp, ORIGINS.gwPartner, ORIGINS.gwTarget],
    /** The caller's token, as the company IdP issues it to the agent after sign-in. */
    callerToken: (over = {}) => company.issueCallerToken(over),
    /** What the gateway's spec starts with. Secrets and keys live here and in the stored spec only. */
    defaults() {
      return {
        OBO: {
          TokenURL: `${ORIGINS.gwIdp}/token`, ClientID: 'gateway-obo', ClientSecret: secrets.obo, AuthMethod: 'client_secret_basic',
          Resource: ORIGINS.gwTarget, Scope: 'ledger:read', PrivateKeyPEM: pem(oboKey), KeyID: oboKey.kid,
          SubjectTokenType: TOKEN_TYPES.accessToken, RequestedTokenType: TOKEN_TYPES.idJag,
          Redeem: {
            TokenURL: `${ORIGINS.gwTarget}/token`, ClientID: 'gateway-redeem', ClientSecret: secrets.redeem, AuthMethod: 'private_key_jwt',
            Scope: 'ledger:read', PrivateKeyPEM: pem(redeemKey), KeyID: redeemKey.kid,
          },
        },
      };
    },
    reset() { target.reset(); company.events.clear(); partner.events.clear(); },
    /** Test hook: another client registered at the target issuer (its secret is random for each run and never shown). */
    _peerClient: () => ({ id: 'peer-app', secret: secrets.peer }),
    /** Test hook: another valid EC key (a wrong key must be refused). */
    _otherKey: () => { const k = createEcKey('other-key-1'); return { pem: pem(k), kid: k.kid }; },
  };
}
