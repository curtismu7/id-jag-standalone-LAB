import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import router, { inspect, probeBackends, settings } from '../idJagPlayground.js';
import { createApp } from '../app.js';

const ORIGIN = 'https://app.test';
const PF = 'https://pf.test';
const ACME = 'https://acme.test';
const AS = 'https://mcp-as.test';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (header, claims) => `${b64(header)}.${b64(claims)}.c2lnbmF0dXJl`;
const now = () => Math.floor(Date.now() / 1000);
const goodIdJag = (over = {}, hdr = {}) => jwt({ alg: 'RS256', typ: 'oauth-id-jag+jwt', ...hdr }, {
  iss: PF, sub: 'demouser', aud: AS, client_id: 'id-jag-playground', jti: 'j1', iat: now(), exp: now() + 300,
  resource: `${AS}/mcp`, scope: 'mcp:invoke accounts:read', ...over,
});
const accessToken = jwt({ alg: 'RS256' }, { iss: AS, sub: 'demouser', aud: 'mcp', scope: 'accounts:read' });

const reply = (status, data) => ({ status, json: async () => data });
let fetchMock;

function appWith(session) {
  const app = express();
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/pg', router);
  return app;
}
const post = (app, p, body) => request(app).post(p).set('Origin', ORIGIN).send(body || {});
const sentForm = (i) => new URLSearchParams(fetchMock.mock.calls[i][1].body);

// pf-as fully configured (resource AS settings are Phase 2's, set here by hand).
const PF_AS_ENV = {
  APP_ORIGIN: ORIGIN, PF_URL: PF, PF_EXCHANGE_CLIENT_ID: 'pf-exchange', PF_EXCHANGE_CLIENT_SECRET: 'exchange-secret',
  RESOURCE_AS_ISSUER: AS, RESOURCE_AS_CLIENT_SECRET: 'redeem-secret', ID_JAG_RESOURCE: `${AS}/mcp`, ID_JAG_SCOPE: 'mcp:invoke',
};

beforeEach(() => {
  vi.stubEnv('APP_ORIGIN', ORIGIN);
  vi.stubEnv('DATA_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-')));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const setEnv = (o) => Object.entries(o).forEach(([k, v]) => vi.stubEnv(k, v));

describe('spec inspector', () => {
  const okSig = async () => ({ ok: true, note: 'valid' });
  beforeEach(() => setEnv(PF_AS_ENV));

  it('passes a spec-conformant ID-JAG', async () => {
    const { checks } = await inspect(goodIdJag(), settings('pf-as'), okSig);
    expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
  });

  it.each([
    ['typ', () => goodIdJag({}, { typ: 'JWT' })],
    ['alg', () => goodIdJag({}, { alg: 'none' })],
    ['aud', () => goodIdJag({ aud: [AS, 'https://other.test'] })],
    ['client_id', () => goodIdJag({ client_id: 'pf-exchange' })],
    ['iss', () => goodIdJag({ iss: 'https://evil.test' })],
    ['claim-iat', () => goodIdJag({ iat: undefined })],
    ['exp', () => goodIdJag({ exp: now() - 10 })],
    ['scope', () => goodIdJag({ scope: 'openid profile email offline_access' })],
  ])('fails the %s check when it is wrong', async (id, token) => {
    const { checks } = await inspect(token(), settings('pf-as'), okSig);
    expect(checks.find((c) => c.id === id).status).toBe('fail');
  });

  it('reports a bad signature', async () => {
    const { checks } = await inspect(goodIdJag(), settings('pf-as'), async () => ({ ok: false, note: 'signature verification failed' }));
    expect(checks.find((c) => c.id === 'signature')).toEqual(expect.objectContaining({ status: 'fail', actual: 'signature verification failed' }));
  });

  it('warns (not fails) on a long-lived ID-JAG', async () => {
    const { checks } = await inspect(goodIdJag({ exp: now() + 3600 }), settings('pf-as'), okSig);
    expect(checks.find((c) => c.id === 'lifetime').status).toBe('warn');
  });

  it('x5t lookup counts distinct keys, so one cert listed under several kids still verifies the lookup', async () => {
    const key = { kty: 'RSA', n: 'abc', e: 'AQAB', x5t: 't1' };
    fetchMock.mockResolvedValue(reply(200, { keys: [{ ...key, kid: 'a' }, { ...key, kid: 'b' }] }));
    const { checks } = await inspect(goodIdJag({}, { x5t: 't1' }), settings('pf-as'));
    // The key is bogus so verification fails, but not on the "expected one key" lookup.
    expect(checks.find((c) => c.id === 'signature').actual).not.toMatch(/expected one JWKS key/);
    fetchMock.mockResolvedValue(reply(200, { keys: [{ ...key, kid: 'a' }, { ...key, n: 'other', kid: 'b' }] }));
    const two = await inspect(goodIdJag({}, { x5t: 't1' }), settings('pf-as'));
    expect(two.checks.find((c) => c.id === 'signature').actual).toMatch(/found 2/);
  });
});

