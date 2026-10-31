// Gateway redeem over HTTP, through the real app: the state, the spec edits, the runs, Live mode, and the write-only rule
// (a recognisable secret is posted and every answer of every route is searched for it).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { CLAIMS, FIELD_PATHS, SCENARIOS, WRITE_ONLY } from '../gatewayRedeem.js';
import { _forceMode } from '../mode.js';
import { gatewayWorld } from '../mock/index.js';
import { API, ORIGIN, expectNoRealCalls, post, useMockMode } from './mockHelpers.js';

const mock = useMockMode();
const GR = `${API}/gateway-redeem`;
const put = (agent, body) => agent.put(`${GR}/spec`).set('Origin', ORIGIN).send(body);

const TYPED_SECRET = ['RECOGNISABLE', 'VALUE', 'c0ffee', '7731'].join('-'); // built here so no scanner reads it as a secret
const TYPED_PEM_LINE = ['TYPEDKEYLINE', 'AAAABBBBCCCCDDDD', 'EEEEFFFF0123456789'].join('');

/** Every answer the agent receives is kept as text, so a needle can be searched for after the fact. */
function recorder(agent) {
  const seen = [];
  const keep = (res) => { seen.push(`${res.status} ${JSON.stringify(res.headers)} ${res.text}`); return res; };
  return {
    seen,
    get: async (p) => keep(await agent.get(p)),
    post: async (p, b) => keep(await post(agent, p, b)),
    put: async (b) => keep(await put(agent, b)),
    raw: async (method, p, body) => keep(await agent[method](p).set('Origin', ORIGIN).set('Content-Type', 'application/json').send(body)),
  };
}

describe('state', () => {
  it('names the claim, masks the write-only fields, and tags every field and scenario', async () => {
    const agent = request.agent(createApp());
    const s = (await agent.get(`${GR}/state`).expect(200)).body;
    expect(s.claim).toBe('Ping release claim (2026-11-02), UNVERIFIED on our tenant');
    expect(s.available).toBe(true);
    expect(s.simulated).toBe(true);
    for (const f of WRITE_ONLY) {
      expect(s.spec.OBO[f]).toEqual({ set: true, writeOnly: true });
      expect(s.spec.OBO.Redeem[f]).toEqual({ set: true, writeOnly: true });
    }
    expect(s.spec.OBO.Redeem.TokenURL).toMatch(/target-idp\.mock\.invalid\/token$/);
    // Every editable field is tagged as a console swagger name; the inventions are tagged too.
    const ids = new Map(s.claims.map((c) => [c.id, c.tag]));
    for (const p of FIELD_PATHS) expect(ids.get(p), p).toBe('console swagger name, 2026-10-31, schema only');
    expect(s.claims).toEqual(CLAIMS);
    expect(new Set(s.claims.map((c) => c.tag))).toEqual(new Set(['console swagger name, 2026-10-31, schema only', 'lab reading', 'lab-invented', 'Ping release claim (2026-11-02), UNVERIFIED on our tenant']));
    expect(s.scenarios.map((x) => x.id)).toEqual(Object.keys(SCENARIOS));
    expect(s.scenarios.every((x) => x.tag === 'lab-invented')).toBe(true);
    expect(s.allowList).toHaveLength(3);
  });
});

describe('the playground mode', () => {
  it('can be picked in Mock mode and fills the page config from the spec', async () => {
    const agent = request.agent(createApp());
    const modes = (await agent.get(`${API}/config`).expect(200)).body.modes;
    expect(modes.find((m) => m.id === 'gateway-redeem')).toMatchObject({ available: true, reason: null });
    const cfg = (await post(agent, `${API}/mode`, { mode: 'gateway-redeem' }).expect(200)).body;
    expect(cfg.mode).toBe('gateway-redeem');
    expect(cfg.idp.tokenEndpoint).toMatch(/exchange-idp\.mock\.invalid\/token$/);
    const pre = (await agent.get(`${API}/preflight?step=mode&mode=gateway-redeem&origin=${ORIGIN}`).expect(200)).body;
    expect(pre.ok).toBe(true);
    // The other steps do not apply here and say so.
    expect((await post(agent, `${API}/issue`)).status).toBe(409);
  });
});

