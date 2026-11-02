// The local-only scripts must reach the kit's own PingFederate and nothing else, even with a stale PF_ADMIN_URL in the shell.
// A fake admin API (https, loopback, a random port) stands in for "another PingFederate"; it records every request.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { fakePf } from './fake-pf.mjs';

const require = createRequire(import.meta.url);
const PF_URL = 'https://127.0.0.1:4732';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-guard-'));
const other = { requests: [], server: null, port: 0 };

before(async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  other.server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    other.requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ federationInfo: { baseUrl: 'https://localhost:9031', saml2EntityId: 'someone-elses-pf' }, items: [] }));
  });
  await new Promise((r) => other.server.listen(0, '127.0.0.1', r));
  other.port = other.server.address().port;
});
after(() => { other.server.closeAllConnections(); other.server.close(); });

const run = (name, env, ...argv) => new Promise((resolve) => {
  const home = fs.mkdtempSync(path.join(dir, 'home-'));
  const settings = path.join(home, 'settings.env'); fs.writeFileSync(settings, '');
  const p = spawn(process.execPath, [new URL(`../pingfederate/${name}`, import.meta.url).pathname, ...argv], {
    env: { PATH: '/usr/bin:/bin', HOME: home, STANDALONE_ENV: settings, PF_SETTINGS_FILE: settings, PF_ADMIN_PASSWORD: 'x', PF_ADMIN_INSECURE_TLS: 'true', PF_URL, ...env } });
  let err = ''; p.stderr.on('data', (c) => { err += c; }); p.stdout.resume();
  p.on('close', (code) => resolve({ code, err }));
});

const LOCAL_ONLY = ['configure-base-url.js', 'configure-local-tls.js', 'configure-idjag-issuer.js', 'configure-pf-redeemer.js'];

test('requireLocalAdmin: another PingFederate\'s admin port is refused before any request, whatever the host', async () => {
  for (const name of LOCAL_ONLY) {
    for (const url of ['https://127.0.0.1:9999', 'https://localhost:9032', 'https://127.0.0.1:9031', `https://127.0.0.1:${other.port}`, 'http://127.0.0.1:4731']) {
      const r = await run(name, { PF_ADMIN_URL: url, ACME_PF_URL: 'https://pf-acme.example.invalid' });
      assert.equal(r.code, 2, `${name} ${url}`);
      assert.match(r.err, /local PingFederate/);
    }
  }
  assert.deepEqual(other.requests, []);
});

test('requireLocalAdmin: PF_ADMIN_PORT cannot name another project\'s PingFederate either', async () => {
  for (const port of ['9999', '9032', '9031']) {
    const r = await run('configure-base-url.js', { PF_ADMIN_URL: `https://127.0.0.1:${port}`, PF_ADMIN_PORT: port });
    assert.equal(r.code, 2, port);
  }
});

test('requireIssuer: an admin API whose base URL is not PF_URL is not written to by the issuer and redeemer scripts', async () => {
  for (const name of ['configure-idjag-issuer.js', 'configure-pf-redeemer.js']) {
    other.requests.length = 0;
    const r = await run(name, { PF_ADMIN_URL: `https://127.0.0.1:${other.port}`, PF_ADMIN_PORT: String(other.port), ACME_PF_URL: 'https://pf-acme.example.invalid',
      RESOURCE_AS_ISSUER: 'http://localhost:9080', ID_JAG_RESOURCE: 'http://localhost:9090/mcp' });
    assert.notEqual(r.code, 0, name);
    assert.match(r.err, /not the PingFederate whose base URL is/);
    assert.deepEqual(other.requests, ['GET /pf-admin-api/v1/serverSettings'], `${name} read the base URL and nothing else`);
  }
});

test('requireIssuer (unit): matches the base URL, ignores a trailing slash', async () => {
  const pf = require('../pingfederate/pf-admin.js');
  await pf.requireIssuer(fakePf({ '/serverSettings': { federationInfo: { baseUrl: PF_URL } } }).api, `${PF_URL}/`);
  await assert.rejects(() => pf.requireIssuer(fakePf({}).api, PF_URL), /not the PingFederate/);
});
