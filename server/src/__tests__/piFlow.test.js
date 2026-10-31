import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import auth from '../auth/oidc.js';
import piFlow from '../auth/piFlow.js';
import playground from '../idJagPlayground.js';

const ORIGIN = 'http://localhost:4720';
const PF = 'https://pf.test';
const PW = 'pw-fake-1';
const CODE = 'authcode-fake-1';
let fetchMock;
let flow; // what the fake PingFederate answers
let logs;

const reply = (status, data, cookies = []) => ({ status, ok: status >= 200 && status < 300, json: async () => data, headers: { getSetCookie: () => cookies } });
const META = { issuer: PF, authorization_endpoint: `${PF}/as/authorization.oauth2`, token_endpoint: `${PF}/as/token.oauth2`, jwks_uri: `${PF}/pf/JWKS` };

function testApp() {
  const app = express();
  app.use(session({ name: 'demo.sid', secret: 'test-session-secret', resave: false, saveUninitialized: false }));
  app.get('/probe/mode/:m', (req, res) => { req.session.idJagPlaygroundMode = req.params.m; res.end(); });
  app.get('/probe', (req, res) => res.json({
    oidcLogin: !!req.session.oidcLogin, issuerLogin: !!req.session.idJagIssuerLogin, flow: !!req.session.piFlow,
    state: req.session.oidcLogin?.state || req.session.idJagIssuerLogin?.state,
  }));
  app.get('/probe/age/:ms', (req, res) => { req.session.piFlow.startedAt -= Number(req.params.ms); res.end(); });
  app.get('/probe/attempts', (req, res) => res.json({ attempts: req.session.piFlow?.attempts }));
  app.use(auth);
  app.use(piFlow);
  app.use('/api/id-jag-playground', playground);
  return app;
}

const post = (agent, p, body) => agent.post(p).set('Origin', ORIGIN).send(body);
const creds = { username: 'demo', password: PW };
const completed = (state) => reply(200, { id: 'flow_1234', status: 'COMPLETED', authorizeResponse: { code: CODE, state } });

