// AWS AgentCore leg over HTTP, through the real app: the state, the spec edits, the runs, Live mode, and the write-only
// rule (a recognisable secret is posted and every answer of every route is searched for it).
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { CLAIMS, FIELD_PATHS, SCENARIOS, WRITE_ONLY } from '../agentcoreRedeem.js';
import { _forceMode } from '../mode.js';
import { agentCoreWorld } from '../mock/index.js';
import { API, ORIGIN, expectNoRealCalls, post, useMockMode } from './mockHelpers.js';

const mock = useMockMode();
const AC = `${API}/aws-agentcore`;
const put = (agent, body) => agent.put(`${AC}/spec`).set('Origin', ORIGIN).send(body);

const TYPED_SECRET = ['RECOGNISABLE', 'VALUE', 'c0ffee', '7732'].join('-'); // built here so no scanner reads it as a secret

describe('state', () => {
  it('masks the write-only fields, tags every field and scenario, and says it is simulated', async () => {
    const agent = request.agent(createApp());
    const s = (await agent.get(`${AC}/state`).expect(200)).body;
    expect(s.available).toBe(true);
    expect(s.simulated).toBe(true);
    for (const f of WRITE_ONLY) {
      expect(s.spec.Exchange[f]).toEqual({ set: true, writeOnly: true });
      expect(s.spec.Redeem[f]).toEqual({ set: true, writeOnly: true });
    }
    expect(s.spec.Redeem.TokenURL).toMatch(/agentcore-target\.mock\.invalid\/token$/);
    const ids = new Map(s.claims.map((c) => [c.id, c.tag]));
    for (const p of FIELD_PATHS) expect(ids.get(p), p).toBeDefined();
    expect(s.claims).toEqual(CLAIMS);
    expect(s.scenarios.map((x) => x.id)).toEqual(Object.keys(SCENARIOS));
    expect(s.scenarios.every((x) => x.tag === 'lab-invented')).toBe(true);
    expect(s.allowList).toHaveLength(2);
    expect(s.cast).toMatchObject({ user: 'alice@mock.example', callerClient: 'agent-app' });
  });
});

describe('the playground mode', () => {
  it('can be picked in Mock mode; the other steps do not apply here and say so', async () => {
    const agent = request.agent(createApp());
    const modes = (await agent.get(`${API}/config`).expect(200)).body.modes;
    expect(modes.find((m) => m.id === 'aws-agentcore')).toMatchObject({ available: true, reason: null });
    const cfg = (await post(agent, `${API}/mode`, { mode: 'aws-agentcore' }).expect(200)).body;
    expect(cfg.mode).toBe('aws-agentcore');
    const pre = (await agent.get(`${API}/preflight?step=mode&mode=aws-agentcore&origin=${ORIGIN}`).expect(200)).body;
    expect(pre.ok).toBe(true);
    expect((await post(agent, `${API}/issue`)).status).toBe(409);
  });
});

