import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createHandler } from '../src/app.js';
import { listen, mintAccessToken, rpc, startTestAs } from './helpers.js';

let as;
let mcp;
let resource;

beforeAll(async () => { as = await startTestAs(); });
afterAll(() => as.close());

async function startMcp() {
  mcp = await listen();
  resource = `${mcp.url}/mcp`;
  mcp.handler = createHandler({ asIssuer: as.issuer, asJwksUrl: as.jwksUrl, resource });
}
afterEach(() => mcp?.close());

const token = (scope = 'read mcp:invoke', extra = {}) => mintAccessToken(as, { audience: resource, scope, ...extra });
const call = (name, args, tok) => rpc(mcp.url, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, tok);

describe('auth', () => {
  it('answers 401 with resource metadata when there is no token, and serves that metadata', async () => {
    await startMcp();
    const res = await rpc(mcp.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    const metadataUrl = `${mcp.url}/.well-known/oauth-protected-resource`;
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${metadataUrl}"`);

    const md = await (await fetch(metadataUrl)).json();
    expect(md).toEqual({
      resource, authorization_servers: [as.issuer], scopes_supported: ['read', 'mcp:invoke'], bearer_methods_supported: ['header'],
    });
    expect(await (await fetch(`${mcp.url}/.well-known/oauth-protected-resource/mcp`)).json()).toEqual(md);
  });

  it.each([
    ['wrong aud', { audience: 'https://other.example/mcp' }],
    ['expired', { expiresIn: -60 }],
    ['not an at+jwt', { typ: 'JWT' }],
    ['signed by another key', { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }],
  ])('refuses a token that is %s', async (_, extra) => {
    await startMcp();
    const res = await rpc(mcp.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, await token('read', extra));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer error="invalid_token", resource_metadata="/);
  });
});

describe('GET /protected/profile', () => {
  const profile = async (tok) => {
    const res = await fetch(`${mcp.url}/protected/profile`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    return { status: res.status, www: res.headers.get('www-authenticate'), body: await res.json() };
  };
  const failed = (body) => body.verified.find((v) => !v.ok)?.check;

  it('serves the profile for a good token, with every check it ran and who the token speaks for', async () => {
    await startMcp();
    const res = await profile(await token('read'));
    expect(res.status).toBe(200);
    expect(res.body.verified.map((v) => v.check)).toEqual(['bearer', 'token type', 'signature', 'expiry', 'issuer', 'audience', 'scope']);
    expect(res.body.verified.every((v) => v.ok)).toBe(true);
    expect(res.body.principal).toEqual({ sub: 'user-123', client_id: 'agent-1', scope: 'read' });
    expect(res.body.data).toMatchObject({ subject: 'user-123', profileId: expect.stringMatching(/^prf-[0-9a-f]{8}$/) });
  });

  it('refuses no token with 401, the resource metadata and the failed check', async () => {
    await startMcp();
    const res = await profile();
    expect(res.status).toBe(401);
    expect(res.www).toBe(`Bearer resource_metadata="${mcp.url}/.well-known/oauth-protected-resource"`);
    expect(res.body).toMatchObject({ error: 'invalid_request', verified: [{ check: 'bearer', ok: false }] });
  });

  it.each([
    ['an ID-JAG', { typ: 'oauth-id-jag+jwt' }, 'token type'],
    ['signed by another key', { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }, 'signature'],
    ['expired', { expiresIn: -60 }, 'expiry'],
    ['for another resource', { audience: 'https://other.example/mcp' }, 'audience'],
  ])('refuses %s with 401 invalid_token at that check', async (_, extra, check) => {
    await startMcp();
    const res = await profile(await token('read', extra));
    expect(res.status).toBe(401);
    expect(res.www).toMatch(/^Bearer error="invalid_token", resource_metadata="/);
    expect(failed(res.body)).toBe(check);
  });

  it('refuses a token without read with 403 insufficient_scope', async () => {
    await startMcp();
    const res = await profile(await token('mcp:invoke'));
    expect(res.status).toBe(403);
    expect(res.www).toMatch(/^Bearer error="insufficient_scope", scope="read", /);
    expect(failed(res.body)).toBe('scope');
  });
});

describe('MCP', () => {
  it('initializes and accepts the initialized notification', async () => {
    await startMcp();
    const tok = await token();
    const init = await rpc(mcp.url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }, tok);
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({
      jsonrpc: '2.0', id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'id-jag-mcp-sample' } },
    });
    const note = await rpc(mcp.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, tok);
    expect(note.status).toBe(202);
    expect(note.body).toBeUndefined();
  });

  it('lists only the tools the scope allows and names the rest in _meta.deniedTools', async () => {
    await startMcp();
    const res = await rpc(mcp.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, await token('read'));
    expect(res.body.result.tools.map((t) => t.name)).toEqual(['whoami']);
    expect(res.body.result.tools[0].inputSchema).toMatchObject({ type: 'object' });
    expect(res.body.result._meta.deniedTools).toEqual([
      { name: 'echo', requiredScope: 'mcp:invoke' },
      { name: 'server_time', requiredScope: 'mcp:invoke' },
    ]);
  });

  it('lists every tool for a fully scoped token', async () => {
    await startMcp();
    const res = await rpc(mcp.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, await token());
    expect(res.body.result.tools.map((t) => t.name)).toEqual(['whoami', 'echo', 'server_time']);
    expect(res.body.result._meta.deniedTools).toEqual([]);
  });

  it('whoami returns the token subject, client and scope', async () => {
    await startMcp();
    const res = await call('whoami', {}, await token('read'));
    expect(JSON.parse(res.body.result.content[0].text)).toEqual({ sub: 'user-123', client_id: 'agent-1', scope: 'read' });
  });

  it('echo and server_time work with mcp:invoke', async () => {
    await startMcp();
    const tok = await token('mcp:invoke');
    expect((await call('echo', { text: 'hello' }, tok)).body.result.content).toEqual([{ type: 'text', text: 'hello' }]);
    const time = (await call('server_time', {}, tok)).body.result.content[0].text;
    expect(Number.isNaN(Date.parse(time))).toBe(false);
  });

  it('refuses a call outside the token scope with insufficient_scope', async () => {
    await startMcp();
    const res = await call('echo', { text: 'hello' }, await token('read'));
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer error="insufficient_scope", scope="mcp:invoke", resource_metadata="/);
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 7, error: { message: 'insufficient_scope', data: { requiredScope: 'mcp:invoke' } } });
    expect(res.body.result).toBeUndefined();
  });

  it('reports bad echo input as a tool error', async () => {
    await startMcp();
    const res = await call('echo', {}, await token());
    expect(res.body.result.isError).toBe(true);
  });

  it('answers JSON-RPC errors for unknown tools, unknown methods and bad JSON', async () => {
    await startMcp();
    const tok = await token();
    expect((await call('nope', {}, tok)).body.error.code).toBe(-32602);
    expect((await rpc(mcp.url, { jsonrpc: '2.0', id: 3, method: 'resources/list' }, tok)).body.error.code).toBe(-32601);
    const bad = await rpc(mcp.url, '{not json', tok);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe(-32700);
  });

  it('has no SSE stream: GET /mcp is 405', async () => {
    await startMcp();
    expect((await fetch(`${mcp.url}/mcp`, { headers: { authorization: `Bearer ${await token()}` } })).status).toBe(405);
  });
});
