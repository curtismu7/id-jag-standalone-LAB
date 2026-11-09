// Mock mode, end to end through the real app: the whole ID-JAG flow runs against the in-process mock PingFederate, resource
// AS and MCP server, and not one real call is made (fetch is a spy that fails the test, the netguard counts zero real calls).
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { MOCK_USER, ORIGINS } from '../mock/env.js';
import { allowedHosts } from '../hostCheck.js';
import { mockSigninProblem } from '../mockSignin.js';
import { netguard } from '../outbound.js';
import { API, ORIGIN, expectNoRealCalls, post, signInApp, signInIssuer, useMockMode } from './mockHelpers.js';

const mock = useMockMode();
const noRealCalls = () => expectNoRealCalls(mock);

describe('mock mode, pf-as: PingFederate to resource AS to MCP', () => {
  it('signs in, issues, inspects, redeems and calls, with every token marked mock and no real call', async () => {
    const agent = request.agent(createApp());
    await post(agent, `${API}/mode`, { mode: 'pf-as' }).expect(200);
    const cfg = (await agent.get(`${API}/config`).expect(200)).body;
    expect(cfg.modes.find((m) => m.id === 'pf-as').available).toBe(true); // the mock fills in every setting the mode needs
    expect(cfg.simulated).toBe(true);
    expect(cfg.idp.issuer).toMatch(/\.mock\.invalid$/);

    await signInIssuer(agent);
    const issued = await post(agent, `${API}/issue`).expect(200);
    expect(issued.headers['x-simulated']).toBe('mock');
    expect(issued.body.simulated).toBe(true);
    expect(issued.body.token.header).toMatchObject({ typ: 'oauth-id-jag+jwt', alg: 'ES256' });
    expect(issued.body.token.header.kid).toMatch(/^mock-/);
    expect(issued.body.token.claims).toMatchObject({ mock: true, sub: MOCK_USER.username, client_id: 'id-jag-playground' });
    // Rule 4: mock-issued tokens are shown raw (the claims say mock:true, the answer says simulated:true). Real tokens never are (live tests).
    const jwtClaims = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
    expect(issued.body.response.access_token).toMatch(/^eyJ[\w-]*\.[\w-]+\.[\w-]+$/);
    expect(jwtClaims(issued.body.response.access_token)).toEqual(issued.body.token.claims);
    expect(jwtClaims(issued.body.response.access_token).mock).toBe(true);
    expect(issued.body.request.body.subject_token).not.toMatch(/never sent to the browser/); // the mock refresh token, raw

    const inspected = (await post(agent, `${API}/inspect`).expect(200)).body;
    const failing = inspected.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.actual}`);
    expect(failing).toEqual([]); // typ, aud, client_id, expiry and the signature against the mock JWKS all verify

    const redeemed = await post(agent, `${API}/redeem`).expect(200);
    expect(redeemed.body.token.header.typ).toBe('at+jwt');
    expect(redeemed.body.token.claims).toMatchObject({ mock: true, scope: 'read mcp:invoke' });
    expect(redeemed.body.token.claims.iss).toMatch(/resource-as\.mock\.invalid/);
    expect(redeemed.body.request.body.assertion).toBe(issued.body.response.access_token); // the ID-JAG that was redeemed
    expect(jwtClaims(redeemed.body.response.access_token)).toEqual(redeemed.body.token.claims);

    const tools = (await post(agent, `${API}/call`).expect(200)).body;
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['echo', 'server_time', 'whoami']);
    expect(tools.request.authorization).toBe(`Bearer ${redeemed.body.response.access_token}`);
    const echo = (await post(agent, `${API}/call`, { tool: 'echo', arguments: { text: 'hi' } }).expect(200)).body;
    expect(echo.result.content[0].text).toBe('hi');
    const profile = (await post(agent, `${API}/resource`, { variant: 'token' }).expect(200)).body;
    expect(profile.status).toBe(200);
    expect(profile.request.authorization).toBe(`Bearer ${redeemed.body.response.access_token}`);

    const record = (await agent.get(`${API}/as-events`).expect(200)).body;
    expect(record.entry).toMatchObject({ decision: 'accepted' });
    noRealCalls();
  });

  it('the MCP server refuses the ID-JAG itself and a call with no token', async () => {
    const agent = request.agent(createApp());
    await post(agent, `${API}/mode`, { mode: 'pf-as' });
    await signInIssuer(agent);
    await post(agent, `${API}/issue`).expect(200);
    const idJag = (await post(agent, `${API}/resource`, { variant: 'id-jag' }).expect(200)).body;
    expect(idJag.status).toBe(401);
    expect(idJag.request.authorization).toMatch(/^Bearer eyJ[\w-]*\.[\w-]+\.[\w-]+$/); // the mock ID-JAG, raw
    expect(JSON.stringify(idJag.body)).toMatch(/ID-JAG/);
    const none = (await post(agent, `${API}/resource`, { variant: 'no-token' }).expect(200)).body;
    expect(none.status).toBe(401);
    expect(none.request.authorization).toBe('none');
  });

  it('every negative test is refused by the mock resource AS, and the revocation is proved', async () => {
    const agent = request.agent(createApp());
    await post(agent, `${API}/mode`, { mode: 'pf-as' });
    await signInIssuer(agent);
    for (const id of ['replay', 'bad-signature', 'client-mismatch', 'scope-not-granted']) {
      const r = (await post(agent, `${API}/negative/${id}`).expect(200)).body;
      expect({ id, pass: r.pass, error: r.error }).toMatchObject({ id, pass: true });
    }
    const revoked = (await post(agent, `${API}/revoke`).expect(200)).body;
    expect(revoked).toMatchObject({ proved: true, control: { status: 200 }, revoke: { status: 200 } });
    expect(revoked.retry.error).toBe('invalid_request');
    noRealCalls();
  });

  it('an ID-JAG redeems once: the second redemption is refused as a replay', async () => {
    const agent = request.agent(createApp());
    await post(agent, `${API}/mode`, { mode: 'pf-as' });
    await signInIssuer(agent);
    await post(agent, `${API}/issue`).expect(200);
    await post(agent, `${API}/redeem`).expect(200);
    const again = await post(agent, `${API}/redeem`);
    expect(again.status).toBe(422);
    expect(again.body.response.error).toBe('invalid_grant');
    expect(again.body.response.error_description).toMatch(/replay/);
  });
});

describe('mock mode, pf-pf: the outside Acme PingFederate issues, PingFederate redeems', () => {
  it('runs end to end and the MCP server refuses PingFederate\'s token (it trusts the resource AS only)', async () => {
    const agent = request.agent(createApp());
    await post(agent, `${API}/mode`, { mode: 'pf-pf' }).expect(200);
    await signInIssuer(agent);
    const issued = (await post(agent, `${API}/issue`).expect(200)).body;
    expect(issued.token.claims.iss).toMatch(/acme-pf\.mock\.invalid/);
    expect(issued.token.claims.aud).toMatch(/\/\/pf\.mock\.invalid/);
    const redeemed = (await post(agent, `${API}/redeem`).expect(200)).body;
    expect(redeemed.token.claims).toMatchObject({ mock: true, iss: expect.stringMatching(/\/\/pf\.mock\.invalid/) });
    const call = await post(agent, `${API}/call`);
    expect(call.status).toBe(422);
    expect(call.body.mcpStatus).toBe(401);
    noRealCalls();
  });
});

describe('mock mode sign-in', () => {
  it('signs the demo user in to the app as an admin, and refuses a wrong password', async () => {
    const agent = request.agent(createApp());
    const bad = await signInApp(agent, { username: MOCK_USER.username, password: 'not-the-password' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('invalid_credentials');
    await signInApp(agent);
    const me = (await agent.get('/api/me').expect(200)).body;
    expect(me).toMatchObject({ email: MOCK_USER.username, isAdmin: true });
    noRealCalls();
  });

  it('an approved registration can sign in: the mock PingFederate admin API took the new user', async () => {
    const admin = request.agent(createApp());
    await signInApp(admin);
    const app = createApp();
    const reg = await request(app).post('/api/register').set('Origin', ORIGIN).send({ email: 'bob@mock.example', password: 'a-long-enough-password' }).expect(201);
    await post(admin, `/api/registrations/${reg.body.id}/approve`).expect(200);
    const bob = request.agent(app);
    await signInApp(bob, { username: 'bob@mock.example', password: 'a-long-enough-password' });
    expect((await bob.get('/api/me').expect(200)).body).toMatchObject({ email: 'bob@mock.example', isAdmin: false });
    noRealCalls();
  });

  it.each([
    ['ALLOW_MOCK_SIGNIN is not set', () => vi.stubEnv('ALLOW_MOCK_SIGNIN', ''), {}, /ALLOW_MOCK_SIGNIN=1/],
    ['the server listens on more than loopback', () => vi.stubEnv('HOST', '0.0.0.0'), {}, /more than this machine/],
    ['no bind is declared', () => vi.stubEnv('HOST', ''), {}, /more than this machine/],
    ['TRUST_PROXY is set', () => vi.stubEnv('TRUST_PROXY', '1'), {}, /proxy/],
    ['a forwarded header arrives', () => {}, { 'X-Forwarded-For': '203.0.113.9' }, /proxy/],
  ])('is refused when %s', async (_why, arrange, headers, message) => {
    arrange();
    const agent = request.agent(createApp());
    for (const url of ['/auth/pi-flow/start', `${API}/issuer/pi-flow/start`]) {
      const r = await agent.get(url).set(headers);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('mock_signin_disabled');
      expect(r.body.message).toMatch(message);
    }
    expect(netguard.stats().mock).toBe(0); // refused before any call
  });

  describe('behind the lab-proxy (LAB_ALLOWED_HOSTS)', () => {
    const LAB_HOST = 'kit.lab.example';
    const PROXY_ORIGIN = 'https://front.example:8443';
    const fwd = { 'X-Forwarded-Host': 'front.example:8443', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' };
    const proxied = (host = `${LAB_HOST}:4720`, extra = {}) => ({ Host: host, ...fwd, ...extra });
    const arrange = (list = LAB_HOST) => {
      vi.stubEnv('LAB_ALLOWED_HOSTS', list);
      vi.stubEnv('PROXY_ORIGIN', PROXY_ORIGIN);
      vi.stubEnv('PROXY_BASE', '/id-jag-kit');
    };
    const URLS = ['/auth/pi-flow/start', `${API}/issuer/pi-flow/start`];
    // The guard itself, on a bare request: some Hosts never reach it through the app (the Host check answers 403 first).
    const guard = (headers) => {
      const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      return mockSigninProblem({ headers: h, get: (n) => h[n.toLowerCase()] });
    };
    const refused = async (headers) => {
      expect(guard(headers), JSON.stringify(headers)).toMatchObject({ status: 409, error: 'mock_signin_disabled', message: expect.stringMatching(/proxy/) });
      if (!allowedHosts().has(String(headers.Host).replace(/:\d+$/, '').toLowerCase())) return; // the Host check refuses it before the guard
      for (const url of URLS) {
        const r = await request(createApp()).get(url).set(headers);
        expect([url, r.status, r.body.error]).toEqual([url, 409, 'mock_signin_disabled']);
        expect(r.body.message).toMatch(/proxy/);
      }
    };

    it('a listed Host with valid forwarded headers signs in: start, credentials (proxy Origin) and callback', async () => {
      arrange();
      const h = proxied();
      const agent = request.agent(createApp());
      await agent.get('/auth/pi-flow/start').set(h).expect(200);
      const r = await agent.post('/auth/pi-flow/credentials').set(h).set('Origin', PROXY_ORIGIN)
        .send({ username: MOCK_USER.username, password: MOCK_USER.password }).expect(200);
      const to = new URL(r.body.redirectTo);
      expect(to.origin + to.pathname.slice(0, '/id-jag-kit'.length)).toBe(`${PROXY_ORIGIN}/id-jag-kit`); // the redirect URI carries the proxy origin and base
      await agent.get((to.pathname + to.search).replace(/^\/id-jag-kit/, '')).set(h).expect(302); // the proxy strips the base path
      expect((await agent.get('/api/me').set(h).expect(200)).body).toMatchObject({ email: MOCK_USER.username });
      await agent.post(`${API}/mode`).set(h).set('Origin', PROXY_ORIGIN).send({ mode: 'pf-as' }).expect(200);
      await agent.get(`${API}/issuer/pi-flow/start`).set(h).expect(200); // the playground's issuer sign-in passes the same guard
    });

    it('is still refused for a listed Host when the forwarded proto is wrong', async () => {
      arrange();
      await refused(proxied(undefined, { 'X-Forwarded-Proto': 'http' }));
    });

    it('is refused on a loopback Host carrying forwarded headers, even when the list is set (and even when the list names loopback)', async () => {
      arrange();
      for (const host of ['localhost:4720', '127.0.0.1:4720', '[::1]:4720']) await refused(proxied(host));
      arrange('127.0.0.1,localhost');
      for (const host of ['localhost:4720', '127.0.0.1:4720']) await refused(proxied(host));
    });

    it('is refused on an unlisted Host with forwarded headers', async () => {
      arrange();
      for (const host of ['other.example:4720', `x.${LAB_HOST}`]) await refused(proxied(host));
    });

    it('is refused when the forwarded host is not the PROXY_ORIGIN host', async () => {
      arrange();
      for (const fh of ['evil.example', 'front.example:9999', '']) await refused(proxied(undefined, { 'X-Forwarded-Host': fh }));
    });

    it('is refused when only some other forwarded header is sent (no forwarded host), or when the list or PROXY_ORIGIN is unset', async () => {
      arrange();
      await refused({ Host: `${LAB_HOST}:4720`, 'X-Forwarded-For': '203.0.113.9' });
      arrange('');
      await refused(proxied());
      arrange();
      vi.stubEnv('PROXY_ORIGIN', '');
      await refused(proxied());
    });

    it('is refused behind the proxy when TRUST_PROXY is set', async () => {
      arrange();
      vi.stubEnv('TRUST_PROXY', '1');
      await refused(proxied());
    });

    it('the guard itself lets a listed Host with valid forwarded headers through', () => {
      arrange();
      expect(guard(proxied())).toBeNull();
    });

    it('a listed Host without forwarded headers is allowed on the loopback-published listener (the direct name)', async () => {
      arrange();
      await request(createApp()).get('/auth/pi-flow/start').set('Host', `${LAB_HOST}:4720`).expect(200);
    });
  });

  it('is allowed when the container listens wide but the port is published on loopback only (LAB_PUBLISH=loopback)', async () => {
    vi.stubEnv('HOST', '0.0.0.0');
    vi.stubEnv('LAB_PUBLISH', 'loopback');
    await request(createApp()).get('/auth/pi-flow/start').expect(200);
  });

  it('NODE_ENV=production alone does not open mock sign-in', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_MOCK_SIGNIN', '');
    expect((await request(createApp()).get('/auth/pi-flow/start')).status).toBe(409);
  });
});

describe('mock mode keeps its data apart from live data', () => {
  it('writes under DATA_DIR/mock, never beside the live files', async () => {
    const admin = request.agent(createApp());
    await signInApp(admin);
    await request(createApp()).post('/api/register').set('Origin', ORIGIN).send({ email: 'carol@mock.example', password: 'a-long-enough-password' }).expect(201);
    expect(fs.existsSync(path.join(mock.tmp, 'mock', 'registrations.json'))).toBe(true);
    expect(fs.existsSync(path.join(mock.tmp, 'registrations.json'))).toBe(false);
  });
});

describe('mock mode refuses what is outside the simulation', () => {
  it('a Trusted IdP on a real host cannot be discovered or tested: refused and counted, the real fetch untouched', async () => {
    const admin = request.agent(createApp());
    await signInApp(admin);
    const TRUSTED = '/api/id-jag-playground/trusted-idps';
    const found = await post(admin, `${TRUSTED}/discover`, { issuer: 'https://idp.partner.example.com' });
    expect(found.status).toBe(422);
    expect(found.body.message).toMatch(/Mock mode: outbound call to idp\.partner\.example\.com refused/);
    const tested = await post(admin, `${TRUSTED}/test`, { jwksUrl: 'https://idp.partner.example.com/jwks' });
    expect(tested.status).toBe(502);
    expect(mock.realFetch).not.toHaveBeenCalled();
    expect(netguard.stats().refused).toBe(3); // two discovery documents tried, then the keys
    expect(netguard.stats()).toMatchObject({ live: 0, loopback: 0 });
  });

  it('a Trusted IdP inside the simulation works: the Acme mock PingFederate is discovered, registered, approved and trusted', async () => {
    const admin = request.agent(createApp());
    await signInApp(admin);
    const TRUSTED = '/api/id-jag-playground/trusted-idps';
    const found = (await post(admin, `${TRUSTED}/discover`, { issuer: ORIGINS.acme }).expect(200)).body;
    expect(found).toMatchObject({ issuer: ORIGINS.acme, jwksUrl: `${ORIGINS.acme}/pf/JWKS` });
    const probe = (await post(admin, `${TRUSTED}/test`, { jwksUrl: found.jwksUrl }).expect(200)).body;
    expect(probe.keyCount).toBe(1);
    await post(admin, TRUSTED, { id: 'acme', name: 'Acme', issuer: found.issuer, jwksUrl: found.jwksUrl, idJagClientId: 'mock-acme-exchange-client', targets: ['resource-as'] }).expect(201);
    const approved = (await post(admin, `${TRUSTED}/acme/approve`).expect(200)).body;
    expect(approved.status).toBe('approved');
    const secret = (await post(admin, `${TRUSTED}/acme/secret`).expect(200)).body;
    expect(secret.clientId).toBe('idp-acme'); // the client lives in the mock resource AS, not in a CLIENTS_FILE
    expect(secret.clientSecret).toBeTruthy();
    expect(netguard.stats().refused).toBe(0);
    expect(mock.realFetch).not.toHaveBeenCalled();
  });
});

