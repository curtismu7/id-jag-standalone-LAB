// xaa.dev's IdenX as a real outside IdP for the byo mode: sign-in (code + PKCE + nonce) -> RFC 8693 ID-JAG
// exchange at IdenX -> the byo inspect path -> redeem at resource-as as the IdenX entry's idp-<id> client.
// Tokens and secrets stay server-side.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { SignJWT, exportJWK } from 'jose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import router, { _clearProbeCache } from '../idJagPlayground.js';

const ORIGIN = 'https://app.test';
const IDENX = 'https://idp.xaa.dev';
const AS = 'https://as.test';
const AS_TOKEN = 'http://resource-as:9080/token';
const RESOURCE = 'https://mcp.test/mcp';
const DISCOVERY = { issuer: IDENX, authorization_endpoint: `${IDENX}/authorize`, token_endpoint: `${IDENX}/token`, jwks_uri: `${IDENX}/jwks` };
const ENV = {
  APP_ORIGIN: ORIGIN, RESOURCE_AS_ISSUER: AS, RESOURCE_AS_TOKEN_ENDPOINT: AS_TOKEN, ID_JAG_RESOURCE: RESOURCE,
  XAA_DEV_IDP_CLIENT_ID: 'idenx-app', XAA_DEV_IDP_CLIENT_SECRET: 'idenx-app-secret',
  XAA_DEV_RESOURCE_AS_CLIENT_ID: 'idp-xaa-dev', XAA_DEV_RESOURCE_AS_CLIENT_SECRET: 'xaa-as-secret',
};
// As approved on the Trusted IdPs page (owner fetched the idp-xaa-dev secret once and set it in env).
const ENTRY = {
  id: 'xaa-dev', name: 'xaa.dev IdenX', product: 'generic', issuer: IDENX, jwksUrl: `${IDENX}/jwks`, idJagClientId: 'idp-xaa-dev',
  clientId: 'idp-xaa-dev', pfClientId: 'id-jag-redeemer', scopes: 'read', targets: ['resource-as'], status: 'approved', owner: 'olivia@pingidentity.com',
};

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { keys: [{ ...(await exportJWK(publicKey)), kid: 'idenx-1', alg: 'RS256', use: 'sig' }] };
const now = () => Math.floor(Date.now() / 1000);
const sign = (claims, typ = 'JWT') => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'idenx-1', typ }).sign(privateKey);
const idToken = (over = {}) => sign({ iss: IDENX, aud: 'idenx-app', sub: 'idenx-user-1', email: 'alice@example.com', nonce: 'n-1', iat: now(), exp: now() + 300, ...over });
// IdenX writes the Target Client ID registered at xaa.dev, and the resource with a trailing slash.
const xaaIdJag = (over = {}) => sign({ iss: IDENX, sub: 'idenx-user-1', aud: AS, client_id: 'idp-xaa-dev', jti: crypto.randomUUID(),
  iat: now(), exp: now() + 300, resource: `${RESOURCE}/`, scope: 'read', ...over }, 'oauth-id-jag+jwt');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const accessToken = `${b64({ alg: 'RS256' })}.${b64({ iss: AS, sub: 'idenx-user-1', scope: 'read' })}.c2ln`;

const reply = (status, data) => ({ status, json: async () => data, headers: new Headers() });
let fetchMock;
let idenxToken; // what IdenX's token endpoint answers next
let asToken; // what resource-as's token endpoint answers next
const calls = (url) => fetchMock.mock.calls.filter(([u]) => String(u) === url);
const form = (call) => Object.fromEntries(new URLSearchParams(call[1].body));

const seed = (...entries) => fs.writeFileSync(path.join(process.env.DATA_DIR, 'trusted-idps.json'), JSON.stringify(entries));
function appWith(session) {
  const app = express();
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/pg', router);
  return app;
}
const byoSession = (extra = {}) => ({ idJagPlaygroundMode: 'byo', save: (cb) => cb(), ...extra });
const signedIn = (tokens = { refreshToken: 'idenx-rt', idToken: 'idenx-idt' }) => byoSession({ idJagXaa: { ...tokens, sub: 'idenx-user-1', email: 'alice@example.com' } });
const pending = () => ({ state: 's-1', nonce: 'n-1', verifier: 'v-1', returnTo: '/', at: Date.now() });
const post = (app, p, body) => request(app).post(p).set('Origin', ORIGIN).send(body || {});

