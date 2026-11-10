// Phase 3A: step 4 against mcp-sample, the protected resource, preflight, and the registry's pf-as entry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import router, { _clearProbeCache } from '../idJagPlayground.js';
import registry from '../registry/routes.js';

const ORIGIN = 'https://app.test';
const PF = 'https://pf.test';
const ACME = 'https://acme.test';
const AS = 'http://localhost:4721';
const MCP = 'http://mcp-sample:9090/mcp';
const RESOURCE = 'http://localhost:4722/mcp';
const SECRETS = { PF_EXCHANGE_CLIENT_SECRET: 'exchange-secret', RESOURCE_AS_CLIENT_SECRET: 'redeem-secret', ID_JAG_REGISTRY_TOKEN: 'registry-token' };
const ENV = {
  APP_ORIGIN: ORIGIN, PF_URL: PF, PF_EXCHANGE_CLIENT_ID: 'pf-exchange', RESOURCE_AS_ISSUER: AS,
  RESOURCE_AS_TOKEN_ENDPOINT: 'http://resource-as:9080/token', ID_JAG_RESOURCE: RESOURCE, MCP_URL: MCP, ...SECRETS,
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (header, claims) => `${b64(header)}.${b64(claims)}.c2lnbmF0dXJl`;
const now = () => Math.floor(Date.now() / 1000);
const idJag = (over = {}) => jwt({ alg: 'RS256', typ: 'oauth-id-jag+jwt' }, {
  iss: PF, sub: 'demouser', aud: AS, client_id: 'id-jag-playground', jti: 'j1', iat: now(), exp: now() + 300, resource: RESOURCE, scope: 'read mcp:invoke', ...over,
});
const accessToken = (over = {}) => jwt({ alg: 'RS256', typ: 'at+jwt' }, { iss: AS, sub: 'demouser', aud: RESOURCE, scope: 'read', exp: now() + 3600, ...over });

const reply = (status, data, headers = {}) => ({ status, json: async () => data, headers: new Headers(headers) });
let fetchMock;
const signedIn = (pg) => ({ idJagPlaygroundMode: 'pf-as', idJagIssuer: { mode: 'pf-as', refreshToken: 'rt-secret' }, idJagPlayground: pg });
function appWith(session) {
  const app = express();
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/pg/trusted-idps', registry); // as createApp mounts it, ahead of the playground
  app.use('/pg', router);
  return app;
}
const post = (app, p, body) => request(app).post(p).set('Origin', ORIGIN).send(body || {});
const preflight = (app, q) => request(app).get(`/pg/preflight?${new URLSearchParams({ origin: ORIGIN, ...q })}`);
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

beforeEach(() => {
  vi.stubEnv('DATA_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-')));
  Object.entries(ENV).forEach(([k, v]) => vi.stubEnv(k, v));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  _clearProbeCache();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('step 4: the MCP server (mcp-sample)', () => {
  it('tools/list goes to MCP_URL with the access token and names the hidden tools by scope', async () => {
    fetchMock.mockResolvedValue(reply(200, { jsonrpc: '2.0', id: 1, result: {
      tools: [{ name: 'whoami', description: 'Who', inputSchema: { type: 'object' } }],
      _meta: { deniedTools: [{ name: 'echo', requiredScope: 'mcp:invoke' }] } } }));
    const at = accessToken(); // mint once (stamps the current second)
    const res = await post(appWith(signedIn({ accessToken: at })), '/pg/call');
    expect(res.status).toBe(200);
    expect(res.body.tools).toEqual([{ name: 'whoami', description: 'Who', inputSchema: { type: 'object' } }]);
    expect(res.body.deniedTools).toEqual(['echo (needs mcp:invoke)']);
    expect(res.body.request).toEqual({ endpoint: `POST ${MCP}`, authorization: 'Bearer [access token]', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(MCP);
    expect(init.headers.Authorization).toBe(`Bearer ${at}`);
    expect(JSON.parse(init.body)).toMatchObject({ jsonrpc: '2.0', method: 'tools/list' });
  });

  it('tools/call returns the result; a refusal comes back as 422 with the MCP server\'s answer in plain words', async () => {
    const app = appWith(signedIn({ accessToken: accessToken() }));
    fetchMock.mockResolvedValueOnce(reply(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } }));
    const ok = await post(app, '/pg/call', { tool: 'echo', arguments: { text: 'hi' } });
    expect(ok.body.result.content[0].text).toBe('hi');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).params).toEqual({ name: 'echo', arguments: { text: 'hi' } });

    fetchMock.mockResolvedValueOnce(reply(403, { jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'insufficient_scope', data: { tool: 'echo', requiredScope: 'mcp:invoke' } } },
      { 'www-authenticate': 'Bearer error="insufficient_scope", scope="mcp:invoke"' }));
    const refused = await post(app, '/pg/call', { tool: 'echo', arguments: {} });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual(expect.objectContaining({ error: 'insufficient_scope', mcpStatus: 403, message: 'echo needs scope mcp:invoke; this token does not carry it.' }));
    expect(refused.body.wwwAuthenticate).toContain('insufficient_scope');

    fetchMock.mockResolvedValueOnce(reply(401, { error: 'invalid_token', error_description: 'iss is not trusted' }));
    expect((await post(app, '/pg/call')).body).toEqual(expect.objectContaining({ error: 'invalid_token', message: 'iss is not trusted', mcpStatus: 401 }));
  });

  it('needs a redeemed token first', async () => {
    const res = await post(appWith(signedIn({ idJag: idJag() })), '/pg/call');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_access_token');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('protected resource', () => {
  const profile = { resource: 'http://mcp-sample:9090/protected/profile', verified: [{ check: 'bearer', ok: true, detail: 'ok' }], principal: { sub: 'demouser' }, data: { subject: 'demouser' } };

  it('calls /protected/profile beside MCP_URL with the token, no token, or the raw ID-JAG', async () => {
    // Mint once: idJag()/accessToken() stamp the current second, so a second call can differ.
    const jag = idJag(); const at = accessToken();
    const session = signedIn({ idJag: jag, accessToken: at });
    fetchMock.mockResolvedValue(reply(200, profile));
    const res = await post(appWith(session), '/pg/resource', { variant: 'token' });
    expect(res.body).toEqual({ request: { method: 'GET', url: 'http://mcp-sample:9090/protected/profile', authorization: 'Bearer [access token]' }, status: 200, wwwAuthenticate: null, body: profile });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${at}`);

    fetchMock.mockResolvedValue(reply(401, { error: 'invalid_request' }, { 'www-authenticate': 'Bearer resource_metadata="x"' }));
    const none = await post(appWith(session), '/pg/resource', { variant: 'no-token' });
    expect(none.body).toEqual(expect.objectContaining({ status: 401, wwwAuthenticate: 'Bearer resource_metadata="x"' }));
    expect(fetchMock.mock.calls[1][1].headers).toEqual({});

    await post(appWith(session), '/pg/resource', { variant: 'id-jag' });
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${jag}`);
  });

  it('rejects an unknown variant and a missing token without calling out', async () => {
    expect((await post(appWith(signedIn({})), '/pg/resource', { variant: 'other' })).status).toBe(400);
    const res = await post(appWith(signedIn({})), '/pg/resource', { variant: 'token' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_token');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('preflight', () => {
  it('flags a page on another origin, since every POST from it would be refused', async () => {
    const res = await preflight(appWith(signedIn({})), { step: 'signin', origin: 'http://localhost:4723' });
    expect(res.body.ok).toBe(false);
    expect(byId(res.body.checks).origin).toEqual(expect.objectContaining({ status: 'fail', fix: expect.stringContaining('APP_ORIGIN=http://localhost:4723') }));
  });

  it('mode: names the settings an unconfigured mode needs', async () => {
    const res = await preflight(appWith({}), { step: 'mode', mode: 'pf-pf' });
    expect(res.body.ok).toBe(false);
    expect(byId(res.body.checks).mode.detail).toContain('ACME_EXCHANGE_CLIENT_ID');
  });

  it('redeem: blocks an already redeemed ID-JAG and a scope it does not carry, with the fix', async () => {
    fetchMock.mockResolvedValue(reply(200, { keys: [{ kty: 'RSA', n: 'a', e: 'AQAB' }] }));
    const res = await preflight(appWith(signedIn({ idJag: idJag(), redeemed: true })), { step: 'redeem', mode: 'pf-as', scope: 'admin:all' });
    const c = byId(res.body.checks);
    expect(res.body.ok).toBe(false);
    expect(c['id-jag']).toEqual(expect.objectContaining({ status: 'fail', fix: 'Request a new ID-JAG (step 2).' }));
    expect(c.scope.status).toBe('fail');
    expect(c['signed-in'].status).toBe('pass');
    expect(c.config.status).toBe('pass');
  });

  it('a session in another mode is told to reload, and a missing sign-in fails', async () => {
    expect(byId((await preflight(appWith(signedIn({})), { step: 'issue', mode: 'byo' })).body.checks)['mode-sync'].status).toBe('fail');
    fetchMock.mockResolvedValue(reply(200, { issuer: PF, keys: [] }));
    const res = await preflight(appWith({ idJagPlaygroundMode: 'pf-as' }), { step: 'issue', mode: 'pf-as' });
    expect(byId(res.body.checks)['signed-in'].status).toBe('fail');
  });

  it('call: checks the token and that the MCP server trusts its issuer and is its audience', async () => {
    fetchMock.mockResolvedValue(reply(200, { resource: RESOURCE, authorization_servers: [AS] }));
    const good = await preflight(appWith(signedIn({ accessToken: accessToken() })), { step: 'call', mode: 'pf-as' });
    expect(good.body.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('http://mcp-sample:9090/.well-known/oauth-protected-resource');

    const wrongAud = await preflight(appWith(signedIn({ accessToken: accessToken({ aud: 'http://other/mcp' }) })), { step: 'call', mode: 'pf-as' });
    expect(byId(wrongAud.body.checks)['mcp-trust']).toEqual(expect.objectContaining({ status: 'fail', fix: expect.stringContaining(`ID_JAG_RESOURCE to ${RESOURCE}`) }));
    const expired = await preflight(appWith(signedIn({ accessToken: accessToken({ exp: now() - 5 }) })), { step: 'call', mode: 'pf-as' });
    expect(byId(expired.body.checks)['access-token'].status).toBe('fail');
  });

  it('caches answers 30 s, never failures, and Re-check (fresh=1) bypasses the cache', async () => {
    const app = appWith(signedIn({ accessToken: accessToken() }));
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const down = await preflight(app, { step: 'call', mode: 'pf-as' });
    expect(byId(down.body.checks).mcp.detail).toContain('ECONNREFUSED');
    fetchMock.mockResolvedValue(reply(200, { resource: RESOURCE, authorization_servers: [AS] }));
    expect((await preflight(app, { step: 'call', mode: 'pf-as' })).body.ok).toBe(true); // the failure was not cached
    await preflight(app, { step: 'call', mode: 'pf-as' });
    expect(fetchMock).toHaveBeenCalledTimes(2); // the success was
    await preflight(app, { step: 'call', mode: 'pf-as', fresh: '1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('times a probe out after 4 s', async () => {
    fetchMock.mockImplementation((_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    });
    const res = await preflight(appWith(signedIn({ accessToken: accessToken() })), { step: 'call', mode: 'pf-as' });
    expect(byId(res.body.checks).mcp.detail).toContain('no answer within 4 s');
  });

  it('pf-pf warns about a multi-key JWKS that the PingFederate redeemer cannot pick from', async () => {
    Object.entries({ ACME_PF_URL: ACME, ACME_EXCHANGE_CLIENT_ID: 'acme', ACME_EXCHANGE_CLIENT_SECRET: 'acme-secret', PF_REDEEMER_CLIENT_SECRET: 'redeemer-secret' })
      .forEach(([k, v]) => vi.stubEnv(k, v));
    fetchMock.mockImplementation(async (url) => reply(200, String(url).endsWith('/pf/JWKS')
      ? { keys: [{ kty: 'RSA', n: 'a', e: 'AQAB', x5t: 't1' }, { kty: 'RSA', n: 'b', e: 'AQAB', x5t: 't2' }] } : { issuer: ACME }));
    const res = await preflight(appWith({ idJagPlaygroundMode: 'pf-pf', idJagIssuer: { mode: 'pf-pf', refreshToken: 'rt' } }), { step: 'issue', mode: 'pf-pf' });
    expect(byId(res.body.checks).jwks.status).toBe('warn');
    expect(res.body.ok).toBe(true);
  });

  describe('pf-as: the issuer\'s /pf/JWKS must hold an RSA key with x5t (resource-as picks by x5t, so extra keys are fine)', () => {
    const jwks = (keys) => async (url) => reply(200, String(url).endsWith('/pf/JWKS') ? { keys } : { issuer: PF });
    const issueJwks = async (keys) => {
      fetchMock.mockImplementation(jwks(keys));
      return byId((await preflight(appWith(signedIn({})), { step: 'issue', mode: 'pf-as' })).body.checks).jwks;
    };
    it('passes for one key listed under several kids', async () => {
      const c = await issueJwks([{ kty: 'RSA', n: 'a', e: 'AQAB', x5t: 't', kid: 'one' }, { kty: 'RSA', n: 'a', e: 'AQAB', x5t: 't', kid: 'two' }]);
      expect(c.status).toBe('pass');
    });
    it('fails when no RSA key carries x5t (nothing can verify an ID-JAG), with the fix', async () => {
      const c = await issueJwks([{ kty: 'RSA', n: 'a', e: 'AQAB', kid: 'dynamic' }]);
      expect(c).toEqual(expect.objectContaining({ status: 'fail', fix: expect.stringContaining('setup -- --mode=pf-local') }));
    });
    it('passes with several distinct RSA keys when one has x5t: resource-as picks the key by x5t', async () => {
      const c = await issueJwks([{ kty: 'RSA', n: 'a', e: 'AQAB', x5t: 't1' }, { kty: 'RSA', n: 'b', e: 'AQAB', x5t: 't2' }, { kty: 'RSA', n: 'c', e: 'AQAB', kid: 'default' }]);
      expect(c.status).toBe('pass');
      expect(c.detail).toContain('3 distinct RSA');
      expect(c.detail).toContain('by x5t');
    });
    it('still fails with several RSA keys and none with x5t', async () => {
      expect((await issueJwks([{ kty: 'RSA', n: 'a', e: 'AQAB', kid: 'k1' }, { kty: 'RSA', n: 'b', e: 'AQAB', kid: 'k2' }])).status).toBe('fail');
    });
  });

  it('never returns a secret, and rejects an unknown step', async () => {
    fetchMock.mockResolvedValue(reply(200, { issuer: PF, keys: [], resource: RESOURCE, authorization_servers: [AS] }));
    for (const step of ['signin', 'issue', 'redeem', 'call', 'negative', 'resource']) {
      const res = await preflight(appWith(signedIn({ idJag: idJag(), accessToken: accessToken() })), { step, mode: 'pf-as', variant: 'token' });
      const text = JSON.stringify(res.body);
      for (const v of [...Object.values(SECRETS), 'rt-secret', idJag(), accessToken()]) expect(text, step).not.toContain(v);
    }
    expect((await preflight(appWith({}), { step: 'nope' })).status).toBe(400);
  });
});

describe('registry read for resource-as', () => {
  const read = (app) => request(app).get('/pg/trusted-idps/registry').set('Authorization', 'Bearer registry-token');

  it('carries PF_URL once pf-as is configured, so resource-as trusts its ID-JAGs', async () => {
    const res = await read(appWith({}));
    // resource-as binds strictly (only listed client_ids redeem), so PF's entry lists both spellings PingFederate
    // may write: the exchange client (the refresh token's owner) and our client itself (SP connection mapping).
    expect(res.body.idps).toEqual([{ id: 'pf-as', issuer: PF, jwksUrl: `${PF}/pf/JWKS`,
      clientAliases: { 'pf-exchange': 'id-jag-playground', 'id-jag-playground': 'id-jag-playground' }, scopes: '' }]);
  });

  it('carries nothing extra while pf-as is not configured', async () => {
    vi.stubEnv('PF_EXCHANGE_CLIENT_SECRET', '');
    expect((await read(appWith({}))).body.idps).toEqual([]);
  });

  it('/config shows the public token endpoint, not the internal one', async () => {
    const res = await request(appWith({})).get('/pg/config');
    expect(res.body.publicEndpoints['resource-as']).toEqual({ issuer: AS, tokenEndpoint: `${AS}/token` });
    expect(res.body.resourceAs.tokenEndpoint).toBe('http://resource-as:9080/token');
  });
});