beforeEach(() => {
  vi.stubEnv('APP_ORIGIN', ORIGIN);
  vi.stubEnv('PF_URL', PF);
  vi.stubEnv('PF_EXCHANGE_CLIENT_ID', 'pf-exchange');
  vi.stubEnv('PF_EXCHANGE_CLIENT_SECRET', 'exchange-secret');
  vi.stubEnv('RESOURCE_AS_ISSUER', 'https://as.test');
  vi.stubEnv('RESOURCE_AS_CLIENT_SECRET', 'as-secret');
  flow = { start: reply(200, { id: 'flow_1234', status: 'USERNAME_PASSWORD_REQUIRED' }, ['PF=start1; Path=/; HttpOnly']), posts: [] };
  fetchMock = vi.fn(async (url, init = {}) => {
    if (String(url).endsWith('/.well-known/openid-configuration')) return reply(200, META);
    if (String(url).startsWith(`${PF}/as/authorization.oauth2`)) { if (flow.startError) throw flow.startError; return flow.start; }
    if (String(url).startsWith(`${PF}/pf-ws/authn/flows/`)) { const next = flow.posts.shift(); if (next instanceof Error) throw next; return next; }
    throw new Error(`unexpected fetch ${url} ${init.method || 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error']) vi.spyOn(console, level).mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const startCall = () => fetchMock.mock.calls.find(([u]) => String(u).startsWith(`${PF}/as/authorization.oauth2`));
const postCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith(`${PF}/pf-ws/authn/flows/`));

const KINDS = [
  { name: 'app', start: '/auth/pi-flow/start?return_to=/trusted-idps', creds: '/auth/pi-flow/credentials', key: 'oidcLogin', redirect: `${ORIGIN}/auth/callback` },
  { name: 'issuer', start: '/api/id-jag-playground/issuer/pi-flow/start?return_to=/', creds: '/api/id-jag-playground/issuer/pi-flow/credentials', key: 'issuerLogin', redirect: `${ORIGIN}/api/id-jag-playground/issuer/callback`, mode: 'pf-as' },
];

describe.each(KINDS)('pi.flow sign-in ($name)', (k) => {
  async function begin() {
    const agent = request.agent(testApp());
    if (k.mode) await agent.get(`/probe/mode/${k.mode}`);
    const res = await agent.get(k.start);
    return { agent, res, probe: async () => (await agent.get('/probe')).body };
  }

  it('opens the flow server-side with pi.flow and the same authorize request as the redirect login', async () => {
    const { res, probe } = await begin();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flowId: 'flow_1234', status: 'USERNAME_PASSWORD_REQUIRED' });
    const [url, init] = startCall();
    const q = new URL(url).searchParams;
    expect(q.get('response_mode')).toBe('pi.flow');
    expect(q.get('client_id')).toBe('pf-exchange');
    expect(q.get('redirect_uri')).toBe(k.redirect);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(init.redirect).toBe('manual');
    expect(init.headers.Accept).toBe('application/json');
    expect(q.get('state')).toBe((await probe()).state);
    expect(await probe()).toEqual(expect.objectContaining({ [k.key]: true, flow: true }));
  });

  it.each([
    ['FAILED', () => { flow.start = reply(200, { id: 'flow_1234', status: 'FAILED' }); }],
    ['another status', () => { flow.start = reply(200, { id: 'flow_1234', status: 'MFA_REQUIRED' }); }],
    ['a non-200', () => { flow.start = reply(302, {}); }],
    ['a bad flow id', () => { flow.start = reply(200, { id: 'x', status: 'USERNAME_PASSWORD_REQUIRED' }); }],
    ['a network error', () => { flow.startError = new Error('down'); }],
  ])('answers 502 and drops the pending login when the flow opens as %s', async (_n, arrange) => {
    arrange();
    const { res, probe } = await begin();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'pi_flow_unavailable' });
    expect(await probe()).toEqual(expect.objectContaining({ [k.key]: false, flow: false }));
  });

  it('completes: replays the cookie jar and returns the redirect with code and state', async () => {
    const { agent, probe } = await begin();
    const { state } = await probe();
    flow.posts.push(reply(400, { details: [{ code: 'CREDENTIAL_VALIDATION_FAILED' }] }, ['PF2=second; Path=/']), completed(state));
    await post(agent, k.creds, { username: 'demo', password: 'bad' });
    const res = await post(agent, k.creds, creds);
    expect(res.status).toBe(200);
    const to = new URL(res.body.redirectTo);
    expect(`${to.origin}${to.pathname}`).toBe(k.redirect);
    expect(to.searchParams.get('code')).toBe(CODE);
    expect(to.searchParams.get('state')).toBe(state);
    const [url, init] = postCalls()[1];
    expect(url).toBe(`${PF}/pf-ws/authn/flows/flow_1234`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/vnd.pingidentity.checkUsernamePassword+json');
    expect(init.headers['X-XSRF-Header']).toBe('PingFederate');
    expect(init.headers.Cookie).toBe('PF=start1; PF2=second');
    expect(JSON.parse(init.body)).toEqual(creds);
    expect((await probe()).flow).toBe(false);
    expect(logs.join('\n')).not.toContain(PW);
    expect(logs.join('\n')).not.toContain(CODE);
  });

  it('answers 401 for bad credentials and keeps the flow usable', async () => {
    const { agent, probe } = await begin();
    const { state } = await probe();
    flow.posts.push(reply(400, { details: [{ code: 'CREDENTIAL_VALIDATION_FAILED' }] }), completed(state));
    const bad = await post(agent, k.creds, { username: 'demo', password: PW });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: 'invalid_credentials', message: 'Username or password is incorrect.' });
    expect(JSON.stringify(bad.body)).not.toContain(PW);
    expect((await post(agent, k.creds, creds)).status).toBe(200);
  });

  it('refuses a state mismatch: no code leaves', async () => {
    const { agent, probe } = await begin();
    flow.posts.push(completed('someone-elses-state'));
    const res = await post(agent, k.creds, creds);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'pi_flow_failed' });
    expect(JSON.stringify(res.body)).not.toContain(CODE);
    expect(logs.join('\n')).not.toContain(CODE);
    expect(await probe()).toEqual(expect.objectContaining({ [k.key]: false, flow: false }));
  });

  it('answers 502 on a non-ok answer and on a network error', async () => {
    const { agent, probe } = await begin();
    flow.posts.push(reply(500, {}));
    expect((await post(agent, k.creds, creds)).status).toBe(502);
    expect(await probe()).toEqual(expect.objectContaining({ [k.key]: false, flow: false }));
    const again = await begin();
    flow.posts.push(new Error('down'));
    expect((await post(again.agent, k.creds, creds)).status).toBe(502);
    expect(await again.probe()).toEqual(expect.objectContaining({ [k.key]: false, flow: false }));
  });

  it('falls back on an unknown status (MFA, a policy screen)', async () => {
    const { agent, probe } = await begin();
    flow.posts.push(reply(200, { id: 'flow_1234', status: 'MFA_REQUIRED' }));
    const res = await post(agent, k.creds, creds);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fallback: true, status: 'MFA_REQUIRED' });
    expect(await probe()).toEqual(expect.objectContaining({ [k.key]: false, flow: false }));
  });

  it('allows 8 attempts per flow, then 429', async () => {
    const { agent } = await begin();
    for (let i = 0; i < 8; i += 1) {
      flow.posts.push(reply(400, { details: [{ code: 'CREDENTIAL_VALIDATION_FAILED' }] }));
      expect((await post(agent, k.creds, creds)).status).toBe(401);
    }
    expect((await post(agent, k.creds, creds)).status).toBe(429);
    expect(postCalls()).toHaveLength(8);
  });

  it('keeps the attempt count when start runs again inside the TTL, and resets it after', async () => {
    const { agent } = await begin();
    for (let i = 0; i < 8; i += 1) {
      flow.posts.push(reply(400, { details: [{ code: 'CREDENTIAL_VALIDATION_FAILED' }] }));
      await post(agent, k.creds, creds);
    }
    await agent.get(k.start);
    expect((await post(agent, k.creds, creds)).status).toBe(429);
    expect(postCalls()).toHaveLength(8);
    await agent.get('/probe/age/301000');
    await agent.get(k.start);
    flow.posts.push(reply(400, { details: [{ code: 'CREDENTIAL_VALIDATION_FAILED' }] }));
    expect((await post(agent, k.creds, creds)).status).toBe(401);
  });

  it('caps parallel guesses too, even though each request holds its own copy of the session', async () => {
    const { agent } = await begin();
    fetchMock.mockImplementation(async (url) => {
      if (!String(url).startsWith(`${PF}/pf-ws/authn/flows/`)) throw new Error(`unexpected fetch ${url}`);
      await new Promise((r) => setTimeout(r, 30));
      return reply(400, { details: [{ code: 'CREDENTIAL_VALIDATION_FAILED' }] });
    });
    const res = await Promise.all(Array.from({ length: 20 }, () => post(agent, k.creds, creds)));
    expect(postCalls()).toHaveLength(8);
    expect(res.filter((r) => r.status === 429)).toHaveLength(12);
  });

  it('persists the attempt before calling PingFederate', async () => {
    const { agent } = await begin();
    let seen;
    fetchMock.mockImplementationOnce(async () => { seen = (await agent.get('/probe/attempts')).body.attempts; return reply(400, { details: [{ code: 'CREDENTIAL_VALIDATION_FAILED' }] }); });
    await post(agent, k.creds, creds);
    expect(seen).toBe(1);
  });

  it('answers 409 with no flow, an expired flow, or after the flow ended', async () => {
    const none = await post(request.agent(testApp()), k.creds, creds);
    expect(none.status).toBe(409);
    expect(none.body).toEqual({ error: 'pi_flow_not_started' });
    const { agent, probe } = await begin();
    await agent.get('/probe/age/301000');
    expect((await post(agent, k.creds, creds)).status).toBe(409);
    const fresh = await begin();
    flow.posts.push(completed((await fresh.probe()).state));
    await post(fresh.agent, k.creds, creds);
    expect((await post(fresh.agent, k.creds, creds)).status).toBe(409);
    expect(postCalls()).toHaveLength(1);
    expect(await probe()).toBeTruthy();
  });

  it('refuses a cross-origin POST before any call to PingFederate', async () => {
    const { agent } = await begin();
    const res = await agent.post(k.creds).set('Origin', 'https://evil.test').send(creds);
    expect(res.status).toBe(403);
    expect(postCalls()).toHaveLength(0);
  });

  it.each([
    [{ username: '', password: PW }], [{ username: 'demo', password: '' }], [{ username: 5, password: PW }],
    [{ username: 'demo', password: 'p'.repeat(257) }], [{}],
  ])('rejects invalid credentials input %#', async (body) => {
    const { agent } = await begin();
    const res = await post(agent, k.creds, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    expect(postCalls()).toHaveLength(0);
  });
});

describe('kinds do not share state', () => {
  // Both flows started in one session: the single piFlow slot holds the later kind, while both pending
  // logins are present, so only the kind check can refuse the earlier one.
  it.each([
    ['app', '/auth/pi-flow/start', '/api/id-jag-playground/issuer/pi-flow/start', '/auth/pi-flow/credentials'],
    ['issuer', '/api/id-jag-playground/issuer/pi-flow/start', '/auth/pi-flow/start', '/api/id-jag-playground/issuer/pi-flow/credentials'],
  ])('a later flow of the other kind refuses %s credentials', async (_n, first, second, creds_) => {
    const agent = request.agent(testApp());
    await agent.get('/probe/mode/pf-as');
    await agent.get(first);
    await agent.get(second);
    const res = await post(agent, creds_, creds);
    expect(res.status).toBe(409);
    expect(postCalls()).toHaveLength(0);
  });
});

describe('app start preconditions', () => {
  it('409 pi_flow_unavailable when the issuer is not the kit PingFederate', async () => {
    vi.stubEnv('OIDC_ISSUER', 'https://other.test');
    const res = await request(testApp()).get('/auth/pi-flow/start');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'pi_flow_unavailable' });
    expect(startCall()).toBeUndefined();
  });

  it('503 when sign-in is not configured', async () => {
    vi.stubEnv('PF_EXCHANGE_CLIENT_ID', '');
    expect((await request(testApp()).get('/auth/pi-flow/start')).status).toBe(503);
  });
});

describe('issuer start preconditions', () => {
  const start = '/api/id-jag-playground/issuer/pi-flow/start';
  it('409 in byo mode', async () => {
    const res = await request(testApp()).get(start);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('byo_mode');
    expect(startCall()).toBeUndefined();
  });

  it('409 not_configured when the mode lacks settings', async () => {
    vi.stubEnv('PF_EXCHANGE_CLIENT_SECRET', '');
    const agent = request.agent(testApp());
    await agent.get('/probe/mode/pf-as');
    const res = await agent.get(start);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_configured');
  });
});
