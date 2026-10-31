// The token endpoint over real HTTP: every refusal path the ID-JAG profile
// requires, plus what a successful redemption must (and must not) return.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as jose from 'jose';
import { createHandler } from '../src/app.js';
import { loadClients } from '../src/config.js';
import { listen, mintIdJag, newRsaKey, publicJwk, startTestIdp } from './helpers.js';

const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const AS_ISSUER = 'https://as.example.test';
const RESOURCE = 'https://mcp.example.test/mcp';
const OTHER_RESOURCE = 'https://other.example.test/api';
const SECRET = 'agent-1-secret';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const CLIENTS = [
  { client_id: 'agent-1', client_secret_hash: sha256(SECRET), scope: 'read mcp:invoke' },
  { client_id: 'public-agent', scope: 'read' },
];

let idp;
const signingKey = newRsaKey();
// Strict binding: every client_id an ID-JAG may carry is listed, mapped to the client that redeems it.
const ALIASES = { 'pf-client': 'agent-1', 'agent-1': 'agent-1', 'public-agent': 'public-agent' };
const trust = (clientAliases = ALIASES, extra = {}) => ({ id: 'test', issuer: idp.issuer, jwksUrl: idp.jwksUrl, clientAliases, scopes: '', ...extra });
const open = [];

beforeAll(async () => { idp = await startTestIdp(); });
afterAll(() => idp.close());
afterEach(async () => {
  idp.jwks = idp.defaultJwks;
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function startAs(overrides = {}) {
  const logs = [];
  const srv = await listen(createHandler({
    issuer: AS_ISSUER,
    acceptedResources: [RESOURCE, OTHER_RESOURCE],
    clients: CLIENTS,
    allowPublicClients: false,
    accessTokenTtl: 3600,
    signingKey,
    idps: [trust()],
    log: (line) => logs.push(line),
    ...overrides,
  }));
  open.push(srv);
  return { ...srv, logs };
}

const idJag = (claims, header, key) =>
  mintIdJag(idp, { audience: AS_ISSUER, resource: RESOURCE }, claims, header, key);

async function post(as, form, headers = {}) {
  const res = await fetch(`${as.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

const redeem = (as, assertion, extra = {}) =>
  post(as, { grant_type: JWT_BEARER, assertion, client_id: 'agent-1', client_secret: SECRET, ...extra });

const claimsOf = (jwt) => jose.decodeJwt(jwt);

describe('metadata and jwks', () => {
  it('advertises the jwt-bearer grant and the id-jag profile', async () => {
    const as = await startAs();
    const md = await (await fetch(`${as.url}/.well-known/oauth-authorization-server`)).json();
    expect(md).toMatchObject({
      issuer: AS_ISSUER,
      token_endpoint: `${AS_ISSUER}/token`,
      jwks_uri: `${AS_ISSUER}/jwks`,
      grant_types_supported: [JWT_BEARER],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],
      // MCP SDK clients reject metadata without these; there are no redirect grants here.
      authorization_endpoint: `${AS_ISSUER}/authorize`,
      response_types_supported: [],
    });
    const authz = await fetch(`${as.url}/authorize?response_type=code`);
    expect(authz.status).toBe(400);
    expect((await authz.json()).error).toBe('unsupported_response_type');
  });

  it('advertises "none" only when public clients are allowed', async () => {
    const as = await startAs({ allowPublicClients: true });
    const md = await (await fetch(`${as.url}/.well-known/oauth-authorization-server`)).json();
    expect(md.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('serves only the public half of its signing key', async () => {
    const as = await startAs();
    const { keys } = await (await fetch(`${as.url}/jwks`)).json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    expect(keys[0].kid).toBeTruthy();
    expect(keys[0].d).toBeUndefined();
  });
});

describe('a valid ID-JAG', () => {
  it('is redeemed for an access token bound to the resource', async () => {
    const as = await startAs();
    const res = await redeem(as, await idJag());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read mcp:invoke' });
    expect(res.body.refresh_token).toBeUndefined();

    const jwks = jose.createLocalJWKSet(await (await fetch(`${as.url}/jwks`)).json());
    const { payload, protectedHeader } = await jose.jwtVerify(res.body.access_token, jwks, {
      issuer: AS_ISSUER, audience: RESOURCE, typ: 'at+jwt',
    });
    expect(protectedHeader.kid).toBeTruthy();
    expect(payload).toMatchObject({ sub: 'user-123', aud: RESOURCE, client_id: 'agent-1', scope: 'read mcp:invoke' });
    expect(payload.exp - payload.iat).toBe(3600);
    expect(payload.jti).toBeTruthy();
  });

  it('accepts client_secret_basic', async () => {
    const as = await startAs();
    const basic = Buffer.from(`agent-1:${SECRET}`).toString('base64');
    const res = await post(as, { grant_type: JWT_BEARER, assertion: await idJag() }, { authorization: `Basic ${basic}` });
    expect(res.status).toBe(200);
  });

  it('accepts a Basic secret with + and / sent raw (curl -u) or form-encoded (RFC 6749 §2.3.1)', async () => {
    const secret = 'a+b/c=d e';
    const as = await startAs({ clients: [{ client_id: 'agent-1', client_secret_hash: sha256(secret), scope: 'read' }] });
    for (const sent of [secret, encodeURIComponent(secret)]) {
      const basic = Buffer.from(`agent-1:${sent}`).toString('base64');
      const res = await post(as, { grant_type: JWT_BEARER, assertion: await idJag({ scope: 'read' }) }, { authorization: `Basic ${basic}` });
      expect(res.status).toBe(200);
    }
  });

  it('accepts an x5t-only header when a static JWKS lists the same key under three kids', async () => {
    const same = publicJwk(idp.privateKey, { x5t: 'pf-thumbprint' });
    idp.jwks = { keys: [{ ...same, kid: 'a' }, { ...same, kid: 'a_RS256' }, { ...same, kid: 'atm' }] };
    const as = await startAs();
    const res = await redeem(as, await idJag({}, { kid: undefined, x5t: 'pf-thumbprint' }));
    expect(res.status).toBe(200);
  });

  it('honours the client alias the IdP put in client_id', async () => {
    const as = await startAs();
    const res = await redeem(as, await idJag({ client_id: 'pf-client' }));
    expect(res.status).toBe(200);
    expect(claimsOf(res.body.access_token).client_id).toBe('agent-1');
  });

  it('accepts <resource>/ as <resource> (xaa.dev adds the slash), in the ID-JAG and in the request; aud is the configured one', async () => {
    const as = await startAs();
    for (const [claim, sent] of [[`${RESOURCE}/`, undefined], [RESOURCE, `${RESOURCE}/`], [`${RESOURCE}/`, `${RESOURCE}/`]]) {
      const res = await redeem(as, await idJag({ resource: claim }), sent ? { resource: sent } : {});
      expect(res.status).toBe(200);
      expect(claimsOf(res.body.access_token).aud).toBe(RESOURCE);
    }
  });

  it('binds aud to the resource the request names when the ID-JAG names the same one', async () => {
    const as = await startAs();
    const res = await redeem(as, await idJag(), { resource: RESOURCE });
    expect(res.status).toBe(200);
    expect(claimsOf(res.body.access_token).aud).toBe(RESOURCE);
  });

  it('accepts a public client only when ALLOW_PUBLIC_CLIENTS is on', async () => {
    const as = await startAs({ allowPublicClients: true });
    const res = await post(as, {
      grant_type: JWT_BEARER, client_id: 'public-agent', assertion: await idJag({ client_id: 'public-agent', scope: 'read' }),
    });
    expect(res.status).toBe(200);
  });

  it('is accepted from an IdP the registry lists', async () => {
    const registry = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ idps: [{ id: 'reg', issuer: idp.issuer, jwksUrl: idp.jwksUrl, clientAliases: { 'reg-agent': 'agent-1' } }] }));
    });
    open.push(registry);
    const as = await startAs({ idps: [], registry: { url: registry.url } });
    expect((await redeem(as, await idJag({ client_id: 'reg-agent' }))).status).toBe(200);
    // Registry entries bind strictly too: the redeeming client's own id is not listed, so it is refused.
    const res = await redeem(as, await idJag());
    expect(res.status).toBe(400);
    expect(res.body.error_description).toBe('ID-JAG client_id is not assigned to this IdP');
  });

  it('picks up clients written to CLIENTS_FILE after start (provisioned or rotated), no restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-clients-'));
    const clientsFile = path.join(dir, 'clients.json');
    fs.writeFileSync(clientsFile, JSON.stringify(CLIENTS));
    const env = { CLIENTS_FILE: clientsFile, RESOURCE_AS_CLIENT_ID: 'env-client', RESOURCE_AS_CLIENT_SECRET: 'env-secret', RESOURCE_AS_CLIENT_SCOPE: 'read' };
    const as = await startAs({ reloadClients: () => loadClients(env), idps: [trust({ 'env-client': 'env-client', 'idp-acme': 'idp-acme' })] });
    const asEnv = async () => redeem(as, await idJag({ client_id: 'env-client' }), { client_id: 'env-client', client_secret: 'env-secret' });
    const asNew = async (secret) => redeem(as, await idJag({ client_id: 'idp-acme' }), { client_id: 'idp-acme', client_secret: secret });
    expect((await asNew('first-secret')).status).toBe(401);
    fs.writeFileSync(clientsFile, JSON.stringify([...CLIENTS, { client_id: 'idp-acme', client_secret_hash: sha256('first-secret'), scope: 'read' }]));
    expect((await asNew('first-secret')).status).toBe(200);
    fs.writeFileSync(clientsFile, JSON.stringify([...CLIENTS, { client_id: 'idp-acme', client_secret_hash: sha256('second-secret'), scope: 'read' }]));
    expect((await asNew('first-secret')).status).toBe(401);
    expect((await asNew('second-secret')).status).toBe(200);
    expect((await asEnv()).status).toBe(200); // the env client (RESOURCE_AS_CLIENT_SECRET) survives every reload
    fs.writeFileSync(clientsFile, '{broken'); // a bad write keeps the last good list
    expect((await asNew('second-secret')).status).toBe(200);
    expect(as.logs.join('\n')).toMatch(/CLIENTS_FILE/);
  });
});

describe('scope', () => {
  it('grants the intersection of ID-JAG, client and request scope', async () => {
    const as = await startAs();
    const res = await redeem(as, await idJag({ scope: 'read mcp:invoke admin' }), { scope: 'read admin' });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('read');
  });

  it('caps at the IdP scopes', async () => {
    const as = await startAs({ idps: [trust(ALIASES, { scopes: 'mcp:invoke' })] });
    const res = await redeem(as, await idJag());
    expect(res.body.scope).toBe('mcp:invoke');
  });

  it('refuses with invalid_scope when nothing overlaps the client', async () => {
    const as = await startAs();
    const res = await redeem(as, await idJag({ scope: 'openid profile offline_access' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect(res.body.access_token).toBeUndefined();
  });

  it('refuses with invalid_scope when the request asks for a scope the ID-JAG did not grant', async () => {
    const as = await startAs();
    const res = await redeem(as, await idJag({ scope: 'read' }), { scope: 'mcp:invoke' });
    expect(res.body.error).toBe('invalid_scope');
  });
});

describe('refusals', () => {
  const expectRefused = (res, error = 'invalid_grant', status = 400) => {
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(error);
    expect(res.body.access_token).toBeUndefined();
  };

  it('unknown issuer', async () => {
    const as = await startAs();
    const res = await redeem(as, await idJag({ iss: 'https://evil.example' }));
    expectRefused(res);
    expect(res.body.error_description).toBe('ID-JAG issuer is not trusted');
  });

  it('bad signature', async () => {
    const as = await startAs();
    expectRefused(await redeem(as, await idJag({}, {}, newRsaKey())));
  });

  it('wrong typ', async () => {
    const as = await startAs();
    expectRefused(await redeem(as, await idJag({}, { typ: 'JWT' })));
  });

  it('missing typ', async () => {
    const as = await startAs();
    expectRefused(await redeem(as, await idJag({}, { typ: undefined })));
  });

  it('wrong aud', async () => {
    const as = await startAs();
    expectRefused(await redeem(as, await idJag({ aud: 'https://someone-else.example' })));
  });

  it('aud naming more than one authorization server', async () => {
    const as = await startAs();
    expectRefused(await redeem(as, await idJag({ aud: [AS_ISSUER, 'https://someone-else.example'] })));
  });

  it('expired', async () => {
    const as = await startAs();
    const now = Math.floor(Date.now() / 1000);
    expectRefused(await redeem(as, await idJag({ iat: now - 600, exp: now - 60 })));
  });

  it.each(['iss', 'sub', 'aud', 'client_id', 'jti', 'exp', 'iat'])('missing required claim %s', async (claim) => {
    const as = await startAs();
    expectRefused(await redeem(as, await idJag({ [claim]: undefined })));
  });

  // Strict client binding (file and registry entries alike): the ID-JAG's client_id must be one of the
  // IdP's clientAliases keys, and the authenticating client its mapped value.
  it.each([
    ['not listed for this IdP', { 'pf-client': 'agent-1' }, 'someone-else'],
    ['equal to the authenticating client but not listed', { 'pf-client': 'agent-1' }, 'agent-1'],
    ['listed, but mapped to a different client', { 'pf-client': 'agent-2' }, 'pf-client'],
    ['an inherited object key', ALIASES, 'constructor'],
  ])('client_id %s', async (_, aliases, clientId) => {
    const as = await startAs({ idps: [trust(aliases)] });
    const res = await redeem(as, await idJag({ client_id: clientId }));
    expectRefused(res);
    expect(res.body.error_description).toBe('ID-JAG client_id is not assigned to this IdP');
  });

  it('client not authenticated: wrong secret', async () => {
    const as = await startAs();
    expectRefused(await redeem(as, await idJag(), { client_secret: 'wrong' }), 'invalid_client', 401);
  });

  it('client not authenticated: no client at all', async () => {
    const as = await startAs();
    expectRefused(await post(as, { grant_type: JWT_BEARER, assertion: await idJag() }), 'invalid_client', 401);
  });

  it('client not authenticated: confidential client without its secret', async () => {
    const as = await startAs();
    expectRefused(await post(as, { grant_type: JWT_BEARER, client_id: 'agent-1', assertion: await idJag() }), 'invalid_client', 401);
  });

  it('client not authenticated: wrong Basic secret answers with WWW-Authenticate', async () => {
    const as = await startAs();
    const basic = Buffer.from('agent-1:wrong').toString('base64');
    const res = await post(as, { grant_type: JWT_BEARER, assertion: await idJag() }, { authorization: `Basic ${basic}` });
    expectRefused(res, 'invalid_client', 401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic/);
  });

  it('public client while public clients are off (the default)', async () => {
    const as = await startAs();
    expectRefused(await post(as, {
      grant_type: JWT_BEARER, client_id: 'public-agent', assertion: await idJag({ client_id: 'public-agent', scope: 'read' }),
    }), 'invalid_client', 401);
  });

  it('resource not accepted by this AS', async () => {
    const as = await startAs();
    expectRefused(await redeem(as, await idJag({ resource: 'https://not-ours.example' })), 'invalid_target');
  });

  it('missing resource claim', async () => {
    const as = await startAs();
    expectRefused(await redeem(as, await idJag({ resource: undefined })), 'invalid_target');
  });

  it('request resource differing from the ID-JAG resource', async () => {
    const as = await startAs();
    expectRefused(await redeem(as, await idJag(), { resource: OTHER_RESOURCE }), 'invalid_target');
  });

  it('replayed jti', async () => {
    const as = await startAs();
    const assertion = await idJag();
    expect((await redeem(as, assertion)).status).toBe(200);
    const res = await redeem(as, assertion);
    expectRefused(res);
    expect(res.body.error_description).toMatch(/replay/);
  });

  it('replayed jti after a restart (replay file)', async () => {
    const replayFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-')), 'replay.json');
    const assertion = await idJag();
    const first = await startAs({ replayFile });
    expect((await redeem(first, assertion)).status).toBe(200);
    await first.close();
    const second = await startAs({ replayFile });
    expectRefused(await redeem(second, assertion));
    expect(fs.statSync(replayFile).mode & 0o777).toBe(0o600);
  });

  it('a refused request does not burn the ID-JAG for a correct retry', async () => {
    const as = await startAs();
    const assertion = await idJag({ scope: 'read' });
    expectRefused(await redeem(as, assertion, { scope: 'mcp:invoke' }), 'invalid_scope');
    expectRefused(await redeem(as, assertion, { client_secret: 'wrong' }), 'invalid_client', 401);
    expect((await redeem(as, assertion)).status).toBe(200);
  });

  it('two different keys published under one x5t', async () => {
    const other = newRsaKey();
    idp.jwks = { keys: [publicJwk(idp.privateKey, { kid: 'a', x5t: 'pf-thumbprint' }), publicJwk(other, { kid: 'b', x5t: 'pf-thumbprint' })] };
    const as = await startAs();
    const res = await redeem(as, await idJag({}, { kid: undefined, x5t: 'pf-thumbprint' }));
    expectRefused(res);
    expect(res.body.error_description).toMatch(/found 2/);
  });

  it('a grant type other than jwt-bearer', async () => {
    const as = await startAs();
    expectRefused(await post(as, { grant_type: 'client_credentials', client_id: 'agent-1', client_secret: SECRET }), 'unsupported_grant_type');
  });

  it('a missing assertion', async () => {
    const as = await startAs();
    expectRefused(await post(as, { grant_type: JWT_BEARER, client_id: 'agent-1', client_secret: SECRET }), 'invalid_request');
  });
});

describe('logging', () => {
  it('logs one line per decision and never a token', async () => {
    const as = await startAs();
    const assertion = await idJag();
    const ok = await redeem(as, assertion);
    await redeem(as, assertion);
    expect(as.logs).toHaveLength(2);
    expect(as.logs[0]).toMatch(/accepted/);
    expect(as.logs[1]).toMatch(/refused/);
    const all = as.logs.join('\n');
    expect(all).not.toContain(assertion.split('.')[2]);
    expect(all).not.toContain(ok.body.access_token.split('.')[2]);
    expect(all).not.toContain(SECRET);
  });
});