beforeEach(() => {
  vi.stubEnv('DATA_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-xaa-')));
  Object.entries(ENV).forEach(([k, v]) => vi.stubEnv(k, v));
  seed(ENTRY);
  idenxToken = reply(500, {});
  asToken = reply(500, {});
  fetchMock = vi.fn(async (url) => {
    const u = String(url);
    if (u === `${IDENX}/.well-known/openid-configuration`) return reply(200, DISCOVERY);
    if (u === `${IDENX}/jwks`) return reply(200, JWKS);
    if (u === `${IDENX}/token`) return idenxToken;
    if (u === AS_TOKEN) return asToken;
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  _clearProbeCache();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('sign-in at IdenX', () => {
  it('login redirects to IdenX (from discovery) with PKCE S256, state, nonce and offline_access; the verifier stays here', async () => {
    const session = byoSession();
    const res = await request(appWith(session)).get('/pg/xaa/login?return_to=/');
    expect(res.status).toBe(302);
    const to = new URL(res.headers.location);
    expect(to.origin + to.pathname).toBe(`${IDENX}/authorize`);
    const q = Object.fromEntries(to.searchParams);
    expect(q).toEqual(expect.objectContaining({
      response_type: 'code', client_id: 'idenx-app', redirect_uri: `${ORIGIN}/api/id-jag-playground/xaa/callback`,
      scope: 'openid profile email offline_access', prompt: 'consent', code_challenge_method: 'S256',
    }));
    const p = session.idJagXaaLogin;
    expect([q.state, q.nonce]).toEqual([p.state, p.nonce]);
    expect(q.code_challenge).toBe(crypto.createHash('sha256').update(p.verifier).digest('base64url'));
    expect(res.headers.location).not.toContain(p.verifier);
    expect(res.headers.location).not.toContain('idenx-app-secret');
  });

  it('callback swaps the code (PKCE verifier, client_secret_post), verifies the id_token and keeps the tokens in the session', async () => {
    const session = byoSession({ idJagXaaLogin: pending() });
    idenxToken = reply(200, { id_token: await idToken(), refresh_token: 'idenx-rt', access_token: 'idenx-at' });
    const res = await request(appWith(session)).get('/pg/xaa/callback?code=c-1&state=s-1');
    expect(res.headers.location).toBe('/?xaa=signed_in');
    expect(form(calls(`${IDENX}/token`)[0])).toEqual({
      grant_type: 'authorization_code', code: 'c-1', redirect_uri: `${ORIGIN}/api/id-jag-playground/xaa/callback`,
      code_verifier: 'v-1', client_id: 'idenx-app', client_secret: 'idenx-app-secret',
    });
    expect(session.idJagXaa).toEqual(expect.objectContaining({ refreshToken: 'idenx-rt', sub: 'idenx-user-1', email: 'alice@example.com' }));
    expect(session.idJagXaaLogin).toBeUndefined();
  });

  it('callback with the wrong state is refused before any token call', async () => {
    const session = byoSession({ idJagXaaLogin: pending() });
    const res = await request(appWith(session)).get('/pg/xaa/callback?code=c-1&state=evil');
    expect(res.headers.location).toBe('/?xaa_error=invalid_state');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.idJagXaa).toBeUndefined();
  });

  it.each([
    ['a nonce mismatch', { nonce: 'other' }],
    ['another audience', { aud: 'someone-else' }],
    ['another issuer', { iss: 'https://evil.test' }],
  ])('callback refuses an id_token with %s', async (_n, over) => {
    const session = byoSession({ idJagXaaLogin: pending() });
    idenxToken = reply(200, { id_token: await idToken(over), refresh_token: 'idenx-rt' });
    const res = await request(appWith(session)).get('/pg/xaa/callback?code=c-1&state=s-1');
    expect(res.headers.location).toBe('/?xaa_error=invalid_id_token');
    expect(session.idJagXaa).toBeUndefined();
  });
});

describe('ID-JAG from IdenX', () => {
  it('asks IdenX for an ID-JAG for our public issuer, then loads it like a pasted one (decoded claims only)', async () => {
    const session = signedIn();
    const idJag = await xaaIdJag();
    idenxToken = reply(200, { access_token: idJag, issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag', token_type: 'N_A' });
    const res = await post(appWith(session), '/pg/xaa/id-jag');
    expect(res.status).toBe(200);
    expect(form(calls(`${IDENX}/token`)[0])).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
      subject_token: 'idenx-rt', subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
      audience: AS, resource: RESOURCE, scope: 'read', client_id: 'idenx-app', client_secret: 'idenx-app-secret',
    });
    expect(res.body).toEqual(expect.objectContaining({ trusted: true, idp: { id: 'xaa-dev', name: 'xaa.dev IdenX' } }));
    expect(res.body.claims).toEqual(expect.objectContaining({ iss: IDENX, client_id: 'idp-xaa-dev', scope: 'read' }));
    const byId = Object.fromEntries(res.body.checks.map((c) => [c.id, c]));
    for (const id of ['iss', 'aud', 'client_id', 'resource', 'signature']) expect(byId[id].status, id).toBe('pass');
    expect(res.body.request.body.subject_token).toMatch(/kept server-side/);
    expect(session.idJagPlayground).toEqual(expect.objectContaining({ idJag, redeemed: false, byo: { target: 'resource-as', idpId: 'xaa-dev' } }));
    const text = JSON.stringify(res.body);
    for (const s of [idJag, 'idenx-rt', 'idenx-idt', 'idenx-app-secret', 'xaa-as-secret']) expect(text).not.toContain(s);
  });

  it('falls back to the id_token when IdenX gave no refresh token', async () => {
    idenxToken = reply(200, { access_token: await xaaIdJag() });
    await post(appWith(signedIn({ refreshToken: null, idToken: 'idenx-idt' })), '/pg/xaa/id-jag');
    const f = form(calls(`${IDENX}/token`)[0]);
    expect([f.subject_token, f.subject_token_type]).toEqual(['idenx-idt', 'urn:ietf:params:oauth:token-type:id_token']);
  });

  it('needs an IdenX sign-in first, and byo mode', async () => {
    const res = await post(appWith(byoSession()), '/pg/xaa/id-jag');
    expect([res.status, res.body.error]).toEqual([409, 'xaa_sign_in_required']);
    const other = await post(appWith({ ...signedIn(), idJagPlaygroundMode: 'pf-as' }), '/pg/xaa/id-jag');
    expect([other.status, other.body.error]).toEqual([409, 'not_byo_mode']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refused refresh token ends the IdenX session, so the next click signs in again', async () => {
    const session = signedIn();
    idenxToken = reply(400, { error: 'invalid_grant', error_description: 'grant request is invalid' });
    const res = await post(appWith(session), '/pg/xaa/id-jag');
    expect(res.status).toBe(502);
    expect(res.body).toEqual(expect.objectContaining({ error: 'xaa_exchange_failed', idpError: 'invalid_grant' }));
    expect(session.idJagXaa).toBeUndefined();
  });

  it('redeems at resource-as as the entry\'s idp-<id> client with XAA_DEV_RESOURCE_AS_CLIENT_SECRET', async () => {
    const session = signedIn();
    idenxToken = reply(200, { access_token: await xaaIdJag() });
    await post(appWith(session), '/pg/xaa/id-jag');
    asToken = reply(200, { access_token: accessToken, token_type: 'Bearer', scope: 'read' });
    const red = await post(appWith(session), '/pg/redeem', {});
    expect(red.status).toBe(200);
    const [call] = calls(AS_TOKEN);
    expect(form(call).client_id).toBe('idp-xaa-dev');
    expect(call[1].headers.Authorization).toBe(`Basic ${Buffer.from('idp-xaa-dev:xaa-as-secret').toString('base64')}`);
    expect(JSON.stringify(red.body)).not.toContain('xaa-as-secret');
    expect(session.idJagPlayground.accessToken).toBe(accessToken);
  });

  it('never sends the xaa secret for a client the env does not name', async () => {
    seed({ ...ENTRY, clientId: 'idp-someone-else' });
    const session = signedIn();
    session.idJagPlayground = { idJag: await xaaIdJag(), redeemed: false, byo: { target: 'resource-as', idpId: 'xaa-dev' } };
    vi.stubEnv('RESOURCE_AS_CLIENT_SECRET', 'redeem-secret');
    asToken = reply(401, { error: 'invalid_client' });
    await post(appWith(session), '/pg/redeem', {});
    const [call] = calls(AS_TOKEN);
    expect(call[1].body).not.toMatch(/client_secret|xaa-as-secret/);
    expect(call[1].headers.Authorization).toBeUndefined();
  });
});

describe('availability', () => {
  it('is offered in /config when everything is set and the resource-as issuer is https', async () => {
    const res = await request(appWith(signedIn())).get('/pg/config');
    expect(res.body.xaa).toEqual({ available: true, reason: null, signedIn: true, user: 'alice@example.com' });
  });

  it('is unavailable on an http issuer (local runs), with the reason, and refuses login and exchange', async () => {
    vi.stubEnv('RESOURCE_AS_ISSUER', 'http://localhost:4721');
    const session = signedIn();
    const cfg = await request(appWith(session)).get('/pg/config');
    expect(cfg.body.xaa).toEqual(expect.objectContaining({ available: false, reason: expect.stringMatching(/public https issuer.*host this app/i) }));
    expect((await request(appWith(session)).get('/pg/xaa/login?return_to=/')).headers.location).toBe('/?xaa_error=unavailable');
    const ex = await post(appWith(session), '/pg/xaa/id-jag');
    expect([ex.status, ex.body.error]).toEqual([409, 'xaa_unavailable']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['XAA_DEV_IDP_CLIENT_SECRET', 'XAA_DEV_RESOURCE_AS_CLIENT_ID'])('is unavailable without %s, naming it', async (k) => {
    vi.stubEnv(k, '');
    const res = await request(appWith(byoSession())).get('/pg/config');
    expect(res.body.xaa).toEqual(expect.objectContaining({ available: false, reason: expect.stringContaining(k) }));
  });

  it('preflight: IdenX reachable, the IdenX entry approved for resource-as, our client configured', async () => {
    const run = () => request(appWith(byoSession())).get(`/pg/preflight?${new URLSearchParams({ step: 'xaa', mode: 'byo', origin: ORIGIN })}`);
    const ok = await run();
    expect(ok.body.ok).toBe(true);
    expect(ok.body.checks.map((c) => [c.id, c.status])).toEqual(expect.arrayContaining([
      ['xaa-available', 'pass'], ['idenx', 'pass'], ['xaa-trusted-idp', 'pass'], ['xaa-client', 'pass'],
    ]));

    _clearProbeCache();
    seed({ ...ENTRY, status: 'pending' });
    vi.stubEnv('XAA_DEV_RESOURCE_AS_CLIENT_ID', 'idp-other');
    fetchMock.mockImplementation(async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
    const bad = await run();
    expect(bad.body.ok).toBe(false);
    const byId = Object.fromEntries(bad.body.checks.map((c) => [c.id, c]));
    expect(byId.idenx.status).toBe('fail');
    expect(byId['xaa-trusted-idp']).toEqual(expect.objectContaining({ status: 'fail', detail: expect.stringMatching(/pending/) }));
    expect(byId['xaa-client']).toEqual(expect.objectContaining({ status: 'fail', fix: expect.stringMatching(/XAA_DEV_RESOURCE_AS_CLIENT_ID=idp-xaa-dev/) }));
    expect(JSON.stringify(bad.body)).not.toMatch(/idenx-app-secret|xaa-as-secret/);
  });

  it('byo issue preflight counts approved registry entries', async () => {
    const res = await request(appWith(byoSession())).get(`/pg/preflight?${new URLSearchParams({ step: 'issue', mode: 'byo', origin: ORIGIN })}`);
    expect(res.body.checks.find((c) => c.id === 'trusted-idp')).toEqual(expect.objectContaining({ status: 'pass' }));
  });
});
