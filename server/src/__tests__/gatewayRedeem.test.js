// Gateway redeem, engine level: the two legs, the ten scenarios, the SSRF rule, and one mutation test per editable spec field.
import { describe, expect, it, vi } from 'vitest';
import { FIELD_PATHS, SCENARIOS, TOKEN_TYPES, assertAllowedUrl, gatewayCall, applyPatch, runScenario } from '../gatewayRedeem.js';
import { API_AUDIENCE, CALLER_CLIENT_ID, CALLER_USER, GATEWAY_RESOURCE } from '../mock/gatewayWorld.js';
import { createEcKey, now, sign } from '../mock/util.js';
import { ORIGINS } from '../mock/env.js';
import { gatewayWorld } from '../mock/index.js';
import { netguard } from '../outbound.js';
import { expectNoRealCalls, useMockMode } from './mockHelpers.js';

const state = useMockMode();
const base = () => gatewayWorld().defaults();
const mutate = (fn) => { const s = base(); fn(s.OBO); return s; };
const run = (spec, id = 'happy') => runScenario(id, spec);
const second = () => gatewayWorld()._otherKey();
const NEW = ['a', 'new', 'value', '1'].join('-');
const WRONG = ['wrong', 'value', 'for', 'a', 'test', '1234'].join('-'); // built here so no scanner reads it as a secret