describe('Live mode: honestly unavailable', () => {
  it('says why on every route, and the mode cannot be picked', async () => {
    _forceMode('live');
    const agent = request.agent(createApp());
    const s = (await agent.get(`${GR}/state`).expect(200)).body;
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/2026-11-02 release is not on our tenant/);
    for (const [method, p, body] of [['put', 'spec', { OBO: { Scope: 'ledger:read' } }], ['post', 'run', { scenario: 'happy' }], ['post', 'reset', {}], ['post', 'spec/reset', {}]]) {
      const r = await agent[method](`${GR}/${p}`).set('Origin', ORIGIN).send(body);
      expect(r.status, p).toBe(409);
      expect(r.body.error).toBe('live_unavailable');
    }
    const modes = (await agent.get(`${API}/config`).expect(200)).body.modes;
    expect(modes.find((m) => m.id === 'gateway-redeem')).toMatchObject({ available: false, reason: expect.stringMatching(/not on our tenant/) });
    const pre = (await agent.get(`${API}/preflight?step=mode&mode=gateway-redeem&origin=${ORIGIN}`).expect(200)).body;
    expect(pre.ok).toBe(false);
  });
});

describe('writes are same-origin only', () => {
  it('refuses a write with no Origin or a foreign one', async () => {
    const agent = request.agent(createApp());
    expect((await agent.put(`${GR}/spec`).send({ OBO: { Scope: '' } })).status).toBe(403);
    expect((await agent.post(`${GR}/run`).set('Origin', 'http://evil.example').send({})).status).toBe(403);
    expect((await agent.post(`${GR}/reset`).send({})).status).toBe(403);
  });
});

describe('editing the spec', () => {
  it('saves a valid edit, changes what a run does, and a reset puts the defaults back', async () => {
    const agent = request.agent(createApp());
    const r = (await put(agent, { OBO: { Scope: 'ledger:admin' } }).expect(200)).body;
    expect(r.spec.OBO.Scope).toBe('ledger:admin');
    const run = (await post(agent, `${GR}/run`, { scenario: 'happy' }).expect(200)).body;
    expect(run.refusal).toMatchObject({ stage: 'leg1', error: 'invalid_scope' });
    expect(run.verdict.pass).toBe(false); // computed: the happy path did not happen
    const back = (await post(agent, `${GR}/spec/reset`).expect(200)).body;
    expect(back.spec.OBO.Scope).toBe('ledger:read');
    expect((await post(agent, `${GR}/run`, { scenario: 'happy' }).expect(200)).body.verdict.pass).toBe(true);
  });

  it('refuses a bad edit with the field name and changes nothing', async () => {
    const agent = request.agent(createApp());
    const r = await put(agent, { OBO: { AuthMethod: 'telepathy', Redeem: { TokenURL: 'javascript:alert(1)' } } });
    expect(r.status).toBe(422);
    expect(r.body.errors.map((e) => e.field).sort()).toEqual(['OBO.AuthMethod', 'OBO.Redeem.TokenURL']);
    expect((await agent.get(`${GR}/state`)).body.spec.OBO.AuthMethod).toBe('client_secret_basic');
  });

  it('clears a write-only field with null and reports it unset, without any value', async () => {
    const agent = request.agent(createApp());
    const r = (await put(agent, { OBO: { Redeem: { ClientSecret: null } } }).expect(200)).body;
    expect(r.spec.OBO.Redeem.ClientSecret).toEqual({ set: false, writeOnly: true });
    expect(r.spec.OBO.ClientSecret).toEqual({ set: true, writeOnly: true });
  });

  it('a Redeem edit runs the second leg only when Redeem.TokenURL is set', async () => {
    const agent = request.agent(createApp());
    await put(agent, { OBO: { Redeem: null } }).expect(200);
    const none = (await post(agent, `${GR}/run`, { scenario: 'happy' }).expect(200)).body;
    expect(none.redeemed).toBe(false);
    expect(none.target.status).toBe(401);
    await put(agent, { OBO: { Redeem: { TokenURL: gatewayWorld().defaults().OBO.Redeem.TokenURL, ClientID: 'gateway-redeem', AuthMethod: 'client_secret_post', ClientSecret: gatewayWorld().defaults().OBO.Redeem.ClientSecret } } }).expect(200);
    const both = (await post(agent, `${GR}/run`, { scenario: 'happy' }).expect(200)).body;
    expect(both.redeemed).toBe(true);
    expect(both.target.status).toBe(200);
  });
});

describe('scenarios over HTTP', () => {
  it.each(Object.keys(SCENARIOS))('%s: the verdict is computed from the run and passes', async (id) => {
    const agent = request.agent(createApp());
    const r = await post(agent, `${GR}/run`, { scenario: id }).expect(200);
    expect(r.body.verdict, JSON.stringify(r.body.verdict)).toMatchObject({ pass: true });
    expect(r.headers['x-simulated']).toBe('mock');
    expect(r.body.traceparent).toMatch(/^00-/);
  });
  it('an unknown scenario is a 404', async () => {
    const agent = request.agent(createApp());
    expect((await post(agent, `${GR}/run`, { scenario: 'nope' })).status).toBe(404);
  });
  it('makes no real call', async () => {
    const agent = request.agent(createApp());
    for (const id of Object.keys(SCENARIOS)) await post(agent, `${GR}/run`, { scenario: id }).expect(200);
    expectNoRealCalls(mock);
  });
});

