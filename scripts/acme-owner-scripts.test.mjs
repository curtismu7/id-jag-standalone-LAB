// The OWNER-RUN scripts for the shared Acme PingFederate (configure-acme-kit-connection.js, configure-acme-signin.js) and
// their guards, tested ONLY against a fake admin API that records every request. No test here reaches a real PingFederate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fakePf } from './fake-pf.mjs';

// pf-admin.js reads its settings file at load: point it at a scratch file BEFORE it is required, so no test ever touches the real one.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-owner-'));
process.env.PF_SETTINGS_FILE = path.join(scratch, 'settings.env');
delete process.env.PF_ADMIN_URL;
const require = createRequire(import.meta.url);
const kit = require('../pingfederate/configure-acme-kit-connection.js');
const signin = require('../pingfederate/configure-acme-signin.js');
const { acmePreflight, acmeVerify } = require('../pingfederate/acme-guard.js');

const ACME = 'https://pf-acme.example.invalid';
const LOCAL = 'https://127.0.0.1:4732';
const RES = 'http://localhost:9090/mcp';
const O = { pf: LOCAL, resource: RES, client: 'id-jag-redeemer' };
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const SHARED = /acmeToPingFed|acmeToResourceAs|acmeIdJagPolicy|acmeAtm|acme-agent|acmeRefreshToken/;

// Acme as the demo leaves it: its objects are what must never change.
const acmeSeed = () => ({
  '/serverSettings': { federationInfo: { baseUrl: ACME } },
  '/idp/spConnections/acmeToPingFed': { id: 'acmeToPingFed', entityId: 'https://pf-other.example.invalid', oauthTokenExchangeSettings: { resourceUris: ['https://mcp-other.example.invalid/mcp'], idJagEnabled: true } },
  '/idp/spConnections/acmeToResourceAs': { id: 'acmeToResourceAs', entityId: 'https://as-other.example.invalid', oauthTokenExchangeSettings: { resourceUris: ['https://mcp-other.example.invalid/mcp2'], idJagEnabled: true } },
  '/oauth/tokenExchange/processor/policies/acmeIdJagPolicy': { id: 'acmeIdJagPolicy' },
  '/oauth/tokenExchange/processor/settings': { defaultProcessorPolicyRef: { id: 'acmeIdJagPolicy' } },
  '/idp/tokenProcessors/acmeRefreshToken': { id: 'acmeRefreshToken' },
  '/oauth/accessTokenManagers/acmeAtm': { id: 'acmeAtm' },
  '/oauth/clients/acme-agent': { clientId: 'acme-agent' },
  '/keyPairs/signing/acme-idjag-signing': { id: 'acme-idjag-signing' },
  '/passwordCredentialValidators/acmeUsers': { id: 'acmeUsers' },
  '/authenticationPolicies/default': { defaultAuthenticationSources: [] },
  '/authenticationPolicies/settings': { enableIdpAuthnSelection: true },
  '/authenticationApi/settings': { apiEnabled: true },
  '/idp/adapters/descriptors/com.pingidentity.adapters.htmlform.idp.HtmlFormIdpAuthnAdapter': { configDescriptor: { fields: [] } },
});
const snapshotShared = (f) => JSON.stringify([...f.store].filter(([k]) => SHARED.test(k) || k === '/oauth/tokenExchange/processor/settings' || k === '/keyPairs/signing/acme-idjag-signing').sort());