describe('gating', () => {
  it('real modes answer 409 not_configured with the default env (Phase 1)', async () => {
    for (const mode of ['pf-as', 'pf-pf']) {
      const app = appWith({ idJagPlaygroundMode: mode });
      for (const p of ['/pg/issue', '/pg/redeem', '/pg/call', '/pg/negative/replay']) {
        const res = await post(app, p);
        expect(res.status, `${mode} ${p}`).toBe(409);
        expect(res.body.error).toBe('not_configured');
        expect(res.body.missing.length).toBeGreaterThan(0);
      }
      const start = await request(app).get('/pg/issuer/pi-flow/start');
      expect(start.status).toBe(409);
      expect(start.body.error).toBe('not_configured');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('/config lists real modes as unavailable with the env vars to set, byo available', async () => {
    const res = await request(appWith({})).get('/pg/config');
    expect(res.body.mode).toBe('byo');
    const byId = Object.fromEntries(res.body.modes.map((m) => [m.id, m]));
    expect(byId.byo.available).toBe(true);
    expect(byId['pf-as']).toEqual(expect.objectContaining({ available: false, reason: expect.stringContaining('RESOURCE_AS_ISSUER') }));
    expect(byId['pf-pf']).toEqual(expect.objectContaining({ available: false, reason: expect.stringContaining('ACME_EXCHANGE_CLIENT_SECRET') }));
    expect(res.body.publicEndpoints.pingfederate.issuer).toBe('https://pf.example.invalid');
  });

  it('"Not configured" for pf-pf says who supplies the Acme values and how to import them; other modes get no such hint', async () => {
    const res = await post(appWith({ idJagPlaygroundMode: 'pf-pf' }), '/pg/issue');
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('owner of the shared Acme PingFederate');
    expect(res.body.message).toContain('npm run setup -- --mode=pf-pf --acme-settings=<file>');
    expect(res.body.message).toContain('typed into the sign-in modal');
    const modes = (await request(appWith({})).get('/pg/config')).body.modes;
    expect(modes.find((m) => m.id === 'pf-pf').reason).toContain('--acme-settings=<file>');
    expect(modes.find((m) => m.id === 'pf-as').reason).not.toContain('Acme');
  });

  it('/config never carries a secret', async () => {
    setEnv({ ...PF_AS_ENV, ACME_EXCHANGE_CLIENT_SECRET: 'acme-secret', PF_REDEEMER_CLIENT_SECRET: 'redeemer-secret' });
    const res = await request(appWith({})).get('/pg/config');
    for (const s of ['exchange-secret', 'redeem-secret', 'acme-secret', 'redeemer-secret']) expect(JSON.stringify(res.body)).not.toContain(s);
  });

  it('requires a sign-in at the issuer once configured: a clear 409', async () => {
    setEnv(PF_AS_ENV);
    const res = await post(appWith({ idJagPlaygroundMode: 'pf-as' }), '/pg/issue');
    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ error: 'sign_in_required', message: expect.stringContaining('Sign in at PingFederate (issuer)') }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a sign-in at the other mode\'s issuer does not count', async () => {
    setEnv(PF_AS_ENV);
    const res = await post(appWith({ idJagPlaygroundMode: 'pf-as', idJagIssuer: { mode: 'pf-pf', refreshToken: 'rt' } }), '/pg/issue');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('sign_in_required');
  });

  it('rejects a cross-origin POST, and one with no Origin', async () => {
    expect((await request(appWith({})).post('/pg/reset').set('Origin', 'https://evil.test').send({})).status).toBe(403);
    expect((await request(appWith({})).post('/pg/reset').send({})).status).toBe(403);
    expect((await post(appWith({}), '/pg/reset')).status).toBe(200);
  });

  it('switches mode, clears tokens from the other pairing, rejects unknown modes', async () => {
    const session = { idJagPlayground: { idJag: 'x' }, save: (cb) => cb() };
    const res = await post(appWith(session), '/pg/mode', { mode: 'pf-pf' });
    expect(res.body.mode).toBe('pf-pf');
    expect(res.body.idp.issuer).toBe('https://pf-acme.example.invalid');
    expect(res.body.resourceAs).toEqual(expect.objectContaining({ issuer: 'https://pf.example.invalid', clientId: 'id-jag-redeemer' }));
    expect(session.idJagPlayground).toBeUndefined();
    expect((await post(appWith(session), '/pg/mode', { mode: 'oauth-mcp' })).status).toBe(400);
  });
});

describe('flow keeps every raw token server-side (pf-as, configured)', () => {
  beforeEach(() => setEnv(PF_AS_ENV));
  const signedIn = () => ({ idJagPlaygroundMode: 'pf-as', idJagIssuer: { mode: 'pf-as', refreshToken: 'rt-secret' } });

  it('issue -> redeem, returning decoded claims only', async () => {
    const session = signedIn();
    const app = appWith(session);
    const idJag = goodIdJag();
    fetchMock
      .mockResolvedValueOnce(reply(200, { access_token: idJag, issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag' }))
      .mockResolvedValueOnce(reply(200, { access_token: accessToken, refresh_token: 'should-not-leak', token_type: 'Bearer', scope: 'accounts:read' }));

    const issued = await post(app, '/pg/issue');
    expect(issued.status).toBe(200);
    expect(issued.body.token.claims.client_id).toBe('id-jag-playground');
    expect(JSON.stringify(issued.body)).not.toContain(idJag);
    expect(JSON.stringify(issued.body)).not.toContain('rt-secret');
    expect(fetchMock.mock.calls[0][0]).toBe(`${PF}/as/token.oauth2`);
    expect(sentForm(0).get('subject_token')).toBe('rt-secret');
    expect(sentForm(0).get('audience')).toBe(AS);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('pf-exchange:exchange-secret').toString('base64')}`);

    const redeemed = await post(app, '/pg/redeem', { scope: 'accounts:read' });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.token.claims.scope).toBe('accounts:read');
    expect(JSON.stringify(redeemed.body)).not.toContain(accessToken);
    expect(JSON.stringify(redeemed.body)).not.toContain('should-not-leak');
    expect(fetchMock.mock.calls[1][0]).toBe(`${AS}/token`);
    expect(sentForm(1).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(sentForm(1).get('scope')).toBe('accounts:read');
    expect(session.idJagPlayground.accessToken).toBe(accessToken);
  });

  it('reports a refused redemption with its OAuth error and keeps no token', async () => {
    const session = signedIn();
    const app = appWith(session);
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() }))
      .mockResolvedValueOnce(reply(400, { error: 'invalid_scope', error_description: 'no scope' }));
    await post(app, '/pg/issue');
    const res = await post(app, '/pg/redeem');
    expect(res.status).toBe(422);
    expect(res.body.response.error).toBe('invalid_scope');
    expect(session.idJagPlayground.accessToken).toBeUndefined();
  });

  it('negative tests: replay passes when the second redemption is refused', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() }))
      .mockResolvedValueOnce(reply(200, { access_token: accessToken }))
      .mockResolvedValueOnce(reply(400, { error: 'invalid_grant' }));
    const res = await post(appWith(signedIn()), '/pg/negative/replay');
    expect(res.body).toEqual(expect.objectContaining({ pass: true, error: 'invalid_grant' }));
  });

  it('negative tests: fails when the resource AS wrongly issues a token', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() })).mockResolvedValueOnce(reply(200, { access_token: accessToken }));
    const res = await post(appWith(signedIn()), '/pg/negative/scope-not-granted');
    expect(res.body.pass).toBe(false);
    expect(sentForm(1).get('scope')).toBe('admin:delete');
  });

  it('negative tests: bad-signature tampers, client-mismatch swaps the client', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() })).mockResolvedValueOnce(reply(400, { error: 'invalid_grant' }));
    expect((await post(appWith(signedIn()), '/pg/negative/bad-signature')).body.pass).toBe(true);
    expect(sentForm(1).get('assertion').split('.')[2]).not.toBe('c2lnbmF0dXJl');
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() })).mockResolvedValueOnce(reply(401, { error: 'invalid_client' }));
    expect((await post(appWith(signedIn()), '/pg/negative/client-mismatch')).body.pass).toBe(true);
    expect(sentForm(1).get('client_id')).toBe('some-other-client');
  });

  it('the MCP call needs MCP_URL', async () => {
    const res = await post(appWith({ ...signedIn(), idJagPlayground: { accessToken } }), '/pg/call');
    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ error: 'not_configured', missing: ['MCP_URL'] }));
  });

  it('refuses a scope the ID-JAG does not carry before calling the resource AS', async () => {
    const res = await post(appWith({ ...signedIn(), idJagPlayground: { idJag: goodIdJag() } }), '/pg/redeem', { scope: 'accounts:read admin:all' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('scope_not_in_id_jag');
    expect(res.body.message).toContain('admin:all');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('issuer sign-in (pf-pf, configured)', () => {
  beforeEach(() => setEnv({ APP_ORIGIN: ORIGIN, PF_URL: PF, ACME_PF_URL: ACME, ACME_EXCHANGE_CLIENT_ID: 'acme-agent',
    ACME_EXCHANGE_CLIENT_SECRET: 'acme-secret', PF_REDEEMER_CLIENT_SECRET: 'redeemer-secret' }));

  it('opens the pi.flow at the issuer with PKCE, and the callback keeps the refresh token server-side', async () => {
    const session = { idJagPlaygroundMode: 'pf-pf', save: (cb) => cb() };
    const app = appWith(session);
    fetchMock.mockResolvedValue(reply(200, { id: 'flow-123456', status: 'USERNAME_PASSWORD_REQUIRED' }));
    const start = await request(app).get('/pg/issuer/pi-flow/start?return_to=/');
    expect(start.status).toBe(200);
    const to = new URL(fetchMock.mock.calls[0][0]);
    expect(to.searchParams.get('response_mode')).toBe('pi.flow');
    expect(to.searchParams.get('prompt')).toBe('login');
    expect(to.origin + to.pathname).toBe(`${ACME}/as/authorization.oauth2`);
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(to.searchParams.get('scope')).toBe('offline_access'); // Acme defines no OIDC scopes
    expect(to.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/id-jag-playground/issuer/callback`);
    fetchMock.mockResolvedValue(reply(200, { refresh_token: 'acme-rt', id_token: jwt({ alg: 'RS256' }, { sub: 'acme-user' }) }));
    const cb = await request(app).get(`/pg/issuer/callback?code=c1&state=${to.searchParams.get('state')}`);
    expect(cb.headers.location).toBe('/');
    expect(session.idJagIssuer).toEqual({ mode: 'pf-pf', refreshToken: 'acme-rt', sub: 'acme-user' });
    expect(fetchMock.mock.calls[1][0]).toBe(`${ACME}/as/token.oauth2`);
  });

  it('config names who is signed in (the app user) so step 1 can say so, only in pf-as', async () => {
    const withUser = { idJagPlaygroundMode: 'pf-as', idJagIssuer: { mode: 'pf-as', refreshToken: 'rt' }, user: { email: 'demo-user@example.invalid' } };
    const asUser = await request(appWith(withUser)).get('/pg/config');
    expect(asUser.body.signedIn).toBe(true);
    expect(asUser.body.signedInAs).toBe('demo-user@example.invalid');
    // Signed out: nobody to name. And another issuer's sign-in is not the app user's.
    expect((await request(appWith({ idJagPlaygroundMode: 'pf-as' })).get('/pg/config')).body.signedInAs).toBeNull();
    const acme = { idJagPlaygroundMode: 'pf-pf', idJagIssuer: { mode: 'pf-pf', refreshToken: 'a' }, user: { email: 'demo-user@example.invalid' } };
    expect((await request(appWith(acme)).get('/pg/config')).body.signedInAs).toBeNull();
  });

  it('restart forgets the ID-JAG and access token but keeps the issuer sign-in, and is refused cross-origin', async () => {
    const session = { idJagPlaygroundMode: 'pf-as', idJagPlayground: { idJag: 'a.b.c', redeemed: true, accessToken: 'at' }, idJagIssuer: { mode: 'pf-as', refreshToken: 'rt' } };
    const ok = await post(appWith(session), '/pg/restart');
    expect(ok.body).toEqual({ ok: true });
    expect(session.idJagPlayground).toBeUndefined();
    expect(session.idJagIssuer).toEqual({ mode: 'pf-as', refreshToken: 'rt' });
    const cross = await request(appWith({})).post('/pg/restart').set('Origin', 'https://evil.test').send({});
    expect(cross.status).toBe(403);
  });

  it('rejects a callback with the wrong state, and an off-site return_to', async () => {
    const session = { idJagIssuerLogin: { mode: 'pf-pf', state: 's1', verifier: 'v', returnTo: '/', at: Date.now() }, save: (cb) => cb() };
    const cb = await request(appWith(session)).get('/pg/issuer/callback?code=c1&state=evil');
    expect(cb.headers.location).toContain('issuer_error=invalid_state');
    expect(session.idJagIssuer).toBeUndefined();
    const s2 = { idJagPlaygroundMode: 'pf-pf', save: (cb2) => cb2() };
    fetchMock.mockResolvedValue(reply(200, { id: 'flow-123456', status: 'USERNAME_PASSWORD_REQUIRED' }));
    await request(appWith(s2)).get('/pg/issuer/pi-flow/start?return_to=//evil.test');
    expect(s2.idJagIssuerLogin.returnTo).toBe('/');
    // A backslash is read as a slash by browsers (/\\host == //host), so it is refused too.
    const s3 = { idJagPlaygroundMode: 'pf-pf', save: (cb3) => cb3() };
    await request(appWith(s3)).get(`/pg/issuer/pi-flow/start?return_to=${encodeURIComponent('/\\evil.test')}`);
    expect(s3.idJagIssuerLogin.returnTo).toBe('/');
  });

  it('issues at Acme and redeems at PingFederate as the redeemer client', async () => {
    const app = appWith({ idJagPlaygroundMode: 'pf-pf', idJagIssuer: { mode: 'pf-pf', refreshToken: 'acme-rt' } });
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag({ iss: ACME, aud: PF, client_id: 'id-jag-redeemer' }) }))
      .mockResolvedValueOnce(reply(200, { access_token: accessToken }));
    expect((await post(app, '/pg/issue')).status).toBe(200);
    expect(sentForm(0).get('audience')).toBe(PF);
    expect((await post(app, '/pg/redeem')).status).toBe(200);
    expect(fetchMock.mock.calls[1][0]).toBe(`${PF}/as/token.oauth2`);
    expect(sentForm(1).get('client_id')).toBe('id-jag-redeemer');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Basic ${Buffer.from('id-jag-redeemer:redeemer-secret').toString('base64')}`);
  });
});

describe('app', () => {
  it('serves the API, a JSON 404 for unknown API paths, and a 503 sign-in until OIDC is configured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('WEB_DIST', '/nonexistent/web-dist'); // a built web/dist would answer unknown paths with the SPA
    const app = createApp();
    expect((await request(app).get('/api/id-jag-playground/config')).body.mode).toBe('byo');
    expect((await request(app).get('/api/nope')).status).toBe(404);
    expect((await request(app).get('/auth/pi-flow/start?return_to=/')).status).toBe(503);
    // No redirect sign-in of any kind exists.
    expect((await request(app).get(`/auth/${'log'}in?return_to=/`)).status).toBe(404);
    expect((await request(app).get(`/api/id-jag-playground/issuer/${'log'}in?return_to=/`)).status).toBe(404);
  });
});

describe('backends', () => {
  const MCP = 'https://mcp.test/mcp';
  beforeEach(() => setEnv({ ...PF_AS_ENV, MCP_URL: MCP }));
  const byId = (list) => Object.fromEntries(list.map((b) => [b.id, b]));

  it('reports each backend up with its probe url', async () => {
    const f = vi.fn(async () => reply(200, {}));
    const b = byId(await probeBackends(settings('pf-as'), MCP, f));
    expect([b.idp.state, b['resource-as'].state, b.mcp.state]).toEqual(['up', 'up', 'up']);
    expect(b.idp.url).toBe(`${PF}/.well-known/openid-configuration`);
    expect(b['resource-as'].url).toBe(`${AS}/.well-known/oauth-authorization-server`);
    expect(b.mcp.url).toBe('https://mcp.test/.well-known/oauth-protected-resource');
  });

  it('probes the resource AS at the token endpoint origin, not the browser-facing issuer (Docker: localhost is unreachable)', async () => {
    await setEnv({ ...PF_AS_ENV, RESOURCE_AS_TOKEN_ENDPOINT: 'http://resource-as:9080/token' });
    const f = vi.fn(async () => reply(200, {}));
    const b = byId(await probeBackends(settings('pf-as'), MCP, f));
    expect(b['resource-as'].url).toBe('http://resource-as:9080/.well-known/oauth-authorization-server');
    expect(f.mock.calls.every(([url]) => !url.startsWith(AS))).toBe(true);
    expect(b['resource-as'].state).toBe('up');
  });

  it('marks a backend down when it never answers', async () => {
    const f = vi.fn(async (url) => {
      if (url.startsWith('https://mcp.test')) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return reply(200, {});
    });
    const b = byId(await probeBackends(settings('pf-as'), MCP, f));
    expect(b.mcp).toMatchObject({ state: 'down', detail: 'no answer in 4 s' });
    expect(b.idp.state).toBe('up');
  });

  it('marks a non-2xx answer down with its status', async () => {
    const f = vi.fn(async (url) => (url.startsWith(PF) ? reply(503, {}) : reply(200, {})));
    const b = byId(await probeBackends(settings('pf-as'), MCP, f));
    expect(b.idp).toMatchObject({ state: 'down', detail: 'HTTP 503' });
  });

  it('serves the probes for the session mode at GET /backends', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    const res = await request(appWith({ idJagPlaygroundMode: 'pf-as' })).get('/pg/backends');
    expect(res.status).toBe(200);
    expect(res.body.backends.map((b) => b.id)).toEqual(['idp', 'resource-as', 'mcp']);
  });

  it('leaves out a backend the mode has no address for (byo: the IdP is yours, nothing to probe)', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    const res = await request(appWith({ idJagPlaygroundMode: 'byo' })).get('/pg/backends');
    expect(res.body.backends.map((b) => b.id)).toEqual(['resource-as', 'mcp']);
    expect(res.body.backends.every((b) => b.state === 'up')).toBe(true);
  });
});


describe('revoke and prove', () => {
  beforeEach(() => setEnv(PF_AS_ENV));
  const signedIn = () => ({ idJagPlaygroundMode: 'pf-as', idJagIssuer: { mode: 'pf-as', refreshToken: 'rt-secret' } });

  it('revokes the refresh token, then proves PingFederate refuses a new ID-JAG', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() })) // control: the exchange works before revoking
      .mockResolvedValueOnce(reply(200, {}))
      .mockResolvedValueOnce(reply(400, { error: 'invalid_grant', error_description: 'refresh token revoked' }));
    const session = signedIn();
    const res = await post(appWith(session), '/pg/revoke');
    expect(res.status).toBe(200);
    expect(res.body.proved).toBe(true);
    expect(res.body.control).toMatchObject({ status: 200 });
    expect(fetchMock.mock.calls[1][0]).toBe(`${PF}/as/revoke_token.oauth2`);
    expect(Object.fromEntries(sentForm(1))).toEqual({ token: 'rt-secret', token_type_hint: 'refresh_token' });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Basic ${Buffer.from('pf-exchange:exchange-secret').toString('base64')}`);
    expect(sentForm(2).get('subject_token')).toBe('rt-secret');
    expect(JSON.stringify(res.body)).not.toContain(goodIdJag().split('.')[1]);
    expect(res.body.retry).toMatchObject({ status: 400, error: 'invalid_grant' });
    expect(session.idJagIssuer).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('rt-secret');
  });

  it('answers 409 sign_in_required when there is nothing to revoke', async () => {
    const res = await post(appWith({ idJagPlaygroundMode: 'pf-as' }), '/pg/revoke');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('sign_in_required');
  });

  it('refuses in byo mode', async () => {
    const res = await post(appWith({ idJagPlaygroundMode: 'byo' }), '/pg/revoke');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('byo_mode');
  });
});

