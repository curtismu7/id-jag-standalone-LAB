// Test-only OIDC provider on a loopback port: discovery, JWKS, and a token endpoint that checks
// PKCE and mints an ID token. Tests steer it through `provider.claims`, `provider.signWith`, etc.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import * as jose from 'jose';

export async function startProvider({ tls } = {}) { // tls: { key, cert } serves https
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const p = {
    privateKey, signWith: privateKey, claims: {}, codes: new Map(), tokenRequests: [],
    refreshToken: crypto.randomBytes(24).toString('base64url'),
    clientPublicKey: null, // set to verify private_key_jwt client assertions
  };

  const handler = async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, p.issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, { issuer: p.issuer, authorization_endpoint: `${p.issuer}/authorize`, token_endpoint: `${p.issuer}/token`, jwks_uri: `${p.issuer}/jwks` });
    }
    if (url.pathname === '/jwks') return send(200, { keys: [jwk] });
    if (url.pathname !== '/token') return send(404, {});
    let body = '';
    for await (const c of req) body += c;
    const form = new URLSearchParams(body);
    p.tokenRequests.push({ form, authorization: req.headers.authorization });
    const grant = p.codes.get(form.get('code'));
    p.codes.delete(form.get('code'));
    if (!grant) return send(400, { error: 'invalid_grant' });
    if (crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== grant.challenge) {
      return send(400, { error: 'invalid_grant', error_description: 'PKCE' });
    }
    if (p.clientPublicKey) {
      try {
        await jose.jwtVerify(form.get('client_assertion'), p.clientPublicKey, { issuer: grant.clientId, subject: grant.clientId, audience: `${p.issuer}/token` });
      } catch { return send(401, { error: 'invalid_client' }); }
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new jose.SignJWT({
      iss: p.issuer, aud: grant.clientId, iat: now, exp: now + 300,
      sub: 'user-1', email: 'alice@pingidentity.com', email_verified: true, name: 'Alice', nonce: grant.nonce, ...p.claims,
    }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(p.signWith);
    return send(200, { access_token: 'at-not-used', token_type: 'Bearer', id_token: idToken, refresh_token: p.refreshToken });
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  p.issuer = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;

  /** Play the user at the authorization endpoint: returns the code for the callback. */
  p.authorize = (location) => {
    const q = new URL(location).searchParams;
    const code = crypto.randomBytes(8).toString('hex');
    p.codes.set(code, { challenge: q.get('code_challenge'), nonce: q.get('nonce'), clientId: q.get('client_id') });
    return { code, state: q.get('state'), query: q };
  };
  p.close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return p;
}
