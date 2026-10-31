// A mock MCP server, in process, with the tools and the bearer checks of mcp-sample/: protected-resource metadata
// (RFC 9728), JSON-RPC at /mcp and a REST page at /protected/profile. It accepts an access token from the mock resource
// AS only: a different issuer, a wrong audience, an expired token or an ID-JAG is refused, naming the check that failed.

import { createHash } from 'node:crypto';
import * as jose from 'jose';
import { json, parseRequest } from './util.js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SCOPES = ['read', 'mcp:invoke'];
const noArgs = { type: 'object', properties: {}, additionalProperties: false };

const TOOLS = [
  { name: 'whoami', description: 'Who the access token speaks for: sub, client_id and scope.', inputSchema: noArgs, scope: 'read',
    run: (_, t) => JSON.stringify({ sub: t.sub, client_id: t.client_id, scope: t.scope }) },
  { name: 'echo', description: 'Returns the text it is given.', scope: 'mcp:invoke', run: (args) => args.text,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'server_time', description: 'The server clock, ISO 8601 UTC.', inputSchema: noArgs, scope: 'mcp:invoke', run: () => new Date().toISOString() },
];

/**
 * @param o.origin     this server's origin
 * @param o.asIssuer   the one authorization server it trusts
 * @param o.asKey      that server's public key (verification happens here, not by asking it)
 * @param o.resource   this server's resource identifier (the token's aud)
 */
export function createMockMcp({ origin, asIssuer, asKey, resource }) {
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
  const metadata = { resource, authorization_servers: [asIssuer], scopes_supported: SCOPES, bearer_methods_supported: ['header'] };
  const challenge = (params = '') => ({ 'www-authenticate': `Bearer ${params}resource_metadata="${metadataUrl}"` });

  async function checkBearer(authorization) {
    const verified = [];
    const pass = (check, detail) => verified.push({ check, ok: true, detail });
    const fail = (check, detail, error = 'invalid_token') => { verified.push({ check, ok: false, detail }); return { verified, error, detail }; };
    const raw = /^Bearer\s+(\S+)$/i.exec(authorization || '')?.[1];
    if (!raw) return fail('bearer', 'No Authorization: Bearer header.', 'invalid_request');
    pass('bearer', 'Authorization: Bearer present.');
    let header;
    try { header = jose.decodeProtectedHeader(raw); } catch { return fail('token type', 'Not a JWT.'); }
    const typ = String(header.typ || '').toLowerCase().replace(/^application\//, '');
    if (typ === 'oauth-id-jag+jwt') return fail('token type', 'This is an ID-JAG (typ oauth-id-jag+jwt): a grant for the authorization server to redeem, never an access token for a resource.');
    if (typ !== 'at+jwt') return fail('token type', `typ is "${header.typ ?? '(none)'}", not at+jwt.`);
    pass('token type', 'JWT access token (typ at+jwt), not an ID-JAG.');
    let token;
    try {
      ({ payload: token } = await jose.jwtVerify(raw, asKey, { algorithms: ['ES256'], requiredClaims: ['exp'] }));
    } catch (err) {
      if (err.code === 'ERR_JWT_EXPIRED') return fail('expiry', `It expired: ${err.message}.`);
      return fail('signature', `Does not verify against the authorization server's keys: ${err.message}.`);
    }
    pass('signature', "Verified against the authorization server's keys.");
    pass('expiry', `${token.exp - Math.floor(Date.now() / 1000)} s left.`);
    if (token.iss !== asIssuer) return fail('issuer', `iss "${token.iss}" is not the trusted authorization server ${asIssuer}.`);
    pass('issuer', `iss ${asIssuer} is trusted.`);
    if (![token.aud].flat().includes(resource)) return fail('audience', `aud ${JSON.stringify(token.aud)} is not this resource server (${resource}).`);
    pass('audience', `aud "${resource}" is this resource server.`);
    return { verified, token };
  }

  function dispatch(msg, token) {
    const granted = new Set(String(token.scope || '').split(' '));
    const params = msg.params ?? {};
    switch (msg.method) {
      case 'initialize':
        return { result: { protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'id-jag-mock-mcp', version: '0.1.0' } } };
      case 'ping': return { result: {} };
      case 'tools/list':
        return { result: {
          tools: TOOLS.filter((t) => granted.has(t.scope)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          _meta: { deniedTools: TOOLS.filter((t) => !granted.has(t.scope)).map((t) => ({ name: t.name, requiredScope: t.scope })) },
        } };
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return { error: { code: -32602, message: `Unknown tool: ${params.name}` } };
        if (!granted.has(tool.scope)) {
          return { status: 403, headers: challenge(`error="insufficient_scope", scope="${tool.scope}", `),
            error: { code: -32003, message: 'insufficient_scope', data: { tool: tool.name, requiredScope: tool.scope } } };
        }
        const args = params.arguments ?? {};
        if (tool.name === 'echo' && typeof args.text !== 'string') return { result: { content: [{ type: 'text', text: 'echo needs a string "text" argument' }], isError: true } };
        return { result: { content: [{ type: 'text', text: tool.run(args, token) }] } };
      }
      default: return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  }

  async function profile(req) {
    const page = `${origin}/protected/profile`;
    const auth = await checkBearer(req.headers.get('authorization'));
    if (auth.error) {
      return json(401, { resource: page, error: auth.error, error_description: auth.detail, verified: auth.verified }, challenge(auth.error === 'invalid_token' ? 'error="invalid_token", ' : ''));
    }
    const { token, verified } = auth;
    const scope = typeof token.scope === 'string' ? token.scope : '';
    if (!scope.split(' ').includes('read')) {
      verified.push({ check: 'scope', ok: false, detail: `Needs read; the token has "${scope}".` });
      return json(403, { resource: page, error: 'insufficient_scope', error_description: 'read scope required', verified }, challenge('error="insufficient_scope", scope="read", '));
    }
    verified.push({ check: 'scope', ok: true, detail: 'Has read.' });
    return json(200, { resource: page, verified, principal: { sub: token.sub, client_id: token.client_id ?? null, scope },
      data: { subject: token.sub, profileId: `prf-${createHash('sha256').update(String(token.sub)).digest('hex').slice(0, 8)}`, status: 'active', servedBy: 'id-jag-mock-mcp', servedAt: new Date().toISOString() } });
  }

  async function handle(url, init) {
    const req = parseRequest(url, init);
    if (req.method === 'GET' && req.path.startsWith('/.well-known/oauth-protected-resource')) return json(200, metadata);
    if (req.path === '/protected/profile' && req.method === 'GET') return profile(req);
    if (req.path !== '/mcp') return json(404, { error: 'not_found' });
    const auth = await checkBearer(req.headers.get('authorization'));
    if (auth.error === 'invalid_request') return json(401, { error: 'invalid_request', error_description: 'bearer token required' }, challenge());
    if (auth.error) return json(401, { error: 'invalid_token', error_description: auth.detail }, challenge('error="invalid_token", '));
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    let msg;
    try { msg = JSON.parse(req.body); } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const { status = 200, headers, result, error } = dispatch(msg, auth.token);
    return json(status, { jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) }, headers);
  }

  return { origin, handle };
}
