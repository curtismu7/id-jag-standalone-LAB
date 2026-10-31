// A tiny MCP server: Streamable HTTP transport answering with plain JSON (no
// SSE stream, no sessions), behind bearer tokens from resource-as.
// Hand-rolled JSON-RPC: four methods do not justify the SDK's dependency tree.
import { createHash } from 'node:crypto';
import * as jose from 'jose';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SCOPES = ['read', 'mcp:invoke'];
const MAX_BODY_BYTES = 1024 * 1024;
const noArgs = { type: 'object', properties: {}, additionalProperties: false };

const TOOLS = [
  {
    name: 'whoami',
    description: 'Who the access token speaks for: sub, client_id and scope.',
    inputSchema: noArgs,
    scope: 'read',
    run: (_, t) => JSON.stringify({ sub: t.sub, client_id: t.client_id, scope: t.scope }),
  },
  {
    name: 'echo',
    description: 'Returns the text it is given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    scope: 'mcp:invoke',
    run: (args) => args.text,
  },
  {
    name: 'server_time',
    description: 'The server clock, ISO 8601 UTC.',
    inputSchema: noArgs,
    scope: 'mcp:invoke',
    run: () => new Date().toISOString(),
  },
];

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error('body too large');
  }
  return body;
}

/** @param config { asIssuer, asJwksUrl, resource } — resource is this server's own URI (token aud). */
export function createHandler({ asIssuer, asJwksUrl, resource }) {
  const jwks = jose.createRemoteJWKSet(new URL(asJwksUrl));
  const metadataUrl = `${new URL(resource).origin}/.well-known/oauth-protected-resource`;
  const metadata = { resource, authorization_servers: [asIssuer], scopes_supported: SCOPES, bearer_methods_supported: ['header'] };
  const challenge = (params = '') => ({ 'www-authenticate': `Bearer ${params}resource_metadata="${metadataUrl}"` });

  /**
   * The bearer validation every protected path shares, one named check at a time so a refusal
   * can say which check failed. Stops at the first failure. Returns { verified, token } or
   * { verified, error, detail } (error = invalid_request when there is no token, else invalid_token).
   */
  async function checkBearer(authorization) {
    const verified = [];
    const pass = (check, detail) => verified.push({ check, ok: true, detail });
    const fail = (check, detail, error = 'invalid_token') => (verified.push({ check, ok: false, detail }), { verified, error, detail });
    const raw = /^Bearer\s+(\S+)$/i.exec(authorization || '')?.[1];
    if (!raw) return fail('bearer', 'No Authorization: Bearer header.', 'invalid_request');
    pass('bearer', 'Authorization: Bearer present.');
    let header;
    try { header = jose.decodeProtectedHeader(raw); } catch { return fail('token type', 'Not a JWT.'); }
    const typ = String(header.typ || '').toLowerCase().replace(/^application\//, '');
    if (typ === 'oauth-id-jag+jwt') {
      return fail('token type', 'This is an ID-JAG (typ oauth-id-jag+jwt): a grant for the authorization server to redeem, never an access token for a resource.');
    }
    if (typ !== 'at+jwt') return fail('token type', `typ is "${header.typ ?? '(none)'}", not at+jwt.`);
    pass('token type', 'JWT access token (typ at+jwt), not an ID-JAG.');
    let token;
    try {
      ({ payload: token } = await jose.jwtVerify(raw, jwks, { algorithms: ['RS256'], requiredClaims: ['exp'] }));
    } catch (err) {
      if (err.code === 'ERR_JWT_EXPIRED') return fail('expiry', `It expired: ${err.message}.`);
      return fail('signature', `Does not verify against ${asJwksUrl}: ${err.message}.`);
    }
    pass('signature', `Verified against the authorization server's keys (${asJwksUrl}).`);
    pass('expiry', `${token.exp - Math.floor(Date.now() / 1000)} s left.`);
    if (token.iss !== asIssuer) return fail('issuer', `iss "${token.iss}" is not the trusted authorization server ${asIssuer}.`);
    pass('issuer', `iss ${asIssuer} is trusted.`);
    const aud = [token.aud].flat();
    if (!aud.includes(resource)) return fail('audience', `aud ${JSON.stringify(token.aud)} is not this resource server (${resource}).`);
    pass('audience', `aud "${resource}" is this resource server.`);
    return { verified, token };
  }

  function dispatch(msg, token) {
    const granted = new Set((typeof token.scope === 'string' ? token.scope : '').split(' '));
    const params = msg.params ?? {};
    switch (msg.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'id-jag-mcp-sample', version: '0.1.0' },
          },
        };
      case 'ping':
        return { result: {} };
      case 'tools/list':
        return {
          result: {
            tools: TOOLS.filter((t) => granted.has(t.scope)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
            _meta: { deniedTools: TOOLS.filter((t) => !granted.has(t.scope)).map((t) => ({ name: t.name, requiredScope: t.scope })) },
          },
        };
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return { error: { code: -32602, message: `Unknown tool: ${params.name}` } };
        if (!granted.has(tool.scope)) {
          return {
            status: 403,
            headers: challenge(`error="insufficient_scope", scope="${tool.scope}", `),
            error: { code: -32003, message: 'insufficient_scope', data: { tool: tool.name, requiredScope: tool.scope } },
          };
        }
        const args = params.arguments ?? {};
        if (tool.name === 'echo' && typeof args.text !== 'string') {
          return { result: { content: [{ type: 'text', text: 'echo needs a string "text" argument' }], isError: true } };
        }
        return { result: { content: [{ type: 'text', text: tool.run(args, token) }] } };
      }
      default:
        return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  }

  /** A plain REST page behind the same bearer validation as the tools, for the playground's "protected resource" step. */
  async function profile(req, res) {
    const page = `${new URL(resource).origin}/protected/profile`;
    const auth = await checkBearer(req.headers.authorization);
    if (auth.error) {
      const params = auth.error === 'invalid_token' ? 'error="invalid_token", ' : '';
      return send(res, 401, { resource: page, error: auth.error, error_description: auth.detail, verified: auth.verified }, challenge(params));
    }
    const { token, verified } = auth;
    const scope = typeof token.scope === 'string' ? token.scope : '';
    if (!scope.split(' ').includes('read')) {
      verified.push({ check: 'scope', ok: false, detail: `Needs read; the token has "${scope}".` });
      return send(res, 403, { resource: page, error: 'insufficient_scope', error_description: 'read scope required', verified },
        challenge('error="insufficient_scope", scope="read", '));
    }
    verified.push({ check: 'scope', ok: true, detail: 'Has read.' });
    send(res, 200, {
      resource: page,
      verified,
      principal: { sub: token.sub, client_id: token.client_id ?? null, scope },
      data: { subject: token.sub, profileId: `prf-${createHash('sha256').update(String(token.sub)).digest('hex').slice(0, 8)}`,
        status: 'active', servedBy: 'id-jag-mcp-sample', servedAt: new Date().toISOString() },
    });
  }

  return async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname.startsWith('/.well-known/oauth-protected-resource')) return send(res, 200, metadata);
    if (pathname === '/protected/profile' && req.method === 'GET') return profile(req, res);
    if (pathname !== '/mcp') return send(res, 404, { error: 'not_found' });

    const auth = await checkBearer(req.headers.authorization);
    if (auth.error === 'invalid_request') return send(res, 401, { error: 'invalid_request', error_description: 'bearer token required' }, challenge());
    if (auth.error) return send(res, 401, { error: 'invalid_token', error_description: auth.detail }, challenge('error="invalid_token", '));
    const { token } = auth;
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });

    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    if (msg.id === undefined) { // notification, or a response to us: nothing to answer
      res.writeHead(202).end();
      return;
    }
    const { status = 200, headers, result, error } = dispatch(msg, token);
    send(res, status, { jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) }, headers);
  };
}