describe('revoke and prove: RFC 8693 refusal', () => {
  beforeEach(() => setEnv(PF_AS_ENV));
  it('a retry refused with invalid_request (RFC 8693 §2.2.2) proves it too', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() })).mockResolvedValueOnce(reply(200, {})).mockResolvedValueOnce(reply(400, { error: 'invalid_request', error_description: 'Invalid subject token' }));
    const res = await post(appWith({ idJagPlaygroundMode: 'pf-as', idJagIssuer: { mode: 'pf-as', refreshToken: 'rt' } }), '/pg/revoke');
    expect(res.body.proved).toBe(true);
  });
  it('a retry that fails without an OAuth error does not prove it', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() })).mockResolvedValueOnce(reply(200, {})).mockResolvedValueOnce(reply(503, {}));
    const res = await post(appWith({ idJagPlaygroundMode: 'pf-as', idJagIssuer: { mode: 'pf-as', refreshToken: 'rt' } }), '/pg/revoke');
    expect(res.body.proved).toBe(false);
  });
});

describe('final review fixes', () => {
  beforeEach(() => setEnv({ ...PF_AS_ENV, MCP_URL: 'https://mcp.test/mcp' }));
  const signedIn = () => ({ idJagPlaygroundMode: 'pf-as', idJagIssuer: { mode: 'pf-as', refreshToken: 'rt' } });

  it('a broken exchange is not proof: no revoke, proved false, still signed in', async () => {
    fetchMock.mockResolvedValueOnce(reply(400, { error: 'invalid_request', error_description: 'bad audience' }));
    const session = signedIn();
    const res = await post(appWith(session), '/pg/revoke');
    expect(res.body.proved).toBe(false);
    expect(res.body.control).toMatchObject({ status: 400, error: 'invalid_request' });
    expect(res.body.revoke).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.idJagIssuer).toEqual({ mode: 'pf-as', refreshToken: 'rt' });
  });

  it('shows the JSON-RPC id it sends, so the Code tab can be run', async () => {
    fetchMock.mockResolvedValue({ status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) });
    const res = await post(appWith({ ...signedIn(), idJagPlayground: { accessToken } }), '/pg/call');
    expect(res.body.request.body).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  });
});


