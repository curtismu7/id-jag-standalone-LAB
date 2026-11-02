import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatSelfCheck, httpsGetJson, selfCheck } from './pf-selfcheck.mjs';

const PF = 'https://127.0.0.1:4732';
const key = (n, extra = {}) => ({ kty: 'RSA', n, e: 'AQAB', ...extra });
// A fake PingFederate: `answers` maps a path to a response, or to an Error that the fetch throws.
const getter = (answers) => async (url) => {
  const a = answers[url.slice(PF.length)];
  if (a instanceof Error) throw a;
  return a ?? { status: 404, body: null };
};
const good = {
  '/.well-known/openid-configuration': { status: 200, body: { issuer: PF } },
  '/pf/JWKS': { status: 200, body: { keys: [key('A', { kid: 'one', x5t: 't' }), key('A', { kid: 'two', x5t: 't' })] } },
};
const run = (answers, caFile) => selfCheck({ pfUrl: PF, caFile, readFile: async () => Buffer.from('PEM'), get: getter(answers) });
const ids = (r) => r.checks.map((c) => `${c.id}:${c.ok}`);

test('passes when TLS verifies, discovery names PF_URL, and /pf/JWKS has one distinct RSA key with x5t (under several kids)', async () => {
  const r = await run(good, '/ca.pem');
  assert.equal(r.ok, true);
  assert.deepEqual(ids(r), ['tls:true', 'issuer:true', 'jwks:true']);
  assert.match(formatSelfCheck(r).at(-1), /working ID-JAG issuer/);
});

test('fails loudly on an expired certificate, naming the code and the fix; nothing after TLS is trusted', async () => {
  const r = await run({ '/.well-known/openid-configuration': Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }) }, '/ca.pem');
  assert.equal(r.ok, false);
  assert.deepEqual(ids(r), ['tls:false']);
  assert.match(r.checks[0].message, /CERT_HAS_EXPIRED/);
  assert.match(formatSelfCheck(r).join('\n'), /SELF-CHECK FAILED/);
});

test('fails when discovery names another issuer (the image default of another PingFederate), and says not to change PF_URL', async () => {
  const r = await run({ ...good, '/.well-known/openid-configuration': { status: 200, body: { issuer: 'https://localhost:9031' } } });
  assert.equal(r.ok, false);
  assert.deepEqual(ids(r), ['tls:true', 'issuer:false', 'jwks:true']);
  assert.match(r.checks[1].message, /https:\/\/localhost:9031/);
  assert.match(r.checks[1].fix, /Do not change PF_URL/);
});

test('fails when /pf/JWKS has two distinct RSA keys, none, or no x5t', async () => {
  const jwks = (keys) => ({ ...good, '/pf/JWKS': { status: 200, body: { keys } } });
  assert.equal((await run(jwks([key('A', { x5t: 't' }), key('B', { x5t: 'u' })]))).ok, false, 'two distinct keys');
  assert.equal((await run(jwks([]))).ok, false, 'no keys');
  assert.equal((await run(jwks([key('A', { kid: 'k' })]))).ok, false, 'a key with no x5t');
  assert.equal((await run({ ...good, '/pf/JWKS': { status: 500, body: null } })).ok, false);
  assert.equal((await run({ ...good, '/pf/JWKS': Object.assign(new Error('x'), { code: 'ECONNRESET' }) })).ok, false);
});

test('an unreadable PF_CA_FILE fails before any request', async () => {
  const r = await selfCheck({ pfUrl: PF, caFile: '/nope.pem', readFile: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, get: async () => { throw new Error('should not be called'); } });
  assert.equal(r.ok, false);
  assert.match(r.checks[0].message, /ENOENT/);
});

// A real TLS socket: the certificate is for 127.0.0.1 only, so the check proves the IP SAN and the CA are what verify.
test('httpsGetJson verifies the certificate against the given CA and the 127.0.0.1 address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-sc-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => { res.end(JSON.stringify({ issuer: 'x' })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${server.address().port}/`;
  try {
    assert.deepEqual(await httpsGetJson(url, { ca: fs.readFileSync(path.join(dir, 'c.pem')) }), { status: 200, body: { issuer: 'x' } });
    await assert.rejects(httpsGetJson(url), (e) => e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT', 'without the CA it does not verify');
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
