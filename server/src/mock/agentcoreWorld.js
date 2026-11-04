// The mock world of the "aws-agentcore" playground leg: the company IdP issues an ID-JAG from the caller's token
// (RFC 8693, the same exchange issuer the gateway-redeem leg uses), a dedicated target issuer redeems it with the
// JWT bearer grant (RFC 7523) and mints an access token, and a (mock) Bedrock AgentCore runtime accepts that token
// and runs a tool under a workload identity. All of it is in this process, reached through fetch(url) like the other
// mocks (netguard.js hands it the calls). Nothing here opens a socket. Every token carries "mock": true. Client
// secrets are random for each run of the process; the registered client keys exist only in this object. The test
// hooks at the bottom are for tests and never reach an HTTP route.
//
// This is a lab simulation of the AWS side: no AWS service is called, nothing here is a product test of AgentCore.
// The runtime's checks (bearer token present, typ at+jwt, signature, issuer, audience, scope) mirror what an
// AgentCore-hosted agent's own authorization filter checks in the lab's story.

import { AsyncLocalStorage } from 'node:async_hooks';
import * as jose from 'jose';
import { ORIGINS } from './env.js';
import { ID_JAG_TYP } from './pf.js';
import { createEcKey, json, now, oauthError, parseRequest, rand, sign, words } from './util.js';
import { createExchangeIssuer, ID_JAG_TTL } from './gatewayWorld.js';

export const TOKEN_TYPES = {
  accessToken: 'urn:ietf:params:oauth:token-type:access_token',
  idJag: 'urn:ietf:params:oauth:token-type:id-jag',
};
export const AUTH_METHODS = ['client_secret_basic', 'client_secret_post'];
export const API_AUDIENCE = `${ORIGINS.acRuntime}/tools`; // the audience of the access token the target issuer mints
export const CALLER_CLIENT_ID = 'agent-app';
export const CALLER_USER = 'alice@mock.example';
export const SCOPES = 'tools:invoke tools:list';
export const RUNTIME_TOOL = 'get_account_summary';

/** Per-call context: a fault to inject into the next ID-JAG (tests and scenarios), set with runWith(). */
const callContext = new AsyncLocalStorage();
export const runWith = (ctx, fn) => callContext.run(ctx, fn);
const fault = () => callContext.getStore()?.fault ?? null;

const clip = (v, n = 200) => String(v ?? '').slice(0, n);

/**
 * The AgentCore leg's target issuer: redeems an ID-JAG from the (shared) exchange issuer and mints the access token
 * the runtime accepts. A trimmed copy of gatewayWorld.js's createTargetIssuer: same checks, its own clients and key,
 * audience = the runtime, no private_key_jwt (the redeeming client here authenticates with client_secret_post/basic).
 */
