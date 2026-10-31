// Mock mode, end to end through the real app: the whole ID-JAG flow runs against the in-process mock PingFederate, resource
// AS and MCP server, and not one real call is made (fetch is a spy that fails the test, the netguard counts zero real calls).
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { MOCK_USER, ORIGINS } from '../mock/env.js';
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
    expect(JSON.stringify(issued.body)).not.toMatch(/eyJ[\w-]*\.[\w-]+\.[\w-]+/); // raw tokens stay in the session

    const inspected = (await post(agent, `${API}/inspect`).expect(200)).body;
    const failing = inspected.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.actual}`);
    expect(failing).toEqual([]); // typ, aud, client_id, expiry and the signature against the mock JWKS all verify

    const redeemed = await post(agent, `${API}/redeem`).expect(200);
    expect(redeemed.body.token.header.typ).toBe('at+jwt');
    expect(redeemed.body.token.claims).toMatchObject({ mock: true, scope: 'read mcp:invoke' });
    expect(redeemed.body.token.claims.iss).toMatch(/resource-as\.mock\.invalid/);

    const tools = (await post(agent, `${API}/call`).expect(200)).body;
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['echo', 'server_time', 'whoami']);
    const echo = (await post(agent, `${API}/call`, { tool: 'echo', arguments: { text: 'hi' } }).expect(200)).body;
    expect(echo.result.content[0].text).toBe('hi');
    const profile = (await post(agent, `${API}/resource`, { variant: 'token' }).expect(200)).body;
    expect(profile.status).toBe(200);

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
    expect(JSON.stringify(idJag.body)).toMatch(/ID-JAG/);
    const none = (await post(agent, `${API}/resource`, { variant: 'no-token' }).expect(200)).body;
    expect(none.status).toBe(401);
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

