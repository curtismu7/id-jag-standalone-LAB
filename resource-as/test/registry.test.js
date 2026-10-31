// The trusted-IdP registry fetch over a REAL TLS socket: it must send the
// bearer, verify the server certificate (pinned CA or default trust store,
// never skipped), and keep the last good list when a fetch fails.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createTrustedIdps } from '../src/trusted-idps.js';

const REG_IDP = { id: 'okta', issuer: 'https://x.okta.example', jwksUrl: 'https://x.okta.example/keys', clientAliases: {}, scopes: '' };

let dir;
let server;
let url;
let status;
let seenAuth;
let warnings;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-reg-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
  { stdio: 'ignore' });
  server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) },
    (req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { idps: [REG_IDP] } : { error: 'unauthorized' }));
    });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `https://localhost:${server.address().port}/api/id-jag-playground/trusted-idps/registry`;
});

afterAll(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

beforeEach(() => { status = 200; seenAuth = undefined; warnings = []; });

const make = ({ registry, ...rest } = {}) => createTrustedIdps({
  fileIdps: [],
  registry: { url, token: 'registry-token', caFile: path.join(dir, 'cert.pem'), cacheMs: 0, ...registry },
  log: (line) => warnings.push(line),
  ...rest,
});

it('sends the bearer and trusts the pinned CA', async () => {
  const idps = await make()();
  expect(seenAuth).toBe('Bearer registry-token');
  expect(idps.map((i) => i.id)).toEqual(['okta']);
});

it('refuses an unverifiable certificate and trusts nobody', async () => {
  const idps = await make({ registry: { caFile: undefined } })();
  expect(seenAuth).toBeUndefined();
  expect(idps).toEqual([]);
  expect(warnings.join('\n')).toMatch(/self[- ]signed/i);
});

it('keeps the last good list after a 401 and warns once', async () => {
  const trusted = make();
  expect(await trusted()).toHaveLength(1);
  status = 401;
  expect((await trusted()).map((i) => i.id)).toEqual(['okta']);
  expect((await trusted()).map((i) => i.id)).toEqual(['okta']);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).not.toContain('registry-token');
});

it('caches for cacheMs', async () => {
  const trusted = make({ registry: { cacheMs: 60_000 } });
  await trusted();
  seenAuth = undefined;
  await trusted();
  expect(seenAuth).toBeUndefined();
});

it('lets a file entry win an issuer collision', async () => {
  const fileIdp = { ...REG_IDP, id: 'file', jwksUrl: 'https://file.example/keys' };
  const idps = await make({ fileIdps: [fileIdp] })();
  expect(idps).toEqual([fileIdp]);
});