describe('Live mode: real legs, refusing runtime', () => {
  it('state names the live endpoints and the missing settings; the mock routes stay 409', async () => {
    vi.stubEnv('PF_URL', 'https://pf.example.invalid');
    vi.stubEnv('PF_EXCHANGE_CLIENT_ID', 'pf-exchange-client');
    vi.stubEnv('RESOURCE_AS_ISSUER', 'https://as.example.invalid');
    _forceMode('live');
    const agent = request.agent(createApp());
    const s = (await agent.get(`${AC}/state`).expect(200)).body;
    expect(s.available).toBe(false);
    expect(s.simulated).toBe(false);
    expect(s.live).toBeTruthy();
    expect(s.live.exchange.TokenURL).toMatch(/\/as\/token\.oauth2$/);
    expect(s.live.redeem.TokenURL).toMatch(/\/token$/);
    expect(s.live.missing).toContain('RESOURCE_AS_CLIENT_SECRET'); // the test env has no resource-as secret
    expect(s.live.runtime).toMatchObject({ deployed: false });
    expect(s.live.runtime.reason).toMatch(/owner-run setup/);
    // The mock-only routes still refuse in live mode.
    for (const [method, p, body] of [['put', 'spec', { Exchange: { Scope: 'tools:invoke' } }], ['post', 'run', { scenario: 'happy' }], ['post', 'reset', {}], ['post', 'spec/reset', {}]]) {
      const r = await agent[method](`${AC}/${p}`).set('Origin', ORIGIN).send(body);
      expect(r.status, p).toBe(409);
      expect(r.body.error).toBe('live_unavailable');
    }
    // The mode is pickable in live mode (the panel shows the live note and the Run live button).
    const cfg = (await post(agent, `${API}/mode`, { mode: 'aws-agentcore' }).expect(200)).body;
    expect(cfg.mode).toBe('aws-agentcore');
    const pre = (await agent.get(`${API}/preflight?step=mode&mode=aws-agentcore&origin=${ORIGIN}`).expect(200)).body;
    expect(pre.ok).toBe(true);
  });

  it('run-live refuses a caller-supplied subject token, and answers a sign-in refusal without a pf-as session', async () => {
    _forceMode('live');
    const agent = request.agent(createApp());
    const r = await agent.post(`${AC}/run-live`).set('Origin', ORIGIN).send({ subject_token: 'caller-supplied' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_request');
    const run = (await agent.post(`${AC}/run-live`).set('Origin', ORIGIN).send({})).body;
    expect(run.live).toBe(true);
    expect(run.refusal).toMatchObject({ stage: 'leg1', kind: 'session', error: 'sign_in_required' });
  });
});

describe('writes are same-origin only', () => {
  it('refuses a write with no Origin or a foreign one', async () => {
    const agent = request.agent(createApp());
    expect((await agent.put(`${AC}/spec`).send({ Exchange: { Scope: '' } })).status).toBe(403);
    expect((await agent.post(`${AC}/run`).set('Origin', 'http://evil.example').send({})).status).toBe(403);
    expect((await agent.post(`${AC}/reset`).send({})).status).toBe(403);
  });
});

describe('editing the spec', () => {
  it('saves a valid edit, changes what a run does, and a reset puts the defaults back', async () => {
    const agent = request.agent(createApp());
    const r = (await put(agent, { Exchange: { Scope: 'tools:list' } }).expect(200)).body;
    expect(r.spec.Exchange.Scope).toBe('tools:list');
    const run = (await post(agent, `${AC}/run`, { scenario: 'happy' }).expect(200)).body;
    expect(run.refusal).toMatchObject({ stage: 'leg2', error: 'invalid_scope' });
    expect(run.verdict.pass).toBe(false); // computed: the happy path did not happen
    const back = (await post(agent, `${AC}/spec/reset`).expect(200)).body;
    expect(back.spec.Exchange.Scope).toBe('tools:invoke');
    expect((await post(agent, `${AC}/run`, { scenario: 'happy' }).expect(200)).body.verdict.pass).toBe(true);
  });

  it('refuses a bad edit with the field name and changes nothing', async () => {
    const agent = request.agent(createApp());
    const r = await put(agent, { Exchange: { AuthMethod: 'telepathy', Redeem: { TokenURL: 'javascript:alert(1)' } } });
    expect(r.status).toBe(422);
    expect(r.body.errors.map((e) => e.field).sort()).toEqual(['Exchange.AuthMethod', 'Exchange.Redeem']);
    expect((await agent.get(`${AC}/state`)).body.spec.Exchange.AuthMethod).toBe('client_secret_basic');
  });

  it('clears a write-only field with null and reports it unset, without any value', async () => {
    const agent = request.agent(createApp());
    const r = (await put(agent, { Redeem: { ClientSecret: null } }).expect(200)).body;
    expect(r.spec.Redeem.ClientSecret).toEqual({ set: false, writeOnly: true });
    expect(r.spec.Exchange.ClientSecret).toEqual({ set: true, writeOnly: true });
  });
});

describe('scenarios over HTTP', () => {
  it.each(Object.keys(SCENARIOS))('%s: the verdict is computed from the run and passes', async (id) => {
    const agent = request.agent(createApp());
    const r = await post(agent, `${AC}/run`, { scenario: id }).expect(200);
    expect(r.body.verdict, JSON.stringify(r.body.verdict)).toMatchObject({ pass: true });
    expect(r.headers['x-simulated']).toBe('mock');
    expect(r.body.traceparent).toMatch(/^00-/);
  });
  it('an unknown scenario is a 404', async () => {
    const agent = request.agent(createApp());
    expect((await post(agent, `${AC}/run`, { scenario: 'nope' })).status).toBe(404);
  });
  it('makes no real call', async () => {
    const agent = request.agent(createApp());
    for (const id of Object.keys(SCENARIOS)) await post(agent, `${AC}/run`, { scenario: id }).expect(200);
    expectNoRealCalls(mock);
  });
});

describe('write-only fields never come back', () => {
  it('a typed secret is in no answer of any route, whatever happens to it', async () => {
    const agent = request.agent(createApp());
    const seen = [];
    const keep = (r) => { seen.push(`${r.status} ${JSON.stringify(r.headers)} ${r.text}`); return r; };
    const d = agentCoreWorld().defaults();
    await keep(await agent.get(`${AC}/state`));
    // Type the secret into both sections, and into a non-secret field and a scope.
    await keep(await put(agent, { Exchange: { ClientSecret: TYPED_SECRET }, Redeem: { ClientSecret: TYPED_SECRET } }));
    await keep(await put(agent, { Exchange: { ClientID: TYPED_SECRET } }));
    await keep(await put(agent, { Exchange: { Scope: TYPED_SECRET } }));
    await keep(await post(agent, `${AC}/run`, { scenario: 'happy' }));
    await keep(await post(agent, `${AC}/run`, { scenario: 'no-exchange' }));
    await keep(await agent.get(`${AC}/state`));
    await keep(await post(agent, `${AC}/spec/reset`, {}));
    const needles = [TYPED_SECRET, d.Exchange.ClientSecret, d.Redeem.ClientSecret,
      Buffer.from(`${d.Exchange.ClientID}:${d.Exchange.ClientSecret}`).toString('base64'),
      Buffer.from(`${d.Redeem.ClientID}:${d.Redeem.ClientSecret}`).toString('base64')];
    for (const answer of seen) for (const n of needles) expect(answer, answer.slice(0, 200)).not.toContain(n);
  });
});