// ---- the connection script ----
test('kit connection: creates only the processor, the policy and the connection, with the specified content', async () => {
  const f = fakePf(acmeSeed());
  const before = snapshotShared(f);
  await quiet(() => kit.run(f.api, O, { acmeIssuer: ACME }));
  assert.ok(f.store.has('/idp/tokenProcessors/idJagKitRefreshToken'));
  assert.ok(f.store.has('/oauth/tokenExchange/processor/policies/idJagKitPolicy'));
  const c = f.store.get('/idp/spConnections/idJagKitAcmeToLocalPf');
  assert.equal(c.entityId, LOCAL, 'the entity id becomes the ID-JAG aud');
  const ts = c.oauthTokenExchangeSettings;
  assert.deepEqual(ts.resourceUris, [RES]);
  assert.equal(ts.idJagEnabled, true);
  assert.equal(ts.minutesAfter, 5);
  assert.equal(c.credentials.signingSettings.signingKeyPairRef.id, 'acme-idjag-signing');
  assert.equal(ts.processorPolicyMappings.length, 1);
  const m = ts.processorPolicyMappings[0];
  assert.equal(m.processorPolicyRef.id, 'idJagKitPolicy');
  assert.deepEqual([m.attributeContractFulfillment.client_id.value, m.attributeContractFulfillment.scope.value], ['id-jag-redeemer', 'read mcp:invoke']);
  const policy = f.store.get('/oauth/tokenExchange/processor/policies/idJagKitPolicy');
  assert.equal(policy.processorMappings[0].subjectTokenProcessor.id, 'idJagKitRefreshToken', 'its own processor, not the demo\'s');
  assert.equal(snapshotShared(f), before, 'the demo\'s objects are byte for byte what they were');
});

test('kit connection: NO request, read or write, ever names a demo object; only the three kit ids are written', async () => {
  const f = fakePf(acmeSeed());
  await quiet(() => kit.inventory(f.api, () => {}));
  await quiet(() => kit.run(f.api, O, { dry: true }));
  await quiet(() => kit.run(f.api, O, {}));
  await quiet(() => kit.run(f.api, O, {})); // idempotent rerun
  await quiet(() => kit.run(f.api, O, { remove: true }));
  for (const c of f.calls) {
    assert.ok(!SHARED.test(c.path), `${c.method} ${c.path}`);
    if (c.body !== undefined) assert.ok(!SHARED.test(JSON.stringify(c.body)), `body of ${c.method} ${c.path}`);
  }
  const writes = f.writes().map((c) => `${c.method} ${c.path}`);
  for (const w of writes) assert.match(w, /idJagKitAcmeToLocalPf|idJagKitPolicy|idJagKitRefreshToken|^POST \/(idp\/spConnections|oauth\/tokenExchange\/processor\/policies|idp\/tokenProcessors)$/, w);
});

test('kit connection: --inventory and --dry-run send no POST, PUT or DELETE at all', async () => {
  const f = fakePf(acmeSeed());
  const lines = await quiet(() => kit.inventory(f.api, () => {}));
  assert.ok(lines.some((l) => /^connection acmeToPingFed {2}entityId=/.test(l)), 'prints ids, entity ids and resource URIs');
  assert.ok(lines.every((l) => !/secret|password/i.test(l)));
  await quiet(() => kit.run(f.api, O, { dry: true }));
  await quiet(() => kit.run(f.api, O, { dry: true, remove: true }));
  assert.deepEqual(f.writes(), []);
  assert.ok(f.calls.length > 0 && f.calls.every((c) => c.method === 'GET'));
  assert.equal(f.store.has('/idp/spConnections/idJagKitAcmeToLocalPf'), false);
});

test('kit connection: a dry run prints the plan', async () => {
  const f = fakePf(acmeSeed());
  const out = [];
  const log = console.log; console.log = (...a) => out.push(a.join(' '));
  try { await kit.run(f.api, O, { dry: true }); } finally { console.log = log; }
  // guarded() logs its plan lines through its own default logger, which is console.log
  assert.ok(out.some((l) => /plan POST \/idp\/spConnections/.test(l)), out.join('\n'));
});

test('kit connection: a second run writes nothing; a changed resource updates only the kit connection', async () => {
  const f = fakePf(acmeSeed());
  await quiet(() => kit.run(f.api, O, {}));
  const before = f.writes().length;
  await quiet(() => kit.run(f.api, O, {}));
  assert.equal(f.writes().length, before);
  await quiet(() => kit.run(f.api, { ...O, resource: 'http://localhost:9091/mcp' }, {}));
  assert.deepEqual(f.store.get('/idp/spConnections/idJagKitAcmeToLocalPf').oauthTokenExchangeSettings.resourceUris, ['http://localhost:9091/mcp']);
  assert.deepEqual(f.writes().slice(before).map((c) => `${c.method} ${c.path}`), ['PUT /idp/spConnections/idJagKitAcmeToLocalPf']);
});