describe('the two legs', () => {
  it('leg 1 gives an ID-JAG addressed to the Resource, for the user, acting for the calling client', async () => {
    const r = await run(base());
    expect(r.refusal).toBeNull();
    const { header, claims } = r.leg1.decoded;
    expect(header.typ).toBe('oauth-id-jag+jwt');
    expect(r.leg1.issuedTokenType).toBe(TOKEN_TYPES.idJag);
    expect(claims).toMatchObject({ iss: ORIGINS.gwIdp, sub: CALLER_USER, aud: base().OBO.Resource, client_id: 'gateway-redeem', scope: 'ledger:read', act: { sub: CALLER_CLIENT_ID }, mock: true });
    expect(claims.exp - claims.iat).toBe(300);
  });

  it('leg 2 redeems it at the target issuer: the token names the user, is addressed to the target API, and the API accepts it', async () => {
    const r = await run(base());
    expect(r.redeemed).toBe(true);
    expect(r.leg2.decoded.claims).toMatchObject({ iss: ORIGINS.gwTarget, sub: CALLER_USER, aud: API_AUDIENCE, client_id: 'gateway-redeem', scope: 'ledger:read', act: { sub: CALLER_CLIENT_ID } });
    expect(r.target.status).toBe(200);
    expect(r.target.body.principal).toMatchObject({ sub: CALLER_USER, client_id: 'gateway-redeem' });
    expect(r.target.body.data.entries).toHaveLength(3);
    expect(r.verdict.pass).toBe(true);
  });

  it("the target API rejects the caller's original token and the raw assertion, each naming the check that failed", async () => {
    const r = await run(base());
    expect(r.controls).toHaveLength(2);
    expect(r.controls[0]).toMatchObject({ status: 401, failedCheck: 'signature' });
    expect(r.controls[1]).toMatchObject({ status: 401, failedCheck: 'token type' });
    expect(r.callerToken.token).not.toBe(r.leg2.token);
    expect(r.leg2.token).not.toBe(r.leg1.token);
  });

  it('every hop carries a W3C traceparent on one trace, and nothing real was called', async () => {
    const r = await run(base());
    expect(r.hops.length).toBeGreaterThanOrEqual(5);
    for (const h of r.hops) expect(h.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(new Set(r.hops.map((h) => h.traceparent.split('-')[1])).size).toBe(1);
    expect(new Set(r.hops.map((h) => h.traceparent.split('-')[2])).size).toBeGreaterThan(1);
    expectNoRealCalls(state);
  });

  it('every call the gateway makes is allow-listed, sent with redirect: error and the traceparent', async () => {
    const spy = vi.spyOn(netguard, 'fetch');
    await run(base());
    const posts = spy.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const [url, init] of spy.mock.calls) {
      expect(init.redirect).toBe('error');
      expect(init.headers.traceparent).toMatch(/^00-/);
      expect(gatewayWorld().allowedOrigins.concat(ORIGINS.gwApi)).toContain(new URL(url).origin);
    }
    spy.mockRestore();
  });

  it('the values shown as results come from the run: a different caller gives a different sub', async () => {
    const world = gatewayWorld();
    const ctx = { hops: [], traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', allowed: world.allowedOrigins };
    const out = await gatewayCall(ctx, base(), await world.callerToken({ sub: 'bob@mock.example' }));
    expect(out.leg2.decoded.claims.sub).toBe('bob@mock.example');
    expect(out.target.body.principal.sub).toBe('bob@mock.example');
    expect(out.target.body.data.entries[0].memo).toContain('bob@mock.example');
  });
});

describe('the gateway refuses a bad caller token', () => {
  const ctxFor = () => ({ hops: [], traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', allowed: gatewayWorld().allowedOrigins });
  it.each([
    ['none', undefined],
    ['not a JWT', 'abc'],
    ['expired', async (w) => w.callerToken({ ttl: -600 })],
  ])('%s', async (_n, token) => {
    const w = gatewayWorld();
    const t = typeof token === 'function' ? await token(w) : token;
    const out = await gatewayCall(ctxFor(), base(), t);
    expect(out.refusal).toMatchObject({ stage: 'caller', error: 'invalid_token' });
    expect(out.leg1).toBeNull();
  });

  it('a token signed by another key, and a token for another audience', async () => {
    const w = gatewayWorld();
    const key = createEcKey('stranger-1');
    const t = now();
    const claims = { iss: ORIGINS.gwIdp, sub: CALLER_USER, aud: GATEWAY_RESOURCE, client_id: CALLER_CLIENT_ID, scope: 'ledger:read', iat: t, exp: t + 600 };
    const forged = await sign(key, { typ: 'at+jwt' }, claims);
    expect((await gatewayCall(ctxFor(), base(), forged)).refusal).toMatchObject({ stage: 'caller', error: 'invalid_token' });
    const wrongAud = await sign(w.company.key, { typ: 'at+jwt' }, { ...claims, aud: 'https://elsewhere.mock.invalid/mcp' });
    expect((await gatewayCall(ctxFor(), base(), wrongAud)).refusal).toMatchObject({ stage: 'caller', error: 'invalid_token' });
  });
});

describe('scenarios: each refusal, with the stage and the check that refused', () => {
  it.each(Object.keys(SCENARIOS))('%s behaves as it says', async (id) => {
    const r = await run(base(), id);
    expect(r.verdict.checks.length).toBeGreaterThan(0);
    expect(r.verdict, JSON.stringify(r.verdict)).toMatchObject({ pass: true });
  });

  it('no Redeem.TokenURL: the exchange result is returned unredeemed and the target rejects it', async () => {
    const r = await run(base(), 'no-redeem');
    expect(r.redeemed).toBe(false);
    expect(r.leg2).toBeNull();
    expect(r.backendToken).toBe(r.leg1.token);
    expect(r.target.status).toBe(401);
    expect(r.refusal).toMatchObject({ stage: 'target', check: 'token type' });
  });

  it('untrusted issuer, wrong audience, expired and bad signature are refused at leg 2 with no token', async () => {
    for (const [id, check] of [['untrusted-issuer', 'issuer'], ['wrong-audience', 'audience'], ['expired', 'expiry'], ['bad-signature', 'signature']]) {
      const r = await run(base(), id);
      expect(r.refusal, id).toMatchObject({ stage: 'leg2', error: 'invalid_grant', check });
      expect(r.leg2, id).toBeNull();
      expect(r.target, id).toBeNull();
    }
  });

  it('replay: the second redemption of the same assertion is refused', async () => {
    const r = await run(base(), 'replay');
    expect(r.redeemed).toBe(true);
    expect(r.replay).toMatchObject({ attempted: true, accepted: false });
    expect(r.replay.refusal).toMatchObject({ error: 'invalid_grant', check: 'replay' });
  });

  it('ssrf: a host that is not allow-listed gets no request; a redirect is not followed', async () => {
    const before = netguard.stats();
    const r = await run(base(), 'ssrf');
    expect(r.refusal).toMatchObject({ stage: 'leg2', kind: 'ssrf' });
    const blocked = r.hops.find((h) => h.blocked);
    expect(blocked.blocked.kind).toBe('ssrf');
    expect(blocked.status).toBeUndefined();
    expect(netguard.stats().refused).toBe(before.refused); // refused by the gateway, never reached the guard
    const red = await run(base(), 'redirect');
    expect(red.refusal).toMatchObject({ stage: 'leg2', kind: 'redirect' });
    expect(red.hops.find((h) => h.blocked).status).toBe(302);
  });

  it('client authentication method mismatch is refused by the issuer, naming the check', async () => {
    const r = await run(base(), 'auth-method');
    expect(r.refusal).toMatchObject({ stage: 'leg2', error: 'invalid_client', check: 'client authentication method' });
    expect(r.refusal.description).toMatch(/client_secret_post or private_key_jwt/);
  });
});

describe('assertAllowedUrl', () => {
  it.each([
    ['http scheme', 'http://target-idp.mock.invalid/token'],
    ['not on the list (another mock host)', `${ORIGINS.pf}/as/token.oauth2`],
    ['cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'https://127.0.0.1/token'],
    ['localhost', 'https://localhost/token'],
    ['credentials in the URL', 'https://user:pass@target-idp.mock.invalid/token'],
    ['userinfo trick', 'https://target-idp.mock.invalid@evil.example/token'],
    ['suffix trick', 'https://target-idp.mock.invalid.evil.example/token'],
    ['other port', 'https://target-idp.mock.invalid:8443/token'],
    ['not a URL', 'target-idp.mock.invalid/token'],
    ['file scheme', 'file:///etc/passwd'],
  ])('refuses %s', (_n, url) => {
    expect(() => assertAllowedUrl(url)).toThrow();
  });
  it.each([['exchange issuer', `${ORIGINS.gwIdp}/token`], ['partner issuer', `${ORIGINS.gwPartner}/token`], ['target issuer', `${ORIGINS.gwTarget}/token`]])('allows the %s', (_n, url) => {
    expect(() => assertAllowedUrl(url)).not.toThrow();
  });
});

// One mutation test per editable field: change the field and the behaviour changes. A field with no test fails the coverage check below.
const MUTATIONS = {
  'OBO.TokenURL': async () => {
    const partner = await run(mutate((o) => { o.TokenURL = `${ORIGINS.gwPartner}/token`; }));
    expect(partner.refusal).toMatchObject({ stage: 'leg2', check: 'issuer' });
    const away = await run(mutate((o) => { o.TokenURL = `${ORIGINS.pf}/as/token.oauth2`; }));
    expect(away.refusal).toMatchObject({ stage: 'leg1', kind: 'ssrf' });
  },
  'OBO.ClientID': async () => {
    expect((await run(mutate((o) => { o.ClientID = 'nobody'; }))).refusal).toMatchObject({ stage: 'leg1', error: 'invalid_client' });
  },
  'OBO.ClientSecret': async () => {
    expect((await run(mutate((o) => { o.ClientSecret = WRONG; }))).refusal).toMatchObject({ stage: 'leg1', error: 'invalid_client' });
    expect((await run(mutate((o) => { o.ClientSecret = ''; }))).refusal).toMatchObject({ stage: 'leg1', kind: 'config' });
  },
  'OBO.AuthMethod': async () => {
    const used = async (m) => { const r = await run(mutate((o) => { o.AuthMethod = m; })); expect(r.refusal, m).toBeNull(); return gatewayWorld().company.events.list()[0].method; };
    expect(await used('client_secret_basic')).toBe('client_secret_basic');
    expect(await used('client_secret_post')).toBe('client_secret_post');
    expect(await used('private_key_jwt')).toBe('private_key_jwt');
    expect((await run(mutate((o) => { o.AuthMethod = 'none'; }))).refusal).toMatchObject({ stage: 'leg1', kind: 'config' });
  },
  'OBO.Resource': async () => {
    const other = await run(mutate((o) => { o.Resource = 'https://other-app.mock.invalid'; }));
    expect(other.leg1.decoded.claims.aud).toBe('https://other-app.mock.invalid');
    expect(other.refusal).toMatchObject({ stage: 'leg2', check: 'audience' });
    expect((await run(mutate((o) => { o.Resource = ''; }))).refusal).toMatchObject({ stage: 'leg1', error: 'invalid_target' });
  },
  'OBO.Scope': async () => {
    const wide = await run(mutate((o) => { o.Scope = ''; }));
    expect(wide.leg1.decoded.claims.scope).toBe('ledger:read ledger:write');
    expect(wide.leg2.decoded.claims.scope).toBe('ledger:read'); // narrowed by Redeem.Scope
    const write = await run(mutate((o) => { o.Scope = 'ledger:write'; }));
    expect(write.refusal).toMatchObject({ stage: 'leg2', error: 'invalid_scope' });
    expect((await run(mutate((o) => { o.Scope = 'ledger:admin'; }))).refusal).toMatchObject({ stage: 'leg1', error: 'invalid_scope' });
  },
  'OBO.PrivateKeyPEM': async () => {
    const ok = await run(mutate((o) => { o.AuthMethod = 'private_key_jwt'; }));
    expect(ok.refusal).toBeNull();
    const wrong = await run(mutate((o) => { o.AuthMethod = 'private_key_jwt'; o.PrivateKeyPEM = second().pem; }));
    expect(wrong.refusal).toMatchObject({ stage: 'leg1', error: 'invalid_client', check: 'client assertion' });
  },
  'OBO.KeyID': async () => {
    const r = await run(mutate((o) => { o.AuthMethod = 'private_key_jwt'; o.KeyID = 'some-other-kid'; }));
    expect(r.refusal).toMatchObject({ stage: 'leg1', error: 'invalid_client', check: 'client assertion' });
  },
  'OBO.SubjectTokenType': async () => {
    expect((await run(mutate((o) => { o.SubjectTokenType = TOKEN_TYPES.jwt; }))).refusal).toBeNull();
    expect((await run(mutate((o) => { o.SubjectTokenType = 'urn:ietf:params:oauth:token-type:refresh_token'; }))).refusal).toMatchObject({ stage: 'leg1', error: 'invalid_request', check: 'subject_token_type' });
  },
  'OBO.RequestedTokenType': async () => {
    const r = await run(mutate((o) => { o.RequestedTokenType = TOKEN_TYPES.accessToken; }));
    expect(r.leg1.issuedTokenType).toBe(TOKEN_TYPES.accessToken);
    expect(r.refusal).toMatchObject({ stage: 'leg2', error: 'invalid_grant' }); // an access token is not an ID-JAG
    expect((await run(mutate((o) => { o.RequestedTokenType = 'urn:example:other'; }))).refusal).toMatchObject({ stage: 'leg1', check: 'requested_token_type' });
  },
  'OBO.Redeem': async () => {
    const none = await run(mutate((o) => { o.Redeem = null; }));
    expect(none).toMatchObject({ redeemed: false, leg2: null });
    expect(none.target.status).toBe(401);
  },
  'OBO.Redeem.TokenURL': async () => {
    const none = await run(mutate((o) => { o.Redeem.TokenURL = ''; }));
    expect(none).toMatchObject({ redeemed: false });
    expect(none.target.status).toBe(401);
    expect((await run(mutate((o) => { o.Redeem.TokenURL = 'https://evil.example/token'; }))).refusal).toMatchObject({ stage: 'leg2', kind: 'ssrf' });
  },
  'OBO.Redeem.ClientID': async () => {
    expect((await run(mutate((o) => { o.Redeem.ClientID = 'nobody'; }))).refusal).toMatchObject({ stage: 'leg2', error: 'invalid_client' });
  },
  'OBO.Redeem.ClientSecret': async () => {
    expect((await run(mutate((o) => { o.Redeem.AuthMethod = 'client_secret_post'; }))).refusal).toBeNull();
    expect((await run(mutate((o) => { o.Redeem.AuthMethod = 'client_secret_post'; o.Redeem.ClientSecret = WRONG; }))).refusal).toMatchObject({ stage: 'leg2', error: 'invalid_client' });
  },
  'OBO.Redeem.AuthMethod': async () => {
    const r = await run(mutate((o) => { o.Redeem.AuthMethod = 'client_secret_post'; }));
    expect(r.refusal).toBeNull();
    expect(gatewayWorld().target.events.list()[0].method).toBe('client_secret_post');
    expect((await run(mutate((o) => { o.Redeem.AuthMethod = 'client_secret_basic'; }))).refusal).toMatchObject({ stage: 'leg2', error: 'invalid_client' });
  },
  'OBO.Redeem.Scope': async () => {
    const all = await run(mutate((o) => { o.Scope = ''; o.Redeem.Scope = ''; }));
    expect(all.leg2.decoded.claims.scope).toBe('ledger:read ledger:write');
    expect((await run(mutate((o) => { o.Redeem.Scope = 'ledger:write'; }))).refusal).toMatchObject({ stage: 'leg2', error: 'invalid_scope' });
    const none = await run(mutate((o) => { o.Redeem.Scope = ''; }));
    expect(none.leg2.decoded.claims.scope).toBe('ledger:read');
  },
  'OBO.Redeem.PrivateKeyPEM': async () => {
    expect((await run(mutate((o) => { o.Redeem.PrivateKeyPEM = second().pem; }))).refusal).toMatchObject({ stage: 'leg2', error: 'invalid_client', check: 'client assertion' });
    expect((await run(mutate((o) => { o.Redeem.PrivateKeyPEM = ''; }))).refusal).toMatchObject({ stage: 'leg2', kind: 'config' });
  },
  'OBO.Redeem.KeyID': async () => {
    expect((await run(mutate((o) => { o.Redeem.KeyID = 'some-other-kid'; }))).refusal).toMatchObject({ stage: 'leg2', error: 'invalid_client', check: 'client assertion' });
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
    const keep = applyPatch(cur, { OBO: { ClientSecret: '', Scope: 'ledger:read' } });
    expect(keep.errors).toEqual([]);
    expect(keep.spec.OBO.ClientSecret).toBe(cur.OBO.ClientSecret);
    expect(applyPatch(cur, { OBO: { ClientSecret: NEW } }).spec.OBO.ClientSecret).toBe(NEW);
    expect(applyPatch(cur, { OBO: { ClientSecret: null } }).spec.OBO.ClientSecret).toBe('');
  });
  it('refuses bad edits and never echoes the value', () => {
    const cur = base();
    const typed = ['typed', 'value', '9f3a'].join('-').toUpperCase();
    for (const patch of [
      { OBO: { ClientSecret: 'x' } }, { OBO: { PrivateKeyPEM: `-----BEGIN PRIVATE KEY-----\n${typed}\n-----END PRIVATE KEY-----` } },
      { OBO: { AuthMethod: typed } }, { OBO: { TokenURL: typed } }, { OBO: { Nope: 1 } }, { Other: 1 }, { OBO: { Redeem: { TokenURL: 5 } } }, null, [],
    ]) {
      const { spec, errors } = applyPatch(cur, patch);
      expect(errors.length, JSON.stringify(patch)).toBeGreaterThan(0);
      expect(spec).toBe(cur);
      expect(JSON.stringify(errors)).not.toContain(typed);
    }
  });
  it('a first Redeem edit starts from an empty leg', () => {
    const cur = base(); cur.OBO.Redeem = null;
    const { spec, errors } = applyPatch(cur, { OBO: { Redeem: { TokenURL: `${ORIGINS.gwTarget}/token` } } });
    expect(errors).toEqual([]);
    expect(spec.OBO.Redeem).toMatchObject({ TokenURL: `${ORIGINS.gwTarget}/token`, ClientID: '', AuthMethod: 'client_secret_post' });
  });
});
