// AWS AgentCore leg, engine level: the three hops (exchange, redeem, runtime), the scenarios, the SSRF rule, and one
// mutation test per editable spec field. The AWS side is a lab simulation: no AWS service is called or mocked at the
// protocol level beyond this lab's own runtime shape.
import { describe, expect, it, vi } from 'vitest';
import { FIELD_PATHS, SCENARIOS, TOKEN_TYPES, API_AUDIENCE, CALLER_CLIENT_ID, CALLER_USER, SCOPES, assertAllowedUrl, agentCoreCall, applyPatch, runScenario } from '../agentcoreRedeem.js';
import { createEcKey, now, sign } from '../mock/util.js';
import { ORIGINS } from '../mock/env.js';
import { agentCoreWorld } from '../mock/index.js';
import { netguard } from '../outbound.js';
import { expectNoRealCalls, useMockMode } from './mockHelpers.js';

const state = useMockMode();
const base = () => agentCoreWorld().defaults();
const mutate = (fn) => { const s = base(); fn(s); return s; };
const run = (spec, id = 'happy') => runScenario(id, spec);
const NEW = ['a', 'new', 'value', '1'].join('-');
const WRONG = ['wrong', 'value', 'for', 'a', 'test', '1234'].join('-'); // built here so no scanner reads it as a secret

