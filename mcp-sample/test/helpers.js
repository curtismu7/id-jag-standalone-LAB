// Test-only: ephemeral listener plus a stand-in authorization server that
// serves a JWKS and mints RFC 9068 access tokens.
import http from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import * as jose from 'jose';

/** Listen first, attach the handler later (it may need the URL). */
export async function listen(handler) {
  const srv = { handler };
  const server = http.createServer((req, res) => srv.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  srv.url = `http://127.0.0.1:${server.address().port}`;
  srv.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return srv;
}

export async function startTestAs(issuer = 'https://as.example.test') {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const { kty, n, e } = privateKey.export({ format: 'jwk' });
  const jwks = { keys: [{ kty, n, e, kid: 'as-key-1', alg: 'RS256', use: 'sig' }] };
  const srv = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jwks));
  });
  return { issuer, privateKey, jwksUrl: `${srv.url}/jwks`, close: srv.close };
}

export function mintAccessToken(as, { audience, scope, sub = 'user-123', clientId = 'agent-1', expiresIn = 300, typ = 'at+jwt', key = as.privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({ client_id: clientId, scope })
    .setProtectedHeader({ alg: 'RS256', typ, kid: 'as-key-1' })
    .setIssuer(as.issuer)
    .setSubject(sub)
    .setAudience(audience)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + expiresIn)
    .setJti(randomUUID())
    .sign(key);
}

export async function rpc(url, message, token) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof message === 'string' ? message : JSON.stringify(message),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}
