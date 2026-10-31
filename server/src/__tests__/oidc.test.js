import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import * as jose from 'jose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import auth, { authorizeRequest, discover, oidcConfig } from '../auth/oidc.js';
import { getIssuerSubjectToken } from '../issuerSession.js';
import { createApp } from '../app.js';
import { startProvider } from './oidcProvider.js';

const ORIGIN = 'http://localhost:4720';
let provider;
let logs;

beforeAll(async () => { provider = await startProvider(); });
afterAll(() => provider.close());
beforeEach(() => {
  provider.claims = {};
  provider.signWith = provider.privateKey;
  provider.clientPublicKey = null;
  provider.tokenRequests = [];
  vi.stubEnv('APP_ORIGIN', ORIGIN);
  vi.stubEnv('OIDC_ISSUER', provider.issuer);
  vi.stubEnv('OIDC_CLIENT_ID', 'id-jag-app');
  vi.stubEnv('OIDC_CLIENT_SECRET', crypto.randomBytes(16).toString('hex'));
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error']) {
    vi.spyOn(console, level).mockImplementation((...a) => logs.push(a.join(' ')));
  }
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// The same session setup as createApp, plus a probe for the subject-token interface.
function testApp() {
  const app = express();
  app.use(session({ name: 'demo.sid', secret: 'test-session-secret', resave: false, saveUninitialized: false }));
  app.use(auth);
  // Test-only stand-in for the old redirect login: the callback still needs a pending login in the session.
  app.get('/test/login', async (req, res) => {
    const c = oidcConfig();
    const { login, url } = authorizeRequest(c, await discover(c.issuer), req.query.return_to);
    req.session.oidcLogin = login;
    if (req.query.prompt === 'login') url.searchParams.set('prompt', 'login');
    req.session.save(() => res.redirect(url.toString()));
  });
  app.get('/probe/subject', (req, res) => res.json({ subject: getIssuerSubjectToken(req, 'pf-as') }));
  return app;
}

const sid = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('demo.sid='))?.split(';')[0];

/** Run login -> IdP -> callback. Returns the agent, the callback response and both session cookies. */
async function signIn({ returnTo = '/trusted-idps', tamper = (x) => x } = {}) {
  const agent = request.agent(testApp());
  const login = await agent.get(`/test/login?return_to=${encodeURIComponent(returnTo)}`);
  const { code, state, query } = provider.authorize(login.headers.location);
  const cb = await agent.get(`/auth/callback?${new URLSearchParams(tamper({ code, state }))}`);
  return { agent, login, cb, query, before: sid(login), after: sid(cb) };
}

