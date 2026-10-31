// The mock servers on their own, at protocol level: they must refuse what the real ones refuse, or the demo teaches the wrong thing.
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_IDS, MCP_RESOURCE, MOCK_USER, ORIGINS, SECRETS } from '../mock/env.js';
import { _dropMockWorld, mockAdminSend, mockFetch, setRegistrySource } from '../mock/index.js';

const ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag';
const REFRESH = 'urn:ietf:params:oauth:token-type:refresh_token';
const basic = (id, secret) => ({ Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` });
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
const post = (url, body, headers = {}) => mockFetch(url, { method: 'POST', body: typeof body === 'string' ? body : form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
const header = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url'));
const TOKEN = `${ORIGINS.pf}/as/token.oauth2`;
const EXCHANGE = basic(CLIENT_IDS.exchange, SECRETS.exchange);
const REDIRECT = 'http://app.test/cb';

/** The pi.flow sign-in as the app drives it; returns the code and what the token request must repeat. */
async function signIn({ origin = ORIGINS.pf, clientId = CLIENT_IDS.exchange, scope = 'openid profile email offline_access', password = MOCK_USER.password } = {}) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const url = new URL(`${origin}/as/authorization.oauth2`);
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope, state: 's1', nonce: 'n1',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', response_mode: 'pi.flow' }).toString();
  const start = await mockFetch(url.toString());
  const flow = await start.json();
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const creds = await mockFetch(`${origin}/pf-ws/authn/flows/${flow.id}`, {
    method: 'POST', headers: { 'X-XSRF-Header': 'PingFederate', Cookie: cookie, 'Content-Type': 'application/vnd.pingidentity.checkUsernamePassword+json' },
    body: JSON.stringify({ username: MOCK_USER.username, password }),
  });
  return { start, flow, creds, verifier, body: await creds.json() };
}

async function tokensFor({ scope = 'openid offline_access' } = {}) {
  const s = await signIn({ scope });
  const res = await post(TOKEN, { grant_type: 'authorization_code', code: s.body.authorizeResponse.code, redirect_uri: REDIRECT, code_verifier: s.verifier }, EXCHANGE);
  return res.json();
}

const exchange = (refresh, extra = {}, headers = EXCHANGE) => post(TOKEN, {
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', requested_token_type: ID_JAG, subject_token: refresh, subject_token_type: REFRESH,
  audience: ORIGINS.as, resource: MCP_RESOURCE, ...extra }, headers);

beforeEach(() => {
  _dropMockWorld();
  setRegistrySource(() => ({ idps: [{ id: 'pf-as', issuer: ORIGINS.pf, jwksUrl: `${ORIGINS.pf}/pf/JWKS`,
    clientAliases: { [CLIENT_IDS.exchange]: CLIENT_IDS.resourceAs, [CLIENT_IDS.resourceAs]: CLIENT_IDS.resourceAs }, scopes: '' }] }));
});

describe('mock PingFederate', () => {
  it('publishes discovery and one EC key marked mock', async () => {
    const d = await (await mockFetch(`${ORIGINS.pf}/.well-known/openid-configuration`)).json();
    expect(d).toMatchObject({ issuer: ORIGINS.pf, jwks_uri: `${ORIGINS.pf}/pf/JWKS` });
    const { keys } = await (await mockFetch(d.jwks_uri)).json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
    expect(keys[0].kid).toMatch(/^mock-/);
    expect(keys[0].d).toBeUndefined(); // the private key never leaves
  });

  it('labels every response as simulated', async () => {
    expect((await mockFetch(`${ORIGINS.pf}/pf/JWKS`)).headers.get('x-simulated')).toBe('mock');
    expect((await mockFetch(`${ORIGINS.pf}/nope`)).status).toBe(404);
  });

  it('has no redirect login: only pi.flow, with PKCE, for a known client', async () => {
    const base = { response_type: 'code', client_id: CLIENT_IDS.exchange, redirect_uri: REDIRECT, code_challenge: 'x', code_challenge_method: 'S256', response_mode: 'pi.flow' };
    const ask = (o) => mockFetch(`${ORIGINS.pf}/as/authorization.oauth2?${form({ ...base, ...o })}`);
    expect((await ask({})).status).toBe(200);
    expect((await ask({ response_mode: undefined })).status).toBe(400);
    expect((await ask({ response_mode: 'query' })).status).toBe(400);
    expect((await ask({ code_challenge_method: 'plain' })).status).toBe(400);
    expect((await ask({ client_id: 'nobody' })).status).toBe(400);
  });

  it('refuses a wrong password, a missing XSRF header and a flow cookie that is not the flow\'s', async () => {
    expect((await signIn({ password: 'wrong' })).creds.status).toBe(400);
    const open = async () => {
      const url = `${ORIGINS.pf}/as/authorization.oauth2?${form({ response_type: 'code', client_id: CLIENT_IDS.exchange, redirect_uri: REDIRECT, code_challenge: 'x', code_challenge_method: 'S256', response_mode: 'pi.flow' })}`;
      const res = await mockFetch(url);
      return { id: (await res.json()).id, cookie: res.headers.get('set-cookie').split(';')[0] };
    };
    const login = (f, headers) => mockFetch(`${ORIGINS.pf}/pf-ws/authn/flows/${f.id}`, { method: 'POST', headers, body: JSON.stringify({ username: MOCK_USER.username, password: MOCK_USER.password }) });
    const a = await open();
    expect((await login(a, { Cookie: a.cookie })).status).toBe(403); // no X-XSRF-Header
    expect((await login(a, { 'X-XSRF-Header': 'PingFederate', Cookie: 'PF=not-the-cookie' })).status).toBe(403);
    expect((await login(a, { 'X-XSRF-Header': 'PingFederate' })).status).toBe(403); // no cookie at all
    expect((await login(a, { 'X-XSRF-Header': 'PingFederate', Cookie: a.cookie })).status).toBe(200); // the right one still works
    expect((await login(a, { 'X-XSRF-Header': 'PingFederate', Cookie: a.cookie })).status).toBe(404); // a flow completes once
    expect((await login({ id: 'no-such-flow' }, {})).status).toBe(404);
  });

  it('redeems an authorization code once, with the right secret, redirect URI and verifier', async () => {
    const s = await signIn();
    const code = s.body.authorizeResponse.code;
    const args = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: s.verifier };
    expect((await post(TOKEN, args, basic(CLIENT_IDS.exchange, 'wrong'))).status).toBe(401);
    // the failed attempt above burned nothing, but a wrong verifier does: a code is single use
    expect((await post(TOKEN, { ...args, code_verifier: 'not-the-verifier' }, EXCHANGE)).status).toBe(400);
    expect((await post(TOKEN, args, EXCHANGE)).status).toBe(400);
    const s2 = await signIn();
    expect((await post(TOKEN, { ...args, code: s2.body.authorizeResponse.code, code_verifier: s2.verifier, redirect_uri: 'http://app.test/other' }, EXCHANGE)).status).toBe(400);
    const s3 = await signIn();
    const ok = await post(TOKEN, { ...args, code: s3.body.authorizeResponse.code, code_verifier: s3.verifier }, EXCHANGE);
    expect(ok.status).toBe(200);
    const t = await ok.json();
    expect(decode(t.id_token)).toMatchObject({ iss: ORIGINS.pf, aud: CLIENT_IDS.exchange, nonce: 'n1', email: MOCK_USER.username, email_verified: true, mock: true });
    expect(header(t.id_token).kid).toMatch(/^mock-/);
    expect(t.refresh_token).toMatch(/^mock-rt-/);
  });

  it('issues a refresh token only for offline_access, and an ID token only for openid', async () => {
    const t = await tokensFor({ scope: 'profile' });
    expect(t.refresh_token).toBeUndefined();
    expect(t.id_token).toBeUndefined();
    expect(t.access_token).toBeTruthy();
  });

  it('exchanges a refresh token for an ID-JAG with the draft\'s claims, short lived, scope never widened', async () => {
    const { refresh_token: rt } = await tokensFor();
    const res = await exchange(rt, { scope: 'read admin:everything' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ issued_token_type: ID_JAG, token_type: 'N_A', expires_in: 300, scope: 'read' });
    expect(header(body.access_token)).toMatchObject({ typ: 'oauth-id-jag+jwt', alg: 'ES256' });
    const c = decode(body.access_token);
    expect(c).toMatchObject({ iss: ORIGINS.pf, sub: MOCK_USER.username, aud: ORIGINS.as, client_id: CLIENT_IDS.resourceAs, resource: MCP_RESOURCE, scope: 'read', mock: true });
    expect(c.exp - c.iat).toBe(300);
    expect(c.jti).toBeTruthy();
  });

  it('refuses an exchange with another client\'s refresh token, a revoked one, a bad audience or request, and a scope it cannot grant', async () => {
    const { refresh_token: rt } = await tokensFor();
    const otherClient = basic(CLIENT_IDS.redeemer, SECRETS.redeemer);
    expect(await (await exchange(rt, {}, otherClient)).json()).toMatchObject({ error: 'invalid_request' });
    expect(await (await exchange(rt, { audience: undefined })).json()).toMatchObject({ error: 'invalid_request' });
    expect(await (await exchange(rt, { requested_token_type: 'urn:ietf:params:oauth:token-type:access_token' })).json()).toMatchObject({ error: 'invalid_request' });
    expect(await (await exchange(rt, { scope: 'admin:everything' })).json()).toMatchObject({ error: 'invalid_scope' });
    expect(await (await exchange('mock-rt-unknown')).json()).toMatchObject({ error: 'invalid_request' });
    expect((await exchange(rt, {}, basic(CLIENT_IDS.exchange, 'wrong'))).status).toBe(401);
    const revoke = await post(`${ORIGINS.pf}/as/revoke_token.oauth2`, { token: rt, token_type_hint: 'refresh_token' }, EXCHANGE);
    expect(revoke.status).toBe(200);
    expect(await (await exchange(rt)).json()).toMatchObject({ error: 'invalid_request' });
    expect((await post(`${ORIGINS.pf}/as/revoke_token.oauth2`, { token: 'unknown' }, EXCHANGE)).status).toBe(200); // RFC 7009
  });

  it('serves the admin API slice pfAdmin uses, and refuses wrong credentials', async () => {
    const url = `${ORIGINS.pf}:9999/pf-admin-api/v1/passwordCredentialValidators/idJagKitPcv`;
    expect((await mockAdminSend(url, { method: 'GET', headers: { Authorization: 'Basic eDp5' } })).status).toBe(401);
    const good = { Authorization: `Basic ${Buffer.from(`mock-admin:${SECRETS.pfAdmin}`).toString('base64')}` };
    const got = await mockAdminSend(url, { method: 'GET', headers: good });
    expect(got.status).toBe(200);
    const users = got.body.configuration.tables.find((t) => t.name === 'Users');
    expect(users.rows).toHaveLength(1);
    // an empty Users table is refused, as the real PingFederate does (HTTP 422)
    const empty = structuredClone(got.body);
    empty.configuration.tables.find((t) => t.name === 'Users').rows = [];
    expect((await mockAdminSend(url, { method: 'PUT', headers: good, body: JSON.stringify(empty) })).status).toBe(422);
    expect((await mockAdminSend(`${ORIGINS.pf}:9999/pf-admin-api/v1/nothing`, { method: 'GET', headers: good })).status).toBe(404);
  });
});

describe('mock PingFederate as the redeemer (JWT bearer)', () => {
  const idJagFromAcme = async () => {
    const s = await signIn({ origin: ORIGINS.acme, clientId: CLIENT_IDS.acme, scope: 'offline_access' });
    const t = await (await post(`${ORIGINS.acme}/as/token.oauth2`, { grant_type: 'authorization_code', code: s.body.authorizeResponse.code, redirect_uri: REDIRECT, code_verifier: s.verifier }, basic(CLIENT_IDS.acme, SECRETS.acme))).json();
    const res = await post(`${ORIGINS.acme}/as/token.oauth2`, { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', requested_token_type: ID_JAG, subject_token: t.refresh_token, subject_token_type: REFRESH, audience: ORIGINS.pf, resource: MCP_RESOURCE }, basic(CLIENT_IDS.acme, SECRETS.acme));
    return (await res.json()).access_token;
  };
  const redeem = (assertion, extra = {}, headers = basic(CLIENT_IDS.redeemer, SECRETS.redeemer)) => post(TOKEN, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion, resource: MCP_RESOURCE, ...extra }, headers);

  it('accepts an Acme ID-JAG once and refuses the replay', async () => {
    const idJag = await idJagFromAcme();
    const ok = await redeem(idJag);
    expect(ok.status).toBe(200);
    expect(decode((await ok.json()).access_token)).toMatchObject({ iss: ORIGINS.pf, sub: MOCK_USER.username, aud: MCP_RESOURCE, mock: true });
    const again = await (await redeem(idJag)).json();
    expect(again).toMatchObject({ error: 'invalid_grant' });
    expect(again.error_description).toMatch(/replay/);
  });

  it('refuses an ID-JAG from an issuer it does not trust, a tampered one, the wrong client and its own ID-JAG', async () => {
    const idJag = await idJagFromAcme();
    const [h, p, sig] = idJag.split('.');
    expect(await (await redeem(`${h}.${p}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`)).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await (await redeem(idJag, {}, basic(CLIENT_IDS.exchange, SECRETS.exchange))).json()).toMatchObject({ error: 'invalid_grant' });
    // an ID-JAG PingFederate issued itself (aud = the resource AS, not PingFederate) is not for it to redeem, and it is not its own trusted issuer
    const { refresh_token: rt } = await tokensFor();
    const own = (await (await exchange(rt, { audience: ORIGINS.pf })).json()).access_token;
    expect(await (await redeem(own)).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await redeem('not-a-jwt')).status).toBe(400);
    expect((await redeem(idJag, {}, basic(CLIENT_IDS.redeemer, 'wrong'))).status).toBe(401);
  });
});

describe('mock resource AS', () => {
  const AS_TOKEN = `${ORIGINS.as}/token`;
  const AS_CLIENT = basic(CLIENT_IDS.resourceAs, SECRETS.resourceAs);
  const idJag = async (extra = {}) => {
    const { refresh_token: rt } = await tokensFor();
    return (await (await exchange(rt, extra)).json()).access_token;
  };
  const redeem = (assertion, extra = {}, headers = AS_CLIENT) => post(AS_TOKEN, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion, ...extra }, headers);

  it('publishes RFC 8414 metadata and only the JWT bearer grant', async () => {
    const m = await (await mockFetch(`${ORIGINS.as}/.well-known/oauth-authorization-server`)).json();
    expect(m).toMatchObject({ issuer: ORIGINS.as, token_endpoint: AS_TOKEN, grant_types_supported: ['urn:ietf:params:oauth:grant-type:jwt-bearer'] });
    expect(m.authorization_grant_profiles_supported).toEqual(['urn:ietf:params:oauth:grant-profile:id-jag']);
    expect((await mockFetch(`${ORIGINS.as}/authorize`)).status).toBe(400);
    expect(await (await post(AS_TOKEN, { grant_type: 'client_credentials' }, AS_CLIENT)).json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('redeems an ID-JAG for an access token bound to the one resource, and records the decision', async () => {
    const res = await redeem(await idJag());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(header(body.access_token)).toMatchObject({ typ: 'at+jwt', alg: 'ES256' });
    expect(decode(body.access_token)).toMatchObject({ iss: ORIGINS.as, aud: MCP_RESOURCE, client_id: CLIENT_IDS.resourceAs, scope: 'read mcp:invoke', mock: true });
    const { events } = await (await mockFetch(`${ORIGINS.as}/events`)).json();
    expect(events[0]).toMatchObject({ decision: 'accepted', client_id: CLIENT_IDS.resourceAs, scope: 'read mcp:invoke' });
    expect(events[0].sub).toMatch(/^a\*\*\*@/); // the subject is masked in the record
  });

  it.each([
    ['a wrong client secret', async () => redeem(await idJag(), {}, basic(CLIENT_IDS.resourceAs, 'wrong')), 401, 'invalid_client'],
    ['an unknown client', async () => redeem(await idJag(), {}, basic('someone-else', SECRETS.resourceAs)), 401, 'invalid_client'],
    ['no assertion', async () => redeem(undefined), 400, 'invalid_request'],
    ['a garbage assertion', async () => redeem('x.y.z'), 400, 'invalid_grant'],
    ['an ID-JAG for another resource', async () => redeem(await idJag({ resource: 'https://other.mock.invalid/mcp' })), 400, 'invalid_target'],
    ['an ID-JAG addressed to another AS', async () => redeem(await idJag({ audience: 'https://other-as.mock.invalid' })), 400, 'invalid_grant'],
    ['a scope the ID-JAG does not carry', async () => redeem(await idJag({ scope: 'read' }), { scope: 'mcp:invoke' }), 400, 'invalid_scope'],
  ])('refuses %s', async (_name, run, status, error) => {
    const res = await run();
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(error);
  });

  it('accepts a jti once, and refuses a tampered signature', async () => {
    const token = await idJag();
    expect((await redeem(token)).status).toBe(200);
    const again = await (await redeem(token)).json();
    expect(again).toMatchObject({ error: 'invalid_grant', error_description: expect.stringMatching(/replay/) });
    const fresh = await idJag();
    const [h, p, sig] = fresh.split('.');
    expect(await (await redeem(`${h}.${p}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`)).json()).toMatchObject({ error: 'invalid_grant' });
    const refusals = (await (await mockFetch(`${ORIGINS.as}/events`)).json()).events.filter((e) => e.decision === 'refused');
    expect(refusals.length).toBeGreaterThanOrEqual(2);
  });

  it('trusts only the IdPs the app registered: with an empty registry every ID-JAG is refused', async () => {
    const token = await idJag();
    setRegistrySource(() => ({ idps: [] }));
    expect(await (await redeem(token)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringMatching(/not trusted/) });
  });

  it('only reads keys of IdPs inside the simulation', async () => {
    const token = await idJag();
    setRegistrySource(() => ({ idps: [{ id: 'pf-as', issuer: ORIGINS.pf, jwksUrl: 'https://keys.real.example.com/jwks', clientAliases: { [CLIENT_IDS.resourceAs]: CLIENT_IDS.resourceAs }, scopes: '' }] }));
    const res = await (await redeem(token)).json();
    expect(res.error).toBe('invalid_grant');
    expect(res.error_description).toMatch(/outside the simulation/);
  });
});

describe('mock MCP server', () => {
  const MCP = `${ORIGINS.mcp}/mcp`;
  const rpc = (token, body) => mockFetch(MCP, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }), headers: token ? { Authorization: `Bearer ${token}` } : {} });
  async function accessToken(scope) {
    const { refresh_token: rt } = await tokensFor();
    const jag = (await (await exchange(rt, scope ? { scope } : {})).json()).access_token;
    return (await (await post(`${ORIGINS.as}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jag }, basic(CLIENT_IDS.resourceAs, SECRETS.resourceAs))).json()).access_token;
  }

  it('publishes protected-resource metadata naming the one AS it trusts', async () => {
    expect(await (await mockFetch(`${ORIGINS.mcp}/.well-known/oauth-protected-resource`)).json()).toMatchObject({ resource: MCP_RESOURCE, authorization_servers: [ORIGINS.as] });
  });

  it('asks for a bearer token, with the metadata URL in the challenge', async () => {
    const res = await rpc(null, { method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGINS.mcp}/.well-known/oauth-protected-resource"`);
  });

  it('refuses an ID-JAG used as an access token, naming why', async () => {
    const { refresh_token: rt } = await tokensFor();
    const jag = (await (await exchange(rt)).json()).access_token;
    const res = await rpc(jag, { method: 'tools/list' });
    expect(res.status).toBe(401);
    expect((await res.json()).error_description).toMatch(/ID-JAG/);
  });

  it('refuses a token that PingFederate (not the resource AS) signed', async () => {
    const t = await tokensFor();
    const res = await rpc(t.access_token, { method: 'tools/list' });
    expect(res.status).toBe(401);
    expect((await res.json()).error_description).toMatch(/does not verify|not the trusted/i);
  });

  it('lists and runs the tools the token\'s scope allows, and answers 403 insufficient_scope for the rest', async () => {
    const full = await accessToken();
    const list = (await (await rpc(full, { method: 'tools/list' })).json()).result;
    expect(list.tools.map((t) => t.name).sort()).toEqual(['echo', 'server_time', 'whoami']);
    const echo = await (await rpc(full, { method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' } } })).json();
    expect(echo.result.content[0].text).toBe('hello');
    const who = JSON.parse((await (await rpc(full, { method: 'tools/call', params: { name: 'whoami' } })).json()).result.content[0].text);
    expect(who).toMatchObject({ sub: MOCK_USER.username, client_id: CLIENT_IDS.resourceAs });

    const readOnly = await accessToken('read');
    const limited = (await (await rpc(readOnly, { method: 'tools/list' })).json()).result;
    expect(limited.tools.map((t) => t.name)).toEqual(['whoami']);
    expect(limited._meta.deniedTools.map((d) => d.name).sort()).toEqual(['echo', 'server_time']);
    const denied = await rpc(readOnly, { method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('www-authenticate')).toContain('insufficient_scope');
    expect((await denied.json()).error.data).toMatchObject({ tool: 'echo', requiredScope: 'mcp:invoke' });
  });

  it('serves the REST page behind the same checks', async () => {
    const token = await accessToken();
    const ok = await mockFetch(`${ORIGINS.mcp}/protected/profile`, { headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).verified.every((v) => v.ok)).toBe(true);
    expect((await mockFetch(`${ORIGINS.mcp}/protected/profile`)).status).toBe(401);
  });
});