test('kit connection: refuses when the resource or the local issuer is used by a connection that is not the kit\'s', async () => {
  const used = acmeSeed();
  used['/idp/spConnections/acmeToPingFed'].oauthTokenExchangeSettings.resourceUris = [RES];
  const a = fakePf(used);
  await assert.rejects(() => quiet(() => kit.run(a.api, O, {})), /resource .* already used by connection acmeToPingFed/);
  assert.deepEqual(a.writes(), []);
  const taken = acmeSeed();
  taken['/idp/spConnections/acmeToResourceAs'].entityId = LOCAL;
  const b = fakePf(taken);
  await assert.rejects(() => quiet(() => kit.run(b.api, O, {})), /already the entity id of connection acmeToResourceAs/);
  assert.deepEqual(b.writes(), []);
});

test('kit connection: refuses without Acme\'s ID-JAG signing key, and an issuer equal to Acme\'s own', async () => {
  const seed = acmeSeed(); delete seed['/keyPairs/signing/acme-idjag-signing'];
  const f = fakePf(seed);
  await assert.rejects(() => quiet(() => kit.run(f.api, O, {})), /no signing key acme-idjag-signing/);
  assert.deepEqual(f.writes(), []);
  const g = fakePf(acmeSeed());
  await assert.rejects(() => quiet(() => kit.run(g.api, { ...O, pf: ACME }, { acmeIssuer: ACME })), /own ID-JAG/);
  assert.throws(() => kit.validate({ ...O, pf: 'http://127.0.0.1:4732' }), /https origin/);
  assert.throws(() => kit.validate({ ...O, resource: 'not a url' }), /must be a URL/);
});

test('kit connection: --remove deletes the connection, then the policy, then the processor, and nothing else', async () => {
  const f = fakePf(acmeSeed());
  await quiet(() => kit.run(f.api, O, {}));
  const before = snapshotShared(f);
  f.calls.length = 0;
  await quiet(() => kit.run(f.api, O, { remove: true }));
  assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').map((c) => c.path), [
    '/idp/spConnections/idJagKitAcmeToLocalPf', '/oauth/tokenExchange/processor/policies/idJagKitPolicy', '/idp/tokenProcessors/idJagKitRefreshToken']);
  assert.equal(snapshotShared(f), before);
  assert.equal(f.store.has('/idp/spConnections/idJagKitAcmeToLocalPf'), false);
});

