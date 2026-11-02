// configure-pf-redeemer.js (the local PingFederate as the pf-pf redeemer), run against an in-memory admin API. Nothing here
// contacts a PingFederate, Acme or Docker; the restart and the backup are injected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fakePf } from './fake-pf.mjs';

// pf-admin.js reads its settings file at load: use a scratch one, never the real shared file.
process.env.PF_SETTINGS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'redeemer-')), 'settings.env');
const require = createRequire(import.meta.url);
const pf = require('../pingfederate/pf-admin.js');
const redeemer = require('../pingfederate/configure-pf-redeemer.js');

const PF_URL = 'https://127.0.0.1:4732';
const ACME = 'https://pf-acme.example.invalid';
const RESOURCE = 'http://localhost:9090/mcp';
const JWT_DESC = '/oauth/accessTokenManagers/descriptors/com.pingidentity.pf.access.token.management.plugins.JwtBearerAccessTokenManagementPlugin';
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const seed = () => ({
  '/keyPairs/signing/idjagkit-signing': { id: 'idjagkit-signing' },
  '/oauth/authServerSettings': { scopes: [{ name: 'openid' }] },
  [JWT_DESC]: { configDescriptor: { fields: [{ name: 'Token Lifetime', defaultValue: 120 }, { name: 'JWS Algorithm' }] } },
});
const O = { pfUrl: PF_URL, acmeUrl: ACME, resource: RESOURCE, client: 'id-jag-redeemer', existingSecret: '' };

// The fake keeps no scope list of its own; a real PingFederate lists the scopes the first run created.
const hasScopes = (f) => f.store.set('/oauth/authServerSettings', { scopes: [{ name: 'read' }, { name: 'mcp:invoke' }] });

function deps(f, over = {}) {
  const order = []; const written = []; let n = 0;
  return {
    order, written,
    backup: async () => { order.push(`backup@${f.writes().length}`); },
    restart: async () => { order.push('restart'); },
    writeSettings: (pairs) => { written.push(pairs); },
    rand: () => `secret-${++n}`,
    ...over,
  };
}

test('redeemer: creates the token manager (selected by the resource), the Acme IdP connection and the JWT bearer client', async () => {
  const f = fakePf(seed()); const d = deps(f);
  const r = await quiet(() => redeemer.run(f.api, O, d));
  assert.equal(r.changed, true);
  const atm = f.store.get('/oauth/accessTokenManagers/idJagKitRedeemerAtm');
  assert.deepEqual(atm.selectionSettings.resourceUris, [RESOURCE]);
  const field = (n) => atm.configuration.fields.find((x) => x.name === n)?.value;
  assert.equal(field('Publish Keys to the PingFederate JWKS Endpoint'), 'false', 'the ID-JAG key is already published by the issuer setup');
  assert.equal(field('Issuer Claim Value'), PF_URL);
  assert.deepEqual(atm.attributeContract.extendedAttributes.map((x) => x.name), ['sub', 'client_id', 'scope']);

  const idp = f.store.get('/sp/idpConnections/idJagKit-acme');
  assert.equal(idp.entityId, ACME);
  assert.equal(idp.idpBrowserSso.oidcProviderSettings.jwksURL, `${ACME}/pf/JWKS`);
  const m = idp.idpOAuthGrantAttributeMapping.accessTokenManagerMappings[0];
  assert.equal(m.accessTokenManagerRef.id, 'idJagKitRedeemerAtm');
  assert.deepEqual(Object.keys(m.attributeContractFulfillment), ['sub', 'client_id', 'scope'], 'only what the token manager\'s contract has');

  const client = f.store.get('/oauth/clients/id-jag-redeemer');
  assert.deepEqual(client.grantTypes, ['EXTENSION']);
  assert.equal(client.clientAuth.type, 'SECRET');
  assert.equal(client.defaultAccessTokenManagerRef.id, 'idJagKitRedeemerAtm');

  for (const name of ['read', 'mcp:invoke']) assert.ok(f.calls.some((c) => c.path === '/oauth/authServerSettings/scopes/commonScopes' && c.body.name === name));
  assert.deepEqual(d.written, [{ PF_REDEEMER_CLIENT_ID: 'id-jag-redeemer', PF_RESOURCE: RESOURCE, PF_REDEEMER_CLIENT_SECRET: 'secret-1' }]);
  assert.equal(client.clientAuth.secret, 'secret-1', 'the generated secret is the one written to the settings file');
});