describe('GET /as-events', () => {
  const EVENTS = (n = 7) => Array.from({ length: n }, (_, i) => ({ decision: 'accepted', jti: `${i}`.repeat(8) + '…', client_id: `c${i}` }));
  const get = (session) => request(appWith(session)).get('/pg/as-events');
  const pfAs = (idJag) => ({ idJagPlaygroundMode: 'pf-as', idJagPlayground: idJag ? { idJag } : undefined });
  beforeEach(() => setEnv({ ...PF_AS_ENV, RESOURCE_AS_TOKEN_ENDPOINT: 'http://resource-as.internal:9080/token' }));

  it.each([
    ['pf-pf', { idJagPlaygroundMode: 'pf-pf' }],
    ['byo to PingFederate', { idJagPlaygroundMode: 'byo', idJagPlayground: { byo: { target: 'pingfederate' } } }],
  ])('is unavailable when %s redeems at PingFederate', async (_n, session) => {
    const res = await get(session);
    expect(res.body).toEqual({ available: false, reason: "This mode redeems at PingFederate, not at the kit's resource AS." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is available for pf-as and for byo to the resource AS, reading the fixed events URL', async () => {
    fetchMock.mockResolvedValue(reply(200, { events: EVENTS() }));
    for (const session of [pfAs(), { idJagPlaygroundMode: 'byo', idJagPlayground: { byo: { target: 'resource-as' } } }]) {
      const res = await get(session);
      expect(res.body.available).toBe(true);
    }
    expect(fetchMock.mock.calls[0][0]).toBe('http://resource-as.internal:9080/events');
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
  });

  it('keeps the issuer path when the token endpoint lives under one (…/resource-as/token → …/resource-as/events)', async () => {
    fetchMock.mockResolvedValue(reply(200, { events: EVENTS() }));
    await setEnv({ ...PF_AS_ENV, RESOURCE_AS_TOKEN_ENDPOINT: 'https://as.example.com/resource-as/token' });
    await get(pfAs());
    expect(fetchMock.mock.calls[0][0]).toBe('https://as.example.com/resource-as/events');
  });

  it('matches the newest event by the ID-JAG jti prefix and returns the 5 newest', async () => {
    const events = [{ jti: 'zzzzzzzz…', client_id: 'other' }, { jti: 'abcdefgh…', client_id: 'mine' }, { jti: 'abcdefgh…', client_id: 'older' }, ...EVENTS(4)];
    fetchMock.mockResolvedValue(reply(200, { events }));
    const res = await get(pfAs(goodIdJag({ jti: 'abcdefgh-1234-5678' })));
    expect(res.body.entry.client_id).toBe('mine');
    expect(res.body.recent).toHaveLength(5);
  });

  it('prefers the accepted event over a newer refused replay with the same jti prefix', async () => {
    const events = [{ jti: 'abcdefgh…', decision: 'refused', client_id: 'replay' }, { jti: 'abcdefgh…', decision: 'accepted', client_id: 'first' }];
    fetchMock.mockResolvedValue(reply(200, { events }));
    const res = await get(pfAs(goodIdJag({ jti: 'abcdefgh-1234-5678' })));
    expect(res.body.entry.client_id).toBe('first');
  });

  it('has a null entry when nothing matches or there is no ID-JAG', async () => {
    fetchMock.mockResolvedValue(reply(200, { events: EVENTS() }));
    expect((await get(pfAs(goodIdJag({ jti: 'nomatch-1' })))).body.entry).toBeNull();
    const none = await get(pfAs());
    expect(none.body).toMatchObject({ available: true, entry: null });
    expect(none.body.recent).toHaveLength(5);
  });

  it.each([
    ['a network failure', () => fetchMock.mockRejectedValue(new Error('boom'))],
    ['a timeout', () => fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))],
    ['a non-200', () => fetchMock.mockResolvedValue(reply(502, {}))],
    ['a malformed body', () => fetchMock.mockResolvedValue(reply(200, { nope: true }))],
  ])('answers 200 with a plain reason on %s', async (_n, arrange) => {
    arrange();
    const res = await get(pfAs(goodIdJag()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, entry: null, recent: [], reason: "Could not read the resource AS's record." });
  });
});