test('kit connection: --remove refuses while the sign-in client still uses the policy', async () => {
  const f = fakePf(acmeSeed());
  await quiet(() => kit.run(f.api, O, {}));
  f.store.set('/oauth/clients/id-jag-kit-acme', { clientId: 'id-jag-kit-acme', tokenExchangeProcessorPolicyRef: { id: 'idJagKitPolicy' } });
  await assert.rejects(() => quiet(() => kit.run(f.api, O, { remove: true })), /configure-acme-signin\.js --remove first/);
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('kit connection: the write list refuses any other target, even by mistake in the script', async () => {
  for (const [m, p, body] of [
    ['PUT', '/idp/spConnections/acmeToPingFed', { id: 'acmeToPingFed' }],
    ['DELETE', '/oauth/clients/acme-agent'],
    ['POST', '/oauth/clients', { clientId: 'x' }],
    ['PUT', '/oauth/tokenExchange/processor/settings', {}],
    ['POST', '/idp/spConnections', { id: 'acmeToPingFed' }],
    ['PUT', '/keyPairs/oauthOpenIdConnect', {}],
  ]) assert.match(kit.writeProblem(m, p, body), /refusing/, `${m} ${p}`);
  assert.equal(kit.writeProblem('GET', '/idp/spConnections/acmeToPingFed'), null);
  assert.equal(kit.writeProblem('POST', '/idp/spConnections', { id: 'idJagKitAcmeToLocalPf' }), null);
  const f = fakePf(acmeSeed());
  await assert.rejects(() => kit.guarded(f.api)('PUT', '/idp/spConnections/acmeToPingFed', { id: 'acmeToPingFed' }), /refusing PUT/);
  assert.deepEqual(f.calls, []);
});

// ---- the sign-in script ----
test('signin: the client is pointed at idJagKitPolicy, and the demo policy and agent are never touched', async () => {
  const f = fakePf(acmeSeed());
  await quiet(() => kit.run(f.api, O, {}));
  f.calls.length = 0;
  await quiet(() => signin.run(f.api, { uris: signin.redirectUris({ appOrigin: undefined }) }));
  const client = f.store.get('/oauth/clients/id-jag-kit-acme');
  assert.equal(client.tokenExchangeProcessorPolicyRef.id, 'idJagKitPolicy');
  assert.equal(client.clientId, 'id-jag-kit-acme');
  for (const c of f.calls) assert.ok(!/acmeToPingFed|acmeToResourceAs|acmeIdJagPolicy|acme-agent|acmeRefreshToken/.test(c.path), c.path);
  assert.ok(!/acmeIdJagPolicy/.test(JSON.stringify(client)));
});

test('signin: refuses to run before the dedicated policy exists', async () => {
  const f = fakePf(acmeSeed());
  const exit = process.exit; let code;
  process.exit = (c) => { code = c; throw new Error('exit'); };
  const err = console.error; console.error = () => {};
  try { await assert.rejects(() => quiet(() => signin.run(f.api, {})), /exit/); } finally { process.exit = exit; console.error = err; }
  assert.equal(code, 1);
  assert.equal(f.writes().length, 0);
});

test('signin: redirect URIs are a fixed list that is added to, never replaced', async () => {
  const f = fakePf(acmeSeed());
  await quiet(() => kit.run(f.api, O, {}));
  await quiet(() => signin.run(f.api, { uris: signin.redirectUris({ appOrigin: undefined }) }));
  assert.deepEqual(f.store.get('/oauth/clients/id-jag-kit-acme').redirectUris, [
    'http://localhost:4720/api/id-jag-playground/issuer/callback', 'http://127.0.0.1:4720/api/id-jag-playground/issuer/callback']);
  // an existing URI someone registered by hand stays; another APP_ORIGIN and the dev port are added
  const existing = f.store.get('/oauth/clients/id-jag-kit-acme');
  existing.redirectUris.push('https://by-hand.example.invalid/api/id-jag-playground/issuer/callback');
  await quiet(() => signin.run(f.api, { uris: signin.redirectUris({ appOrigin: 'http://localhost:4725', dev: true }) }));
  const uris = f.store.get('/oauth/clients/id-jag-kit-acme').redirectUris;
  for (const u of ['http://localhost:4720', 'http://127.0.0.1:4720', 'http://localhost:4725', 'http://127.0.0.1:4725', 'http://localhost:4723', 'https://by-hand.example.invalid']) {
    assert.ok(uris.some((x) => x.startsWith(u)), u);
  }
  assert.equal(new Set(uris).size, uris.length, 'no duplicates');
  assert.ok(uris.every((u) => u.endsWith('/api/id-jag-playground/issuer/callback')));
});

test('signin: the new client\'s secret goes to the settings file (not shown); a dry run and a rerun write none', async () => {
  const file = process.env.PF_SETTINGS_FILE;
  fs.rmSync(file, { force: true });
  const f = fakePf(acmeSeed());
  await quiet(() => kit.run(f.api, O, {}));
  const reads = async (m, p, b) => (m === 'GET' ? f.api(m, p, b) : { status: 200, body: b });
  await quiet(() => signin.run(reads, { dry: true }));
  assert.equal(f.store.has('/oauth/clients/id-jag-kit-acme'), false);
  assert.equal(fs.existsSync(file), false, 'a dry run writes no settings');
  await quiet(() => signin.run(f.api, {}));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^ACME_EXCHANGE_CLIENT_ID=id-jag-kit-acme$/m);
  assert.match(text, /^ACME_EXCHANGE_CLIENT_SECRET=\S{20,}$/m);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const secret = /^ACME_EXCHANGE_CLIENT_SECRET=(.*)$/m.exec(text)[1];
  await quiet(() => signin.run(f.api, {}));
  assert.equal(/^ACME_EXCHANGE_CLIENT_SECRET=(.*)$/m.exec(fs.readFileSync(file, 'utf8'))[1], secret, 'a rerun keeps the secret');
  await quiet(() => signin.run(f.api, { newSecret: true }));
  assert.notEqual(/^ACME_EXCHANGE_CLIENT_SECRET=(.*)$/m.exec(fs.readFileSync(file, 'utf8'))[1], secret, '--new-secret rotates it');
});

// ---- the guards ----
const script = (name, env, ...argv) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-guard-'));
  const settings = path.join(home, 'settings.env');
  fs.writeFileSync(settings, env.__FILE ?? '');
  const { __FILE, ...rest } = env;
  return spawnSync(process.execPath, [new URL(`../pingfederate/${name}`, import.meta.url).pathname, ...argv], { encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, HOME: home, STANDALONE_ENV: settings, ...rest } });
};