test('redeemer: the backup is taken before the first write, and a failed backup stops everything', async () => {
  const f = fakePf(seed()); const d = deps(f);
  await quiet(() => redeemer.run(f.api, O, d));
  assert.equal(d.order[0], 'backup@0', 'no write had happened when the backup ran');
  const g = fakePf(seed());
  await assert.rejects(() => quiet(() => redeemer.run(g.api, O, deps(g, { backup: async () => { throw new Error('the configuration backup failed'); } }))), /backup failed/);
  assert.equal(g.writes().length, 0);
});

test('redeemer: a second run changes nothing, restarts nothing and keeps the secret', async () => {
  const f = fakePf(seed());
  await quiet(() => redeemer.run(f.api, O, deps(f)));
  hasScopes(f);
  const before = f.writes().length;
  const d = deps(f);
  const r = await quiet(() => redeemer.run(f.api, { ...O, existingSecret: 'secret-1' }, d));
  assert.equal(r.changed, false);
  assert.equal(f.writes().length, before, 'no write');
  assert.ok(!d.order.includes('restart'));
  assert.equal(f.store.get('/oauth/clients/id-jag-redeemer').clientAuth.secret, 'secret-1');
  assert.deepEqual(d.written, [{ PF_REDEEMER_CLIENT_ID: 'id-jag-redeemer', PF_RESOURCE: RESOURCE }], 'no new secret is written');
});

test('redeemer: the container restarts when the Acme connection is created or its address changes, not otherwise', async () => {
  const f = fakePf(seed());
  const d1 = deps(f);
  await quiet(() => redeemer.run(f.api, O, d1));
  assert.ok(d1.order.includes('restart'));
  hasScopes(f);
  const d2 = deps(f);
  await quiet(() => redeemer.run(f.api, { ...O, existingSecret: 'secret-1', acmeUrl: 'https://pf-acme-2.example.invalid' }, d2));
  assert.equal(f.store.get('/sp/idpConnections/idJagKit-acme').entityId, 'https://pf-acme-2.example.invalid');
  assert.ok(d2.order.includes('restart'));
});

test('redeemer: an existing client whose secret is no longer in the settings file gets a new one; one that is there is kept', async () => {
  const f = fakePf(seed());
  await quiet(() => redeemer.run(f.api, O, deps(f)));
  hasScopes(f);
  const d = deps(f, { rand: () => 'second-secret' });
  await quiet(() => redeemer.run(f.api, O, d)); // existingSecret '' again: the file lost it
  assert.equal(f.store.get('/oauth/clients/id-jag-redeemer').clientAuth.secret, 'second-secret');
  assert.equal(d.written[0].PF_REDEEMER_CLIENT_SECRET, 'second-secret');
  assert.ok(!d.order.includes('restart'), 'a new secret needs no restart');
});

test('redeemer: the resource is added to an existing token manager that lacks it', async () => {
  const f = fakePf(seed());
  await quiet(() => redeemer.run(f.api, O, deps(f)));
  hasScopes(f);
  await quiet(() => redeemer.run(f.api, { ...O, existingSecret: 'x', resource: 'http://localhost:9091/mcp' }, deps(f)));
  assert.deepEqual(f.store.get('/oauth/accessTokenManagers/idJagKitRedeemerAtm').selectionSettings.resourceUris, [RESOURCE, 'http://localhost:9091/mcp']);
});

test('redeemer: refuses without the issuer\'s signing key, when Acme is this PingFederate, and when another connection owns the Acme issuer', async () => {
  const noKey = fakePf({ ...seed(), '/keyPairs/signing/idjagkit-signing': undefined });
  noKey.store.delete('/keyPairs/signing/idjagkit-signing');
  await assert.rejects(() => quiet(() => redeemer.run(noKey.api, O, deps(noKey))), /pf-local first/);
  const f = fakePf(seed());
  await assert.rejects(() => redeemer.run(f.api, { ...O, acmeUrl: PF_URL }, deps(f)), /own ID-JAG/);
  const g = fakePf({ ...seed(), '/sp/idpConnections/someone': { id: 'someone', entityId: ACME } });
  await assert.rejects(() => quiet(() => redeemer.run(g.api, O, deps(g))), /already the entity id of connection someone/);
  assert.ok(!g.store.has('/sp/idpConnections/idJagKit-acme'));
});