describe('OIDC sign-in', () => {
  it('sends the user to the provider with code + PKCE S256, state, nonce and the default scopes', async () => {
    const { login, query } = await signIn();
    expect(login.status).toBe(302);
    expect(login.headers.location.startsWith(`${provider.issuer}/authorize?`)).toBe(true);
    expect(Object.fromEntries(query)).toEqual(expect.objectContaining({
      response_type: 'code', client_id: 'id-jag-app', redirect_uri: `${ORIGIN}/auth/callback`,
      scope: 'openid profile email offline_access', code_challenge_method: 'S256',
    }));
    expect(query.get('state')).toMatch(/^[\w-]{20,}$/);
    expect(query.get('nonce')).toMatch(/^[\w-]{20,}$/);
    expect(query.get('code_challenge')).toMatch(/^[\w-]{43}$/);
  });

  it('adds OIDC_EXTRA_SCOPES', async () => {
    vi.stubEnv('OIDC_EXTRA_SCOPES', 'groups openid');
    const { query } = await signIn();
    expect(query.get('scope')).toBe('openid profile email offline_access groups');
  });

  it('signs in, regenerates the session, and returns to the asked page', async () => {
    const { agent, cb, before, after } = await signIn();
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/trusted-idps');
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before); // session fixation: a new id after login
    expect((await agent.get('/api/me')).body).toEqual({ email: 'alice@pingidentity.com', name: 'Alice', isAdmin: false });
    // client_secret_basic, PKCE verifier sent
    const tr = provider.tokenRequests[0];
    expect(tr.authorization).toMatch(/^Basic /);
    expect(tr.form.get('code_verifier')).toBeTruthy();
  });

  it('one sign-in at PF_URL with the pf-as exchange client also signs in the pf-as issuer session', async () => {
    vi.stubEnv('PF_URL', provider.issuer);
    vi.stubEnv('PF_EXCHANGE_CLIENT_ID', 'id-jag-app');
    const { agent, cb } = await signIn();
    const probe = await agent.get('/probe/subject');
    expect(probe.body.subject).toBe(provider.refreshToken);
    // never in a browser-facing response or a log line
    const me = await agent.get('/api/me');
    for (const text of [JSON.stringify(cb.headers), cb.text, me.text, logs.join('\n')]) {
      expect(text).not.toContain(provider.refreshToken);
      expect(text).not.toContain('eyJ'); // no JWT (ID token) anywhere
    }
  });

  it('leaves the pf-as issuer session empty when the sign-in used another issuer or client', async () => {
    vi.stubEnv('PF_URL', provider.issuer);
    vi.stubEnv('PF_EXCHANGE_CLIENT_ID', 'some-other-client');
    expect((await (await signIn()).agent.get('/probe/subject')).body.subject).toBeNull();
    vi.stubEnv('PF_URL', 'https://another-pf.example.com');
    vi.stubEnv('PF_EXCHANGE_CLIENT_ID', 'id-jag-app');
    expect((await (await signIn()).agent.get('/probe/subject')).body.subject).toBeNull();
  });

  it('defaults to the pf-as settings (PF_URL, PF_EXCHANGE_CLIENT_ID/_SECRET): one PingFederate client serves both', async () => {
    for (const k of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']) vi.stubEnv(k, '');
    vi.stubEnv('PF_URL', provider.issuer);
    vi.stubEnv('PF_EXCHANGE_CLIENT_ID', 'pf-exchange');
    vi.stubEnv('PF_EXCHANGE_CLIENT_SECRET', crypto.randomBytes(16).toString('hex'));
    const { agent, cb, query } = await signIn();
    expect(query.get('client_id')).toBe('pf-exchange');
    expect(cb.status).toBe(302);
    expect((await agent.get('/probe/subject')).body.subject).toBe(provider.refreshToken);
  });

  it.each([
    ['state mismatch', { tamper: (q) => ({ ...q, state: 'forged' }) }],
    ['missing code', { tamper: ({ state }) => ({ state }) }],
  ])('refuses a callback with %s', async (_n, opts) => {
    const { agent, cb } = await signIn(opts);
    expect(cb.status).toBe(400);
    expect(cb.text).toMatch(/Sign-in failed/);
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('refuses a replayed callback (the login state is single-use)', async () => {
    const agent = request.agent(testApp());
    const login = await agent.get('/test/login');
    const { code, state } = provider.authorize(login.headers.location);
    expect((await agent.get(`/auth/callback?code=${code}&state=${state}`)).status).toBe(302);
    expect((await agent.get(`/auth/callback?code=${code}&state=${state}`)).status).toBe(400);
  });

  it.each([
    ['nonce mismatch', () => { provider.claims = { nonce: 'not-the-one-we-sent' }; }],
    ['bad signature', async () => { provider.signWith = (await jose.generateKeyPair('RS256')).privateKey; }],
    ['wrong audience', () => { provider.claims = { aud: 'someone-else' }; }],
    ['wrong issuer', () => { provider.claims = { iss: 'https://evil.test' }; }],
    ['expired', () => { provider.claims = { exp: Math.floor(Date.now() / 1000) - 600 }; }],
  ])('refuses an ID token with %s', async (_n, setup) => {
    await setup();
    const { agent, cb } = await signIn();
    expect(cb.status).toBe(400);
    expect(cb.text).toMatch(/Sign-in failed/);
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it.each([
    ['outside domain', { email: 'mallory@gmail.com' }, /Only pingidentity\.com, pingone\.com/],
    ['subdomain', { email: 'a@eng.pingidentity.com' }, /Only pingidentity\.com/],
    ['plus address', { email: 'alice+demo@pingidentity.com' }, /Plus-addressed/],
    ['unverified email', { email_verified: false }, /not verified/],
  ])('refuses %s with a branded page and no session', async (_n, claims, why) => {
    provider.claims = claims;
    const { agent, cb } = await signIn();
    expect(cb.status).toBe(403);
    expect(cb.headers['content-type']).toMatch(/text\/html/);
    expect(cb.text).toMatch(why);
    expect(cb.text).toMatch(/Ping Identity/);
    expect(cb.text).not.toContain('eyJ');
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('grants admin from the group claim (configurable name and value)', async () => {
    provider.claims = { groups: ['staff', 'demo-admins'] };
    expect((await (await signIn()).agent.get('/api/me')).body.isAdmin).toBe(true);
    vi.stubEnv('ADMIN_CLAIM', 'roles');
    vi.stubEnv('ADMIN_CLAIM_VALUE', 'kit-admin');
    provider.claims = { roles: 'kit-admin' };
    expect((await (await signIn()).agent.get('/api/me')).body.isAdmin).toBe(true);
    provider.claims = { groups: ['demo-admins'] };
    expect((await (await signIn()).agent.get('/api/me')).body.isAdmin).toBe(false);
  });

  it('grants admin from ADMIN_EMAILS, which never bypasses the email rules', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'Alice@PingIdentity.com, mallory+x@pingidentity.com');
    expect((await (await signIn()).agent.get('/api/me')).body.isAdmin).toBe(true);
    provider.claims = { email: 'mallory+x@pingidentity.com' };
    expect((await signIn()).cb.status).toBe(403);
  });

  it.each(['//evil.test/x', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)', '/ok path'])('ignores an unsafe return_to %s', async (returnTo) => {
    expect((await signIn({ returnTo })).cb.headers.location).toBe('/');
  });

  it('shows the provider error page when the IdP sends error=access_denied', async () => {
    const agent = request.agent(testApp());
    await agent.get('/test/login');
    const res = await agent.get('/auth/callback?error=access_denied&error_description=%3Cscript%3E');
    expect(res.status).toBe(400);
    expect(res.text).toContain('access_denied');
    expect(res.text).not.toContain('<script>');
  });

  it('supports private_key_jwt client authentication', async () => {
    const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true });
    provider.clientPublicKey = publicKey;
    vi.stubEnv('OIDC_CLIENT_SECRET', '');
    vi.stubEnv('OIDC_PRIVATE_KEY_JWT', await jose.exportPKCS8(privateKey));
    const { cb } = await signIn();
    expect(cb.status).toBe(302);
    const tr = provider.tokenRequests[0];
    expect(tr.authorization).toBeUndefined();
    expect(tr.form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  });

  it('logout needs a same-origin POST, then the session is gone', async () => {
    const { agent } = await signIn();
    expect((await agent.post('/auth/logout')).status).toBe(403);
    expect((await agent.get('/api/me')).status).toBe(200);
    const out = await agent.post('/auth/logout').set('Origin', ORIGIN);
    expect(out.status).toBe(303);
    expect((await agent.get('/api/me')).status).toBe(401);
    expect((await agent.get('/probe/subject')).body.subject).toBeNull();
  });

  it('answers 503 not_configured from the pi.flow start when OIDC is not configured', async () => {
    vi.stubEnv('OIDC_CLIENT_ID', '');
    vi.stubEnv('PF_EXCHANGE_CLIENT_ID', '');
    const res = await request(createApp()).get('/auth/pi-flow/start');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_configured');
  });
});

describe('createApp', () => {
  it('mounts sign-in and /api/me', async () => {
    vi.stubEnv('WEB_DIST', '/nonexistent/web-dist'); // a built web/dist would answer unknown paths with the SPA
    const app = createApp();
    expect((await request(app).get('/api/me')).status).toBe(401);
    expect((await request(app).get(`/auth/${'log'}in`)).status).toBe(404); // no redirect sign-in exists
  });
});