function createAgentCoreIssuer({ origin, clients, trusted }) {
  const key = createEcKey('mock-ac-idp-1');
  const consumed = new Map(); // `${iss} ${jti}` -> exp — each ID-JAG jti is single use
  const events = (() => {
    let events = [];
    return {
      add(e) { events = [{ at: new Date().toISOString(), ...e }, ...events].slice(0, 50); },
      list: () => events.map((e) => ({ ...e })),
      clear() { events = []; },
    };
  })();
  const metadata = {
    issuer: origin, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`,
    grant_types_supported: ['urn:ietf:params:oauth:grant-type:jwt-bearer'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],
  };

  async function authenticate(req) {
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1];
    let id = req.form.get('client_id') ?? undefined;
    let secret;
    let method = 'none';
    if (basic) {
      const d = Buffer.from(basic, 'base64').toString('utf8');
      const i = d.indexOf(':');
      if (i < 1) throw oauthRefuse('client authentication', 'invalid_client', 'malformed Basic credentials', 401);
      method = 'client_secret_basic'; id = d.slice(0, i); secret = d.slice(i + 1);
    } else if (req.form.get('client_secret')) {
      method = 'client_secret_post'; secret = req.form.get('client_secret');
    }
    const reg = id && Object.hasOwn(clients, id) ? clients[id] : null;
    if (!reg) throw oauthRefuse('client authentication', 'invalid_client', 'client authentication failed', 401);
    if (!reg.methods.includes(method)) {
      throw oauthRefuse('client authentication method', 'invalid_client', `client ${clip(id, 80)} may authenticate with ${reg.methods.join(' or ')} here, not ${method}`, 401);
    }
    if (!sameSecret(secret, reg.secret)) throw oauthRefuse('client authentication', 'invalid_client', 'client authentication failed', 401);
    return { id, reg, method };
  }

  async function redeem(req, c, ctx) {
    if (req.form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      throw oauthRefuse('grant type', 'unsupported_grant_type', 'only urn:ietf:params:oauth:grant-type:jwt-bearer is supported');
    }
    const assertion = req.form.get('assertion');
    if (!assertion) throw oauthRefuse('assertion', 'invalid_request', 'assertion is required');
    let iss;
    try { iss = jose.decodeJwt(assertion).iss; } catch { throw oauthRefuse('assertion', 'invalid_grant', 'the assertion is not a JWT'); }
    ctx.iss = clip(iss, 120);
    const peer = trusted.get(iss);
    if (!peer) throw oauthRefuse('issuer', 'invalid_grant', `the assertion issuer ${clip(iss, 120)} is not trusted by this authorization server`);
    let claims;
    try {
      ({ payload: claims } = await jose.jwtVerify(assertion, peer, {
        algorithms: ['ES256'], typ: ID_JAG_TYP, issuer: iss, audience: origin, clockTolerance: 5,
        requiredClaims: ['iss', 'sub', 'aud', 'client_id', 'jti', 'exp', 'iat'],
      }));
    } catch (err) {
      const aud = (() => { try { return jose.decodeJwt(assertion).aud; } catch { return undefined; } })();
      if (err.code === 'ERR_JWT_EXPIRED') throw oauthRefuse('expiry', 'invalid_grant', 'the ID-JAG has expired');
      if (err.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') throw oauthRefuse('signature', 'invalid_grant', 'the ID-JAG signature does not verify against the trusted issuer keys');
      if (err.claim === 'aud') throw oauthRefuse('audience', 'invalid_grant', `the ID-JAG aud ${clip(JSON.stringify(aud), 140)} is not this authorization server (${origin})`);
      if (err.claim === 'typ' || err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') throw oauthRefuse(err.claim || 'claims', 'invalid_grant', `the ID-JAG failed the ${err.claim || 'claims'} check`);
      throw oauthRefuse('signature', 'invalid_grant', `the ID-JAG did not verify: ${clip(err.message, 160)}`);
    }
    ctx.sub = claims.sub;
    if (claims.client_id !== c.id) throw oauthRefuse('client binding', 'invalid_grant', 'client_id in the ID-JAG does not identify the authenticating client');
    const allowed = words(c.reg.scopes);
    const asked = words(req.form.get('scope'));
    const have = words(claims.scope);
    const extra = asked.filter((s) => !have.includes(s));
    if (extra.length) throw oauthRefuse('scope', 'invalid_scope', `the ID-JAG does not grant ${extra.join(' ')}`);
    const granted = (asked.length ? asked : have).filter((s) => allowed.includes(s));
    if (!granted.length) throw oauthRefuse('scope', 'invalid_scope', 'no scope is left to grant');
    for (const [k, exp] of consumed) if (exp < now()) consumed.delete(k);
    const at = `${iss} ${claims.jti}`;
    if (consumed.has(at)) throw oauthRefuse('replay', 'invalid_grant', 'ID-JAG already redeemed (jti is single use)');
    consumed.set(at, claims.exp + 5);
    ctx.scope = granted.join(' ');
    const t = now();
    const access_token = await sign(key, { typ: 'at+jwt' }, {
      iss: origin, sub: claims.sub, aud: API_AUDIENCE, client_id: c.id, scope: granted.join(' '),
      act: claims.act, iat: t, exp: t + 3600, jti: rand(),
      wid: `ac-wid-${rand(8)}`, // the runtime's workload identity, resolved from the redeeming client (lab-invented)
    });
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
    if (req.path === '/token') return req.method === 'POST' ? token(req) : oauthError(405, 'invalid_request', 'use POST');
    return json(404, { error: 'not_found' });
  }
  return { origin, key, publicKey: key.publicKey, handle, events, reset() { consumed.clear(); events.clear(); } };
}

const oauthRefuse = (check, error, description, status = 400) => Object.assign(new Error(description), { refusal: { check, error, status, description } });
const sameSecret = (a, b) => Boolean(b) && a === b;

/**
 * The mock Bedrock AgentCore runtime. It accepts the target issuer's access tokens and runs one tool. Its checks
 * mirror what an AgentCore-hosted agent's own authorization filter checks in this lab's story: bearer present,
 * typ at+jwt (never an ID-JAG), signature against the issuer's key, issuer, audience, scope. The response names the
 * workload identity the token resolved to, and every answer says it is simulated.
 */
function createAgentCoreRuntime({ origin, issuer, issuerKey }) {
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
    if (typ === 'oauth-id-jag+jwt') return fail('token type', 'This is an ID-JAG (typ oauth-id-jag+jwt): a grant for an authorization server to redeem, never an access token for a runtime.');
    if (typ !== 'at+jwt') return fail('token type', `typ is "${header.typ ?? '(none)'}", not at+jwt.`);
    pass('token type', 'JWT access token (typ at+jwt), not an ID-JAG.');
    let token;
    try {
      ({ payload: token } = await jose.jwtVerify(raw, issuerKey, { algorithms: ['ES256'], requiredClaims: ['exp'] }));
    } catch (err) {
      if (err.code === 'ERR_JWT_EXPIRED') return fail('expiry', 'The token has expired.');
      return fail('signature', "Does not verify against the runtime issuer's keys. Only tokens the runtime's own issuer minted are accepted.");
    }
    pass('signature', "Verified against the runtime issuer's keys.");
    pass('expiry', `${token.exp - now()} s left.`);
    if (token.iss !== issuer) return fail('issuer', `iss "${clip(token.iss, 100)}" is not the runtime issuer.`);
    pass('issuer', `iss ${issuer} is the runtime issuer.`);
    if (![token.aud].flat().includes(API_AUDIENCE)) return fail('audience', `aud ${clip(JSON.stringify(token.aud), 120)} is not this runtime (${API_AUDIENCE}).`);
    pass('audience', `aud ${API_AUDIENCE} is this runtime.`);
    return { verified, token };
  }

  /** The tool result, derived from the caller (deterministic per sub), and the workload identity the token resolved to. */
  const summaryFor = (token) => {
    const n = [...String(token.sub)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 7);
    return {
      tool: RUNTIME_TOOL,
      result: {
        account: `acct-${(n % 9000) + 1000}`,
        holder: token.sub,
        tier: ['standard', 'preferred', 'private'][n % 3],
        openPositions: (n % 12) + 1,
      },
      workloadIdentity: token.wid ?? null,
    };
  };

  async function invoke(req) {
    const page = `${origin}/invoke`;
    const auth = await checkBearer(req.headers.get('authorization'));
    if (auth.error) return json(401, { resource: page, error: auth.error, error_description: auth.detail, verified: auth.verified });
    const { token, verified } = auth;
    const scope = typeof token.scope === 'string' ? token.scope : '';
    if (!scope.split(' ').includes('tools:invoke')) {
      verified.push({ check: 'scope', ok: false, detail: `Needs tools:invoke; the token has "${scope}".` });
      return json(403, { resource: page, error: 'insufficient_scope', error_description: 'tools:invoke scope required', verified });
    }
    verified.push({ check: 'scope', ok: true, detail: 'Has tools:invoke.' });
    return json(200, { resource: page, simulated: true, verified, principal: { sub: token.sub, client_id: token.client_id ?? null, scope, act: token.act ?? null }, ...summaryFor(token) });
  }

  async function handle(url, init) {
    const req = parseRequest(url, init);
    if (req.method === 'GET' && req.path === '/.well-known/oauth-protected-resource') {
      return json(200, { resource: API_AUDIENCE, authorization_servers: [issuer], scopes_supported: words(SCOPES), bearer_methods_supported: ['header'] });
    }
    if (req.method === 'POST' && req.path === '/invoke') return invoke(req);
    return json(404, { error: 'not_found' });
  }
  return { origin, handle };
}

/** Builds the whole world. The test hooks (underscore names) are for tests and never reach an HTTP route. */
export function createAgentCoreWorld() {
  const secrets = { exchange: rand(24), redeem: rand(24) };
  const exchangeKey = createEcKey('ac-exchange-key-1');
  const redeemKey = createEcKey('ac-redeem-key-1');
  const exchangeClients = {
    'agentcore-obo': { secret: secrets.exchange, methods: ['client_secret_basic', 'client_secret_post'], jwk: exchangeKey.jwk, scopes: SCOPES, idJagClientId: 'agentcore-redeem' },
  };
  const targetClients = {
    'agentcore-redeem': { secret: secrets.redeem, methods: ['client_secret_basic', 'client_secret_post'], jwk: redeemKey.jwk, scopes: SCOPES },
  };
  // The exchange issuer signs the caller's token with its own key and trusts it. Its ID-JAGs are addressed to the
  // AgentCore leg's target issuer, which is the only issuer trusting the exchange key here.
  const company = createExchangeIssuer({ origin: ORIGINS.acExchange, label: 'ac-exchange-idp', clients: exchangeClients, callerKey: 'self', callerIssuer: ORIGINS.acExchange });
  const target = createAgentCoreIssuer({ origin: ORIGINS.acTarget, clients: targetClients, trusted: new Map([[ORIGINS.acExchange, company.publicKey]]) });
  const runtime = createAgentCoreRuntime({ origin: ORIGINS.acRuntime, issuer: ORIGINS.acTarget, issuerKey: target.publicKey });

  return {
    services: [company, target, runtime],
    company, target, runtime,
    allowedOrigins: [ORIGINS.acExchange, ORIGINS.acTarget],
    /** The caller's token, as the exchange issuer issues it to the agent after sign-in. */
    callerToken: (over = {}) => company.issueCallerToken({ clientId: CALLER_CLIENT_ID, scope: `gateway:use ${SCOPES}`, ...over }),
    /** What the spec starts with. Secrets live here and in the stored spec only. */
    defaults() {
      return {
        Exchange: {
          TokenURL: `${ORIGINS.acExchange}/token`, ClientID: 'agentcore-obo', ClientSecret: secrets.exchange, AuthMethod: 'client_secret_basic',
          Resource: ORIGINS.acTarget, Scope: 'tools:invoke', SubjectTokenType: TOKEN_TYPES.accessToken, RequestedTokenType: TOKEN_TYPES.idJag,
        },
        Redeem: {
          TokenURL: `${ORIGINS.acTarget}/token`, ClientID: 'agentcore-redeem', ClientSecret: secrets.redeem, AuthMethod: 'client_secret_post', Scope: 'tools:invoke',
        },
      };
    },
    reset() { target.reset(); company.events.clear(); },
    /** Test hook: another valid EC key (a wrong key must be refused). */
    _otherKey: () => { const k = createEcKey('ac-other-key-1'); return { kid: k.kid }; },
  };
}

export { ID_JAG_TTL };