test('redeemer: a failed client creation writes no settings and restarts nothing', async () => {
  const f = fakePf(seed());
  const failing = async (m, p, b) => (m === 'POST' && p === '/oauth/clients' ? { status: 422, body: { message: 'no' } } : f.api(m, p, b));
  const d = deps(f);
  await quiet(() => redeemer.run(failing, O, d));
  assert.deepEqual(d.written, []);
  assert.ok(!d.order.includes('restart'));
});

test('redeemer --remove deletes the client, the connection and the token manager, in that order', async () => {
  const f = fakePf(seed());
  await quiet(() => redeemer.run(f.api, O, deps(f)));
  await quiet(() => redeemer.remove(f.api, O, deps(f)));
  const deletes = f.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
  assert.deepEqual(deletes, ['/oauth/clients/id-jag-redeemer', '/sp/idpConnections/idJagKit-acme', '/oauth/accessTokenManagers/idJagKitRedeemerAtm']);
});

test('redeemer: only ids of the kit are written (the shared objects of other apps are never touched)', async () => {
  const f = fakePf(seed());
  await quiet(() => redeemer.run(f.api, O, deps(f)));
  const paths = f.writes().map((c) => c.path);
  assert.deepEqual(paths.filter((p) => !/idJagKit|id-jag-redeemer|commonScopes|^\/oauth\/(accessTokenManagers|clients)$|^\/sp\/idpConnections$/.test(p)), []);
});

// ---- the helpers ----
test('backup: saved as mode 600 JSON, and a failing export throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfbk-'));
  const file = await redeemer.saveBackup(async () => ({ status: 200, body: { items: [1] } }), path.join(dir, 'b'), new Date('2026-11-02T12:00:00Z'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { items: [1] });
  await assert.rejects(() => redeemer.saveBackup(async () => ({ status: 403, body: null }), path.join(dir, 'c')), /nothing was changed/);
  assert.ok(!fs.existsSync(path.join(dir, 'c')), 'no file for a failed export');
});

test('containerName: PF_CONTAINER, else an existing pingfederate-lab, else id-jag-kit-pf', () => {
  assert.equal(redeemer.containerName({ PF_CONTAINER: 'mine' }), 'mine');
  assert.equal(redeemer.containerName({}, () => 'a\npingfederate-lab\nb\n'), 'pingfederate-lab');
  assert.equal(redeemer.containerName({}, () => 'a\npingfederate-lab-pingfederate-lab-1\n'), 'id-jag-kit-pf', 'another app\'s container is not ours');
  assert.equal(redeemer.containerName({}, () => { throw new Error('no docker'); }), 'id-jag-kit-pf');
});

test('restartContainer: refuses a non-orbstack docker context, restarts, and waits for the admin API', async () => {
  const calls = [];
  const exec = (cmd, a) => { calls.push([cmd, ...a]); return a[0] === 'context' ? 'desktop-linux\n' : ''; };
  await assert.rejects(() => redeemer.restartContainer(async () => ({ status: 200 }), 'c', { exec, sleep: async () => {} }), /orbstack/);
  assert.ok(!calls.some((c) => c[1] === 'restart'));
  const ok = (cmd, a) => { calls.push([cmd, ...a]); return a[0] === 'context' ? 'orbstack\n' : ''; };
  let n = 0;
  await quiet(() => redeemer.restartContainer(async () => { if (++n < 3) throw new Error('down'); return { status: 200 }; }, 'pingfederate-lab', { exec: ok, sleep: async () => {} }));
  assert.deepEqual(calls.at(-1), ['docker', 'restart', 'pingfederate-lab']);
  assert.equal(n, 3);
  await assert.rejects(() => quiet(() => redeemer.restartContainer(async () => { throw new Error('down'); }, 'c', { exec: ok, sleep: async () => {}, tries: 2 })), /did not come back/);
});

test('the script refuses any admin API that is not loopback, and a missing ACME_PF_URL names the way to get it', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pfr-'));
  const file = path.join(home, 'empty.env'); fs.writeFileSync(file, '');
  const run = (env) => spawnSync(process.execPath, [new URL('../pingfederate/configure-pf-redeemer.js', import.meta.url).pathname], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, STANDALONE_ENV: file, PF_ADMIN_PASSWORD: 'x', ...env } });
  for (const env of [{}, { PF_ADMIN_URL: 'https://pf-acme.example.invalid:9999' }]) {
    const r = run({ PF_URL, ...env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /local PingFederate/);
  }
  const r = run({ PF_URL, PF_ADMIN_URL: 'https://127.0.0.1:1' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--acme-settings/);
  assert.equal(pf.ENV_FILE.endsWith('.env'), true);
});