test('guards: no --acme, no --expect-issuer, or PF_ADMIN_URL anywhere stops both scripts before any request', () => {
  for (const name of ['configure-acme-kit-connection.js', 'configure-acme-signin.js']) {
    const bare = script(name, {}, '--ns=x');
    assert.equal(bare.status, 2, name);
    assert.match(bare.stderr, /pass --acme/);
    const noIssuer = script(name, {}, '--acme', '--ns=x');
    assert.equal(noIssuer.status, 2);
    assert.match(noIssuer.stderr, /--expect-issuer/);
    const direct = script(name, { PF_ADMIN_URL: 'https://127.0.0.1:4731', PF_ADMIN_PASSWORD: 'x' }, '--acme', `--expect-issuer=${ACME}`, '--ns=x');
    assert.equal(direct.status, 2);
    assert.match(direct.stderr, /PF_ADMIN_URL is set/);
    const inFile = script(name, { __FILE: 'PF_ADMIN_URL=https://127.0.0.1:4731\n' }, '--acme', `--expect-issuer=${ACME}`, '--ns=x');
    assert.equal(inFile.status, 2, 'PF_ADMIN_URL in the settings file counts too');
    for (const r of [bare, noIssuer, direct, inFile]) assert.ok(!r.stderr.includes(ACME) && !r.stdout.includes(ACME), 'the issuer is never echoed');
  }
});

test('guards: acmePreflight and acmeVerify', async () => {
  assert.equal(acmePreflight({ acme: true, 'expect-issuer': ACME }, {}), null);
  assert.match(acmePreflight({ 'expect-issuer': ACME }, {}), /--acme/);
  assert.match(acmePreflight({ acme: true, 'expect-issuer': 'http://x.example.invalid' }, {}), /--expect-issuer/);
  assert.match(acmePreflight({ acme: true, 'expect-issuer': ACME }, { PF_ADMIN_URL: 'https://127.0.0.1:4731' }), /PF_ADMIN_URL/);
  assert.equal(await acmeVerify(fakePf(acmeSeed()).api, { 'expect-issuer': `${ACME}/` }), null, 'a trailing slash is ignored');
  const local = fakePf({ '/serverSettings': { federationInfo: { baseUrl: LOCAL } } });
  const bad = await acmeVerify(local.api, { 'expect-issuer': ACME });
  assert.match(bad, /not the one --expect-issuer names/);
  assert.ok(!bad.includes(LOCAL) && !bad.includes(ACME));
  assert.match(await acmeVerify(fakePf({}).api, { 'expect-issuer': ACME }), /HTTP 404/);
});

test('settings writes default to the shared settings file, never to a repo-root .env', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pfenv-'));
  const shared = path.join(home, 'Development', '.env');
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.writeFileSync(shared, 'OTHER_APP=1\n');
  const code = "const pf = require(process.argv[1]); console.log(pf.ENV_FILE); pf.writeEnv({ KIT_TEST_KEY: 'v' });";
  const r = spawnSync(process.execPath, ['-e', code, new URL('../pingfederate/pf-admin.js', import.meta.url).pathname], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), shared);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'OTHER_APP=1\nKIT_TEST_KEY=v\n');
  assert.equal(fs.statSync(shared).mode & 0o777, 0o600);
  const own = path.join(home, 'own.env');
  const r2 = spawnSync(process.execPath, ['-e', code, new URL('../pingfederate/pf-admin.js', import.meta.url).pathname], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, PF_SETTINGS_FILE: own } });
  assert.equal(r2.stdout.trim(), own, 'an explicit PF_SETTINGS_FILE still wins');
});
