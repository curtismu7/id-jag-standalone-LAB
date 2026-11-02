// The local PingFederate's own certificate (PF_CA_FILE) is trusted for its origin only: another origin's JWKS, with the same
// self-signed certificate, must still fail.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandler } from '../src/app.js';
import { listen, mintIdJag, newRsaKey, publicJwk } from './helpers.js';

const AS_ISSUER = 'https://as.example.test';
const RESOURCE = 'https://mcp.example.test/mcp';
const SECRET = 'agent-1-secret';
let dir; let jwks; let idp; let cert; let signingKey;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-ras-ca-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  cert = fs.readFileSync(path.join(dir, 'c.pem'));
  const key = newRsaKey();
  signingKey = newRsaKey();
  const body = JSON.stringify({ keys: [publicJwk(key, { kid: 'k1' })] });
  jwks = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert }, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
  await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
  idp = { issuer: 'https://idp.example.test', privateKey: key, kid: 'k1', jwksUrl: `https://127.0.0.1:${jwks.address().port}/jwks`, origin: `https://127.0.0.1:${jwks.address().port}` };
});
afterAll(() => new Promise((r) => { jwks.closeAllConnections(); jwks.close(r); }));

async function redeemWith(pfCa) {
  const srv = await listen(createHandler({
    issuer: AS_ISSUER, acceptedResources: [RESOURCE], accessTokenTtl: 3600, signingKey, allowPublicClients: false, log: () => {},
    clients: [{ client_id: 'agent-1', client_secret_hash: createHash('sha256').update(SECRET).digest('hex'), scope: 'read mcp:invoke' }],
    idps: [{ id: 'pf', issuer: idp.issuer, jwksUrl: idp.jwksUrl, clientAliases: { 'agent-1': 'agent-1' }, scopes: '' }],
    pfCa,
  }));
  try {
    const assertion = await mintIdJag(idp, { audience: AS_ISSUER, resource: RESOURCE });
    const res = await fetch(`${srv.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion, client_id: 'agent-1', client_secret: SECRET }) });
    return res.status;
  } finally { await srv.close(); }
}

describe('PF_CA_FILE scope in the resource AS', () => {
  it('trusts the certificate for the origin it was given', async () => {
    expect(await redeemWith({ origin: idp.origin, ca: cert })).toBe(200);
  });
  it('does not trust it for any other origin (same server, same certificate, different origin)', async () => {
    expect(await redeemWith({ origin: 'https://127.0.0.1:1', ca: cert })).not.toBe(200);
    expect(await redeemWith(undefined)).not.toBe(200);
  });
});