describe('write-only fields never come back', () => {
  /** The values that must not appear anywhere: the stored defaults and everything typed. */
  const needles = (typed) => {
    const d = gatewayWorld().defaults().OBO;
    const pemBody = (p) => p.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    return [d.ClientSecret, d.Redeem.ClientSecret, pemBody(d.PrivateKeyPEM), pemBody(d.Redeem.PrivateKeyPEM), ...typed];
  };

  it('a typed secret and a typed key are in no answer of any route, whatever happens to them', async () => {
    const agent = request.agent(createApp());
    const rec = recorder(agent);
    const other = gatewayWorld()._otherKey().pem;
    const typedKeyBody = other.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    await rec.get(`${GR}/state`);
    // Type a secret and a key into both legs, and the same secret into a non-secret field and a scope.
    await rec.put({ OBO: { ClientSecret: TYPED_SECRET, PrivateKeyPEM: other, Redeem: { ClientSecret: TYPED_SECRET, PrivateKeyPEM: other } } });
    await rec.put({ OBO: { ClientID: TYPED_SECRET } }); // typing it into a non-secret field must not bring it back either
    await rec.get(`${GR}/state`);
    for (const id of Object.keys(SCENARIOS)) await rec.post(`${GR}/run`, { scenario: id });
    // Both auth methods, with the typed values in use (a refusal that could echo them).
    for (const m of ['client_secret_basic', 'client_secret_post', 'private_key_jwt']) {
      await rec.put({ OBO: { AuthMethod: m, ClientID: 'gateway-obo', Redeem: { AuthMethod: m === 'client_secret_basic' ? 'client_secret_post' : m } } });
      await rec.post(`${GR}/run`, { scenario: 'happy' });
    }
    // Bad edits that carry the values, and a body that does not parse (its parser message could quote the text).
    await rec.put({ OBO: { PrivateKeyPEM: `-----BEGIN PRIVATE KEY-----\n${TYPED_PEM_LINE}\n-----END PRIVATE KEY-----`, AuthMethod: TYPED_SECRET, Resource: TYPED_SECRET } });
    await rec.raw('put', `${GR}/spec`, `{"OBO":{"ClientSecret":"${TYPED_SECRET}`);
    await rec.raw('post', `${GR}/run`, `{"scenario":"${TYPED_SECRET}"}`);
    await rec.post(`${GR}/run`, { scenario: TYPED_SECRET });
    await rec.post(`${GR}/reset`, {});
    await rec.get(`${GR}/state`);
    await rec.get(`${API}/config`);

    expect(rec.seen.length).toBeGreaterThanOrEqual(25);
    const all = rec.seen.join('\n');
    for (const n of needles([TYPED_SECRET, TYPED_PEM_LINE, typedKeyBody, Buffer.from(`gateway-obo:${TYPED_SECRET}`).toString('base64'), other.split('\n')[1]])) {
      expect(all.includes(n), `${n.slice(0, 12)}... must not appear`).toBe(false);
    }
    expect(all).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });

  it('the trace of a refusal says write-only where a secret was sent', async () => {
    const agent = request.agent(createApp());
    await put(agent, { OBO: { ClientSecret: TYPED_SECRET } }).expect(200);
    const r = (await post(agent, `${GR}/run`, { scenario: 'happy' }).expect(200)).body;
    expect(r.refusal).toMatchObject({ stage: 'leg1', error: 'invalid_client' });
    expect(JSON.stringify(r)).not.toContain(TYPED_SECRET);
    expect(r.hops.find((h) => h.label.startsWith('Leg 1')).request.authentication).toMatch(/write-only/);
    await put(agent, { OBO: { AuthMethod: 'client_secret_post' } }).expect(200);
    const post2 = (await post(agent, `${GR}/run`, { scenario: 'happy' }).expect(200)).body;
    expect(post2.hops.find((h) => h.label.startsWith('Leg 1')).request.body.client_secret).toBe('[write-only]');
  });

  it('the leg-2 client assertion is shown as write-only, never as the signed JWT', async () => {
    const agent = request.agent(createApp());
    const r = (await post(agent, `${GR}/run`, { scenario: 'happy' }).expect(200)).body;
    const leg2 = r.hops.find((h) => h.label.startsWith('Leg 2'));
    expect(leg2.request.body.client_assertion).toMatch(/write-only/);
    expect(leg2.request.authentication).toMatch(/private_key_jwt/);
  });

  it('knows which fields are write-only', () => {
    expect(WRITE_ONLY).toEqual(['ClientSecret', 'PrivateKeyPEM']);
  });
});
