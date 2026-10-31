// Test-only: an HTTP listener on an ephemeral port and a throwaway IdP that
// mints ID-JAGs and serves its JWKS. Also used by mcp-sample's end-to-end test.
import http from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import * as jose from 'jose';

export async function listen(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

export function newRsaKey() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
}

export function publicJwk(privateKey, extra = {}) {
  const { kty, n, e } = privateKey.export({ format: 'jwk' });
  return { kty, n, e, alg: 'RS256', use: 'sig', ...extra };
}

/** A test IdP. Assign `idp.jwks` to change what its JWKS endpoint serves. */
export async function startTestIdp(issuer = 'https://idp.example.test') {
  const privateKey = newRsaKey();
  const idp = { issuer, privateKey, kid: 'idp-key-1' };
  idp.defaultJwks = { keys: [publicJwk(privateKey, { kid: idp.kid })] };
  idp.jwks = idp.defaultJwks;
  const srv = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(idp.jwks));
  });
  idp.jwksUrl = `${srv.url}/jwks`;
  idp.close = srv.close;
  return idp;
}

/**
 * Mint an ID-JAG. `claims` / `header` override the defaults; an `undefined`
 * value removes that claim or header parameter.
 */
export function mintIdJag(idp, { audience, resource, clientId = 'agent-1', scope = 'read mcp:invoke' },
  claims = {}, header = {}, key = idp.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    jti: randomUUID(),
    iss: idp.issuer,
    sub: 'user-123',
    aud: audience,
    resource,
    client_id: clientId,
    scope,
    iat: now,
    exp: now + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'oauth-id-jag+jwt', kid: idp.kid, ...header })
    .sign(key);
}
