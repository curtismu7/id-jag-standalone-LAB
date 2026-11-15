// "What Privilege did" for gateway-redeem (Rule 25): the trace of every scenario, from the simulated gateway. The lab has no real
// gateway hop (live answers 409), so there is no real trace to build: the live route is checked to give none.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { SCENARIOS, getSpec, runScenario, secretsIn } from '../gatewayRedeem.js';
import { assertTrace } from '../gatewayTrace.js';
import { _forceMode } from '../mode.js';
import { API, ORIGIN, post, useMockMode } from './mockHelpers.js';

useMockMode();
const GR = `${API}/gateway-redeem`;

const decisionOf = (trace, id) => trace.decisions.find((x) => x.id === id);
const byOutcome = (trace) => Object.fromEntries(trace.decisions.map((x) => [x.id, x.outcome]));

describe('every scenario builds a valid, honest, secret-free mock trace', () => {
  for (const id of Object.keys(SCENARIOS)) {
    it(id, async () => {
      const spec = getSpec();
      const needles = secretsIn(spec);
      expect(needles.length).toBeGreaterThan(0); // the default spec does hold write-only values
      const run = await runScenario(id, spec);
      const t = run.trace;
      expect(assertTrace(t)).toEqual([]);
      expect(t.source).toBe('mock');
      expect(t.decisions.length).toBeGreaterThan(0);
      expect(t.decisions.every((x) => x.basis === 'checked')).toBe(true);
      expect(new URL(t.request.url).hostname.endsWith('.invalid')).toBe(true);
      const text = JSON.stringify(t);
      for (const n of needles) expect(text.includes(n), 'a write-only value is in the trace').toBe(false);
      // The caller token is shown shortened, never whole.
      expect(text.includes(run.callerToken.token)).toBe(false);
      expect(t.request.headers.authorization).toMatch(/shortened/);
      expect(t.request.body).toMatchObject({ method: 'tools/call' });
      // An info decision would never be counted as passed; this simulation has none.
      expect(t.decisions.some((x) => x.outcome === 'info')).toBe(false);
    });
  }
});

describe('the decisions say what the simulation computed', () => {
  it('happy: every decision passes, and the target API check list is named', async () => {
    const t = (await runScenario('happy', getSpec())).trace;
    expect(Object.values(byOutcome(t)).every((o) => o === 'pass')).toBe(true);
    expect(t.response.status).toBe(200);
    expect(decisionOf(t, 'target').evidence).toMatch(/bearer, token type, signature, expiry, issuer, audience, scope/);
    expect(decisionOf(t, 'leg1-answer').evidence).toMatch(/id-jag/);
  });

  it('no-redeem: leg 2 is skipped by design and the target API refuses the assertion at "token type"', async () => {
    const run = await runScenario('no-redeem', getSpec());
    const t = run.trace;
    expect(decisionOf(t, 'leg2')).toMatchObject({ outcome: 'skipped' });
    expect(decisionOf(t, 'leg2').evidence).toMatch(/Redeem\.TokenURL is not set/);
    expect(decisionOf(t, 'target')).toMatchObject({ outcome: 'fail' });
    expect(decisionOf(t, 'target').evidence).toMatch(/check: token type/);
  });

  for (const [id, check] of [['untrusted-issuer', 'issuer'], ['wrong-audience', 'audience'], ['expired', 'expiry'], ['bad-signature', 'signature'], ['auth-method', 'client authentication method']]) {
    it(`${id}: the target issuer refuses at leg 2 with check "${check}", the target API is not reached`, async () => {
      const t = (await runScenario(id, getSpec())).trace;
      expect(byOutcome(t)).toMatchObject({ caller: 'pass', 'leg1-answer': 'pass', 'leg2-rules': 'pass', 'leg2-answer': 'fail', target: 'skipped' });
      expect(decisionOf(t, 'leg2-answer').evidence).toContain(`check: ${check}`);
    });
  }

  it('ssrf and redirect fail the gateway\'s own rules for leg 2, and nothing is claimed about the issuer', async () => {
    const ssrf = (await runScenario('ssrf', getSpec())).trace;
    expect(byOutcome(ssrf)).toMatchObject({ 'leg2-auth': 'pass', 'leg2-rules': 'fail', 'leg2-answer': 'skipped', target: 'skipped' });
    expect(decisionOf(ssrf, 'leg2-rules').evidence).toMatch(/^ssrf: .*allow-list/);
    const redirect = (await runScenario('redirect', getSpec())).trace;
    expect(byOutcome(redirect)).toMatchObject({ 'leg2-rules': 'fail', 'leg2-answer': 'skipped' });
    expect(decisionOf(redirect, 'leg2-rules').evidence).toMatch(/^redirect: /);
  });

  it('replay: the gateway call itself passed (the replay is the lab\'s own call, not traced here)', async () => {
    const t = (await runScenario('replay', getSpec())).trace;
    expect(Object.values(byOutcome(t)).every((o) => o === 'pass')).toBe(true);
  });

  it('a rejected caller token: 401, the first decision fails and every later one is not reached', async () => {
    const spec = getSpec();
    const { gatewayCall } = await import('../gatewayRedeem.js');
    const { gatewayRunTrace } = await import('../gatewayRedeemTrace.js');
    const callerToken = 'not.a.token';
    const hops = [{ n: 1, label: 'The agent calls the gateway with the caller token', url: 'https://gateway.mock.invalid/mcp', request: { body: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'ledger_entries' } } } }];
    const result = await gatewayCall({ hops: [], allowed: [] }, spec, callerToken);
    const t = gatewayRunTrace({ callerToken, result, hops, redeemSet: true });
    expect(assertTrace(t)).toEqual([]);
    expect(t.response.status).toBe(401);
    expect(decisionOf(t, 'caller').outcome).toBe('fail');
    expect(t.decisions.filter((x) => x.id !== 'caller').every((x) => x.outcome === 'skipped')).toBe(true);
    expect(t.decisions.map((x) => x.id)).toEqual(['caller', 'leg1-auth', 'leg1-rules', 'leg1-answer', 'leg2', 'target']);
  });
});

describe('over HTTP', () => {
  it('POST /run returns the trace next to the fields the page already used, scrubbed of typed secrets', async () => {
    const TYPED = ['RECOGNISABLE', 'VALUE', 'c0ffee', '7731'].join('-');
    const agent = request.agent(createApp());
    await agent.put(`${GR}/spec`).set('Origin', ORIGIN).send({ OBO: { ClientSecret: TYPED, Redeem: { ClientSecret: TYPED } } }).expect(200);
    const res = await post(agent, `${GR}/run`, { scenario: 'happy' }).expect(200);
    expect(res.body.hops.length).toBeGreaterThan(2);
    expect(res.body.trace.decisions.some((x) => x.outcome === 'fail')).toBe(true); // the typed secret is the wrong one, so the run is refused
    expect(assertTrace(res.body.trace)).toEqual([]);
    expect(res.text.includes(TYPED)).toBe(false);
  });

  it('in Live mode the run answers 409 and carries no trace', async () => {
    _forceMode('live');
    const res = await post(request.agent(createApp()), `${GR}/run`, { scenario: 'happy' }).expect(409);
    expect(res.body.trace).toBeUndefined();
  });
});