describe('the three hops', () => {
  it('leg 1 gives an ID-JAG addressed to the Resource, for the user, acting for the calling client', async () => {
    const r = await run(base());
    expect(r.refusal).toBeNull();
    const { header, claims } = r.leg1.decoded;
    expect(header.typ).toBe('oauth-id-jag+jwt');
    expect(r.leg1.issuedTokenType).toBe(TOKEN_TYPES.idJag);
    expect(r.leg1.isIdJag).toBe(true);
    expect(claims).toMatchObject({ iss: ORIGINS.acExchange, sub: CALLER_USER, aud: base().Exchange.Resource, client_id: 'agentcore-redeem', scope: 'tools:invoke', act: { sub: CALLER_CLIENT_ID }, mock: true });
    expect(claims.exp - claims.iat).toBe(300);
  });

  it('leg 2 redeems it: the token names the user, carries act and the workload identity, and the runtime accepts it', async () => {
    const r = await run(base());
    expect(r.redeemed).toBe(true);
    expect(r.leg2.decoded.claims).toMatchObject({ iss: ORIGINS.acTarget, sub: CALLER_USER, aud: API_AUDIENCE, client_id: 'agentcore-redeem', scope: 'tools:invoke', act: { sub: CALLER_CLIENT_ID } });
    expect(typeof r.leg2.decoded.claims.wid).toBe('string');
    expect(r.runtime.status).toBe(200);
    expect(r.runtime.body.principal).toMatchObject({ sub: CALLER_USER, client_id: 'agentcore-redeem' });
    expect(r.runtime.body.tool).toBe('get_account_summary');
    expect(r.runtime.body.workloadIdentity).toBe(r.leg2.decoded.claims.wid);
    expect(r.runtime.body.simulated).toBe(true);
    expect(r.verdict.pass).toBe(true);
  });

  it("the runtime rejects the caller's original token and the raw ID-JAG, each naming the check that failed", async () => {
    const r = await run(base());
    expect(r.controls).toHaveLength(2);
    expect(r.controls[0]).toMatchObject({ status: 401, failedCheck: 'signature' });
    expect(r.controls[1]).toMatchObject({ status: 401, failedCheck: 'token type' });
    expect(r.controls[1].detail).toMatch(/This is an ID-JAG/); // the runtime knows an assertion when it sees one
    expect(r.callerToken.token).not.toBe(r.leg2.token);
    expect(r.leg2.token).not.toBe(r.leg1.token);
  });

  it('every hop carries a W3C traceparent on one trace, and nothing real was called', async () => {
    const r = await run(base());
    expect(r.hops.length).toBe(6); // hand-off + 3 calls + 2 controls
    for (const h of r.hops) expect(h.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(new Set(r.hops.map((h) => h.traceparent.split('-')[1])).size).toBe(1);
    expect(new Set(r.hops.map((h) => h.traceparent.split('-')[2])).size).toBeGreaterThan(1);
    expectNoRealCalls(state);
  });

  it('every call the runner makes is allow-listed, sent with redirect: error and the traceparent', async () => {
    const spy = vi.spyOn(netguard, 'fetch');
    await run(base());
    const posts = spy.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(5); // two issuer POSTs, the runtime invoke, and two controls
    for (const [url, init] of spy.mock.calls) {
      expect(init.redirect).toBe('error');
      expect(init.headers.traceparent).toMatch(/^00-/);
      expect(agentCoreWorld().allowedOrigins.concat(ORIGINS.acRuntime)).toContain(new URL(url).origin);
    }
    spy.mockRestore();
  });

  it('the values shown as results come from the run: a different caller gives a different sub', async () => {
    const world = agentCoreWorld();
    const ctx = { hops: [], traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', allowed: world.allowedOrigins };
    const out = await agentCoreCall(ctx, base(), await world.callerToken({ sub: 'bob@mock.example' }));
    expect(out.leg2.decoded.claims.sub).toBe('bob@mock.example');
    expect(out.runtime.body.principal.sub).toBe('bob@mock.example');
  });

  it('each ID-JAG is single use: the replay scenario is accepted once, then refused', async () => {
    const r = await run(base(), 'replay');
    expect(r.verdict.pass).toBe(true);
    expect(r.replay).toEqual({ attempted: true, accepted: false, refusal: { stage: 'leg2', kind: 'oauth', status: 400, error: 'invalid_grant', description: 'ID-JAG already redeemed (jti is single use)', check: 'replay' } });
  });
});

describe('scenarios', () => {
  it('every scenario judges as it expects', async () => {
    for (const id of Object.keys(SCENARIOS)) {
      if (id === 'replay') continue; // checked above with its replayRefused expectation
      const r = await run(base(), id);
      const failed = (r.verdict.checks ?? []).filter((c) => c.want !== c.got);
      expect(failed, id).toEqual([]);
      expect(r.verdict.pass, id).toBe(true);
    }
  });
});

// One mutation test per editable field. A coverage test keeps this list and FIELD_PATHS in lockstep.
const MUTATIONS = {
  'Exchange.TokenURL': async () => {
    // The target issuer is not the exchange issuer: the client is not registered there.
    expect((await run(mutate((s) => { s.Exchange.TokenURL = `${ORIGINS.acTarget}/token`; }))).refusal).toMatchObject({ stage: 'leg1', error: 'invalid_client' });
  },
  'Exchange.ClientID': async () => {
    expect((await run(mutate((s) => { s.Exchange.ClientID = 'nobody'; }))).refusal).toMatchObject({ stage: 'leg1', error: 'invalid_client' });
  },
  'Exchange.ClientSecret': async () => {
    expect((await run(mutate((s) => { s.Exchange.ClientSecret = WRONG; }))).refusal).toMatchObject({ stage: 'leg1', error: 'invalid_client' });
  },
  'Exchange.AuthMethod': async () => {
    expect((await run(mutate((s) => { s.Exchange.AuthMethod = 'client_secret_post'; }))).refusal).toBeNull();
    expect((await run(mutate((s) => { s.Exchange.AuthMethod = 'client_secret_post'; s.Exchange.ClientSecret = WRONG; }))).refusal).toMatchObject({ stage: 'leg1', error: 'invalid_client' });
  },
  'Exchange.Resource': async () => {
    expect((await run(mutate((s) => { s.Exchange.Resource = 'https://other-app.mock.invalid'; }))).refusal).toMatchObject({ stage: 'leg2', check: 'audience' });
  },
  'Exchange.Scope': async () => {
    const r = await run(mutate((s) => { s.Exchange.Scope = ''; }));
    expect(r.leg1.decoded.claims.scope).toBe('tools:invoke tools:list');
    expect((await run(mutate((s) => { s.Exchange.Scope = 'tools:list'; }))).leg1.decoded.claims.scope).toBe('tools:list');
    expect((await run(mutate((s) => { s.Exchange.Scope = 'tools:invoke tools:list'; s.Redeem.Scope = ''; }))).leg2.decoded.claims.scope).toBe('tools:invoke tools:list');
  },
  'Exchange.SubjectTokenType': async () => {
    expect((await run(mutate((s) => { s.Exchange.SubjectTokenType = 'urn:ietf:params:oauth:token-type:refresh_token'; }))).refusal).toMatchObject({ stage: 'leg1', error: 'invalid_request' });
  },
  'Exchange.RequestedTokenType': async () => {
    // A plain access token is not an ID-JAG: the target issuer refuses its typ.
    expect((await run(mutate((s) => { s.Exchange.RequestedTokenType = TOKEN_TYPES.accessToken; }))).refusal).toMatchObject({ stage: 'leg2', check: 'typ' });
  },
  'Redeem.TokenURL': async () => {
    // An empty URL is not an absolute URL: the SSRF rule refuses it before any request.
    expect((await run(mutate((s) => { s.Redeem.TokenURL = ''; }))).refusal).toMatchObject({ stage: 'leg2', kind: 'ssrf' });
    expect((await run(mutate((s) => { s.Redeem.TokenURL = 'https://evil.example/token'; }))).refusal).toMatchObject({ stage: 'leg2', kind: 'ssrf' });
  },
  'Redeem.ClientID': async () => {
    // A client the target issuer does not know: refused at client authentication.
    expect((await run(mutate((s) => { s.Redeem.ClientID = 'nobody'; }))).refusal).toMatchObject({ stage: 'leg2', error: 'invalid_client' });
  },
  'Redeem.ClientSecret': async () => {
    expect((await run(mutate((s) => { s.Redeem.ClientSecret = WRONG; }))).refusal).toMatchObject({ stage: 'leg2', error: 'invalid_client' });
  },
  'Redeem.AuthMethod': async () => {
    const r = await run(mutate((s) => { s.Redeem.AuthMethod = 'client_secret_basic'; }));
    expect(r.refusal).toBeNull();
    expect(agentCoreWorld().target.events.list()[0].method).toBe('client_secret_basic');
  },
  'Redeem.Scope': async () => {
    const all = await run(mutate((s) => { s.Exchange.Scope = ''; s.Redeem.Scope = ''; }));
    expect(all.leg2.decoded.claims.scope).toBe('tools:invoke tools:list');
    expect((await run(mutate((s) => { s.Redeem.Scope = 'tools:list'; }))).refusal).toMatchObject({ stage: 'leg2', error: 'invalid_scope' });
    const none = await run(mutate((s) => { s.Redeem.Scope = ''; }));
    expect(none.leg2.decoded.claims.scope).toBe('tools:invoke');
  },
};

describe('one mutation test per editable field', () => {
  it('covers every field of the spec, and only those', () => {
    expect(Object.keys(MUTATIONS).sort()).toEqual([...FIELD_PATHS].sort());
  });
  it.each(Object.keys(MUTATIONS))('%s: changing it changes the behaviour', async (path) => {
    await MUTATIONS[path]();
  });
});

describe('applyPatch', () => {
  it('keeps a secret when it is omitted or empty, replaces it when given, clears it on null', () => {
    const cur = base();
    const keep = applyPatch(cur, { Exchange: { ClientSecret: '', Scope: 'tools:list' } });
    expect(keep.errors).toEqual([]);
    expect(keep.spec.Exchange.ClientSecret).toBe(cur.Exchange.ClientSecret);
    expect(applyPatch(cur, { Exchange: { ClientSecret: NEW } }).spec.Exchange.ClientSecret).toBe(NEW);
    expect(applyPatch(cur, { Exchange: { ClientSecret: null } }).spec.Exchange.ClientSecret).toBe('');
    expect(applyPatch(cur, { Redeem: { ClientSecret: null } }).spec.Redeem.ClientSecret).toBe('');
  });
  it('refuses bad edits and never echoes the value', () => {
    const typed = ['typed', 'value', '9f3a'].join('-').toUpperCase();
    for (const patch of [
      { Exchange: { ClientSecret: 'x' } }, { Exchange: { AuthMethod: typed } }, { Exchange: { TokenURL: typed } }, { Nope: 1 }, { Exchange: { Nope: 1 } }, { Exchange: { Scope: 5 } }, null, [],
    ]) {
      const { errors } = applyPatch(base(), patch);
      expect(errors.length).toBeGreaterThan(0);
      for (const e of errors) expect(JSON.stringify(e)).not.toContain(typed);
    }
  });
  it('accepts a valid full edit', () => {
    const { spec, errors } = applyPatch(base(), {
      Exchange: { Scope: 'tools:invoke', AuthMethod: 'client_secret_post' },
      Redeem: { Scope: 'tools:invoke' },
    });
    expect(errors).toEqual([]);
    expect(spec.Exchange.Scope).toBe('tools:invoke');
    expect(spec.Exchange.AuthMethod).toBe('client_secret_post');
  });
});

describe('the SSRF rule', () => {
  it('refuses non-https, credential-bearing and off-list URLs before any request', () => {
    expect(() => assertAllowedUrl('http://agentcore-target.mock.invalid/token')).toThrow(/https/);
    expect(() => assertAllowedUrl('https://user:pw@agentcore-target.mock.invalid/token')).toThrow(/credentials/);
    expect(() => assertAllowedUrl('https://elsewhere.mock.invalid/token')).toThrow(/allow-list/);
    expect(assertAllowedUrl('https://agentcore-target.mock.invalid/token').host).toBe('agentcore-target.mock.invalid');
  });
});

describe('every claim the screens make is listed once, with a source', () => {
  it('has no duplicate ids and every entry is tagged', async () => {
    const { CLAIMS } = await import('../agentcoreRedeem.js');
    const ids = CLAIMS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CLAIMS) expect(['lab reading', 'lab-invented']).toContain(c.tag);
  });
});
