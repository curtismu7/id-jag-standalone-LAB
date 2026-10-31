// Custody guard: drive the whole pf-as flow through the real app (session cookie, sign-in callback,
// every step, preflight, negative tests) against mocked PingFederate, resource-as and mcp-sample, then
// assert that no JWT-shaped string and no configured secret appears in any API response or log line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { _clearProbeCache } from '../idJagPlayground.js';

const ORIGIN = 'http://app.test';
const PF = 'https://pf.test';
const AS = 'http://localhost:4721';
const RESOURCE = 'http://localhost:4722/mcp';
const MCP = 'http://mcp-sample:9090/mcp';
const SECRETS = {
  PF_EXCHANGE_CLIENT_SECRET: 'exchange-secret-value', RESOURCE_AS_CLIENT_SECRET: 'redeem-secret-value',
  ID_JAG_REGISTRY_TOKEN: 'registry-token-value', SESSION_SECRET: 'session-secret-value',
};
const REFRESH_TOKEN = 'refresh-token-value';
// A JWT header is base64url JSON, so it starts with eyJ: header.payload.signature.
const JWT_SHAPED = /eyJ[\w-]*\.[\w-]+\.[\w-]+/;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (header, claims) => `${b64(header)}.${b64(claims)}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
const now = () => Math.floor(Date.now() / 1000);
const ID_JAG = jwt({ alg: 'RS256', typ: 'oauth-id-jag+jwt', x5t: 't1' }, {
  iss: PF, sub: 'demouser', aud: AS, client_id: 'id-jag-playground', jti: 'j1', iat: now(), exp: now() + 300, resource: RESOURCE, scope: 'openid read mcp:invoke',
});
const ACCESS_TOKEN = jwt({ alg: 'RS256', typ: 'at+jwt' }, { iss: AS, sub: 'demouser', aud: RESOURCE, client_id: 'id-jag-playground', scope: 'read mcp:invoke', exp: now() + 3600 });
const ID_TOKEN = jwt({ alg: 'RS256' }, { iss: PF, sub: 'demouser' });

const reply = (status, data, headers = {}) => ({ status, json: async () => data, headers: new Headers(headers) });

/** Stand-ins for PingFederate, resource-as and mcp-sample, answering by URL. */
async function upstream(url, init = {}) {
  const u = String(url);
  const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
  if (u === `${PF}/.well-known/openid-configuration`) return reply(200, { issuer: PF });
  if (u === `${PF}/pf/JWKS`) return reply(200, { keys: [{ kty: 'RSA', n: 'bogus', e: 'AQAB', x5t: 't1', kid: 'k1' }] });
  if (u === `${PF}/as/token.oauth2` && form.get('grant_type') === 'authorization_code') {
    return reply(200, { access_token: ID_TOKEN, refresh_token: REFRESH_TOKEN, id_token: ID_TOKEN, token_type: 'Bearer' });
  }
  if (u === `${PF}/as/token.oauth2`) return reply(200, { access_token: ID_JAG, issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag', token_type: 'N_A' });
  if (u === 'http://resource-as:9080/token') {
    if (init.method !== 'POST') return reply(405, { error: 'invalid_request' });
    if (form.get('scope') === 'admin:delete') return reply(400, { error: 'invalid_scope', error_description: 'no scope' });
    return reply(200, { access_token: ACCESS_TOKEN, refresh_token: 'should-never-show', token_type: 'Bearer', expires_in: 3600, scope: 'read mcp:invoke' });
  }
  if (u === 'http://mcp-sample:9090/.well-known/oauth-protected-resource') return reply(200, { resource: RESOURCE, authorization_servers: [AS] });
  if (u === MCP) {
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'tools/list') return reply(200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }], _meta: { deniedTools: [] } } });
    return reply(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"sub":"demouser"}' }] } });
  }
  if (u === 'http://mcp-sample:9090/protected/profile') {
    return init.headers?.Authorization === `Bearer ${ACCESS_TOKEN}`
      ? reply(200, { verified: [{ check: 'bearer', ok: true, detail: 'ok' }], principal: { sub: 'demouser' }, data: { subject: 'demouser' } })
      : reply(401, { error: 'invalid_token', error_description: 'not an access token', verified: [] }, { 'www-authenticate': 'Bearer error="invalid_token"' });
  }
  throw new Error(`unexpected upstream call ${u}`);
}

let logs;
beforeEach(() => {
  Object.entries({ APP_ORIGIN: ORIGIN, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-')), PF_URL: PF, PF_EXCHANGE_CLIENT_ID: 'pf-exchange',
    RESOURCE_AS_ISSUER: AS, RESOURCE_AS_TOKEN_ENDPOINT: 'http://resource-as:9080/token', ID_JAG_RESOURCE: RESOURCE, MCP_URL: MCP, ...SECRETS })
    .forEach(([k, v]) => vi.stubEnv(k, v));
  vi.stubGlobal('fetch', vi.fn(upstream));
  _clearProbeCache();
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    vi.spyOn(console, level).mockImplementation((...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  }
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('a full pf-as run leaks no token or secret into any API response or log', async () => {
  const agent = request.agent(createApp());
  const seen = [];
  const keep = (res) => { seen.push(`${res.status} ${res.headers.location || ''} ${res.text}`); return res; };
  const API = '/api/id-jag-playground';
  const post = (p, body = {}) => agent.post(`${API}${p}`).set('Origin', ORIGIN).send(body).then(keep);
  const get = (p, headers = {}) => agent.get(`${API}${p}`).set(headers).then(keep);

  expect((await post('/mode', { mode: 'pf-as' })).body.mode).toBe('pf-as');
  fetch.mockImplementationOnce(async () => reply(200, { id: 'flow-123456', status: 'USERNAME_PASSWORD_REQUIRED' }));
  expect((await get('/issuer/pi-flow/start?return_to=/')).status).toBe(200);
  const state = new URL(fetch.mock.calls.find(([u]) => String(u).includes('response_mode=pi.flow'))[0]).searchParams.get('state');
  expect((await get(`/issuer/callback?code=c1&state=${state}`)).headers.location).toBe('/');

  const pre = (step, q = {}) => get(`/preflight?${new URLSearchParams({ step, mode: 'pf-as', origin: ORIGIN, ...q })}`);
  await get('/config');
  await pre('mode', { mode: 'pf-as' });
  await pre('signin');
  await pre('issue');
  expect((await post('/issue')).body.token.claims.sub).toBe('demouser');
  await post('/inspect');
  await pre('redeem', { scope: 'read' });
  await post('/redeem', { scope: 'admin:all' }); // refused by the scope guard
  const redeemed = await post('/redeem', { scope: 'read' });
  expect(redeemed.body.token.claims.aud).toBe(RESOURCE);
  await pre('call');
  expect((await post('/call')).body.tools[0].name).toBe('whoami');
  await post('/call', { tool: 'whoami', arguments: {} });
  for (const variant of ['token', 'no-token', 'id-jag']) {
    await pre('resource', { variant });
    await post('/resource', { variant });
  }
  await pre('negative');
  await get('/negative');
  for (const id of ['replay', 'bad-signature', 'client-mismatch', 'scope-not-granted']) await post(`/negative/${id}`);
  await get('/trusted-idps');
  await get('/trusted-idps/registry', { Authorization: `Bearer ${SECRETS.ID_JAG_REGISTRY_TOKEN}` });
  await post('/reset');

  expect(seen.length).toBe(30);
  const everything = [...seen, ...logs];
  for (const text of everything) {
    expect(text).not.toMatch(JWT_SHAPED);
    for (const secret of [...Object.values(SECRETS), REFRESH_TOKEN, 'should-never-show']) expect(text).not.toContain(secret);
  }
  // The guard itself works: the tokens the stand-ins handed out are JWT-shaped.
  for (const t of [ID_JAG, ACCESS_TOKEN, ID_TOKEN]) expect(t).toMatch(JWT_SHAPED);
  // A whole pf-as run takes about 0.5 s alone but can pass 5 s on a loaded runner, so give it room (the default timed out in CI).
}, 30_000);
