// The configure scripts that make the kit's own PingFederate a working ID-JAG issuer, run against an in-memory admin API.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fakePf } from './fake-pf.mjs';

const require = createRequire(import.meta.url);
const pf = require('../pingfederate/pf-admin.js');
const baseUrl = require('../pingfederate/configure-base-url.js');
const tls = require('../pingfederate/configure-local-tls.js');
const issuer = require('../pingfederate/configure-idjag-issuer.js');

const PF_URL = 'https://127.0.0.1:4732';
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const DAY = 864e5;

// ---- configure-base-url ----
test('base URL: a new PingFederate (image default) is set to PF_URL, once', async () => {
  const f = fakePf({ '/serverSettings': { federationInfo: { baseUrl: 'https://localhost:9031', saml2EntityId: 'evaluation' }, other: 1 } });
  assert.equal(await quiet(() => baseUrl.run(f.api, { url: PF_URL })), true);
  assert.equal(f.store.get('/serverSettings').federationInfo.baseUrl, PF_URL);
  assert.equal(f.store.get('/serverSettings').federationInfo.saml2EntityId, 'evaluation', 'an existing entity id is kept');
  assert.equal(f.store.get('/serverSettings').other, 1, 'the rest of the settings is sent back unchanged');
  assert.equal(await quiet(() => baseUrl.run(f.api, { url: PF_URL })), false, 'a rerun changes nothing');
  assert.equal(f.writes().length, 1);
});

// ---- configure-local-tls ----
const cert = (over) => ({ id: 'old', subjectDN: 'CN=localhost', issuerDN: 'CN=localhost', subjectAlternativeNames: [], expires: '2024-07-13T02:54:53Z', status: 'EXPIRED', ...over });
const tlsSeed = (c) => ({ '/keyPairs/sslServer/settings': { runtimeServerCertRef: { id: c.id }, adminConsoleCertRef: { id: c.id }, activeRuntimeServerCerts: [{ id: c.id }], activeAdminConsoleCerts: [{ id: c.id }] }, [`/keyPairs/sslServer/${c.id}`]: c });

test('tls: an expired certificate with no SANs is replaced by idjagkit-local-tls (127.0.0.1 + localhost), only for the runtime', async () => {
  const f = fakePf(tlsSeed(cert()));
  const r = await quiet(() => tls.run(f.api));
  assert.equal(r.changed, true);
  assert.match(r.pem, /BEGIN CERTIFICATE/);
  const gen = f.calls.find((c) => c.path === '/keyPairs/sslServer/generate').body;
  assert.equal(gen.id, 'idjagkit-local-tls');
  assert.equal(gen.commonName, '127.0.0.1');
  assert.deepEqual(gen.subjectAlternativeNames, ['127.0.0.1', 'localhost']);
  const s = f.store.get('/keyPairs/sslServer/settings');
  assert.equal(s.runtimeServerCertRef.id, 'idjagkit-local-tls');
  assert.deepEqual(s.activeRuntimeServerCerts, [{ id: 'idjagkit-local-tls' }]);
  assert.equal(s.adminConsoleCertRef.id, 'old', 'the admin console keeps its own certificate');
});

test('tls: a rerun keeps the good certificate and still exports it', async () => {
  const f = fakePf(tlsSeed(cert()));
  await quiet(() => tls.run(f.api));
  const before = f.writes().length;
  const r = await quiet(() => tls.run(f.api));
  assert.equal(r.changed, false);
  assert.match(r.pem, /BEGIN CERTIFICATE/);
  assert.equal(f.writes().length, before, 'no write on the second run');
});

test('tls: a valid certificate that already has both SANs is left alone', async () => {
  const good = cert({ id: 'good', expires: new Date(Date.now() + 400 * DAY).toISOString(), status: 'VALID', subjectAlternativeNames: ["IP: '127.0.0.1'", "DNS: 'localhost'"] });
  const f = fakePf(tlsSeed(good));
  const r = await quiet(() => tls.run(f.api));
  assert.equal(r.changed, false);
  assert.equal(f.writes().length, 0);
});

test('tls: a certificate missing one SAN, or expiring within 30 days, is replaced; a CA-signed one is not pinned', async () => {
  const soon = new Date(Date.now() + 10 * DAY).toISOString();
  assert.match(tls.problem(cert({ status: 'VALID', expires: new Date(Date.now() + 400 * DAY).toISOString(), subjectAlternativeNames: ['localhost'] })), /no SAN for 127\.0\.0\.1/);
  assert.match(tls.problem(cert({ status: 'VALID', expires: soon, subjectAlternativeNames: ['127.0.0.1', 'localhost'] })), /expires/);
  assert.match(tls.problem(cert({ status: 'VALID', expires: new Date(Date.now() + 400 * DAY).toISOString(), subjectAlternativeNames: ["IP: '127.0.0.1'", "DNS: 'LocalHost'"] })) ?? 'none', /none/, 'SAN type prefixes and case are ignored');
  const signed = cert({ id: 'ca', issuerDN: 'CN=Some CA', expires: new Date(Date.now() + 400 * DAY).toISOString(), status: 'VALID', subjectAlternativeNames: ['127.0.0.1', 'localhost'] });
  const r = await quiet(() => tls.run(fakePf(tlsSeed(signed)).api));
  assert.equal(r.pem, undefined, 'nothing to pin: the system roots decide');
});

test('tls: an expired idjagkit-local-tls of ours that is still active (PingFederate will not delete it) gets a dated one beside it', async () => {
  const f = fakePf({ ...tlsSeed(cert({ id: 'idjagkit-local-tls' })) });
  const r = await quiet(() => tls.run(f.api, { now: Date.parse('2026-11-02T12:00:00Z') }));
  assert.equal(r.changed, true);
  assert.ok(!f.calls.some((c) => c.method === 'DELETE'));
  assert.equal(f.store.get('/keyPairs/sslServer/settings').runtimeServerCertRef.id, 'idjagkit-local-tls-20261102');
  assert.ok(f.store.has('/keyPairs/sslServer/idjagkit-local-tls'), 'the old one is left in place');
  assert.equal((await quiet(() => tls.run(f.api, { now: Date.parse('2026-11-02T12:00:00Z') }))).changed, false, 'and a rerun keeps the new one');
});

// ---- configure-idjag-issuer ----
const JWT_DESC = '/oauth/accessTokenManagers/descriptors/com.pingidentity.pf.access.token.management.plugins.JwtBearerAccessTokenManagementPlugin';
const issuerSeed = () => ({
  '/oauth/authServerSettings': { scopes: [{ name: 'openid' }] },
  '/keyPairs/oauthOpenIdConnect': { staticJwksEnabled: false, publishDynamicKeyX5cs: false },
  '/oauth/tokenExchange/processor/settings': {},
  '/oauth/clients/id-jag-kit': { clientId: 'id-jag-kit', redirectUris: ['x'] },
  [JWT_DESC]: { configDescriptor: { fields: [{ name: 'Token Lifetime', defaultValue: 120 }, { name: 'JWS Algorithm' }] } },
});
const O = { pfUrl: PF_URL, resourceAs: 'http://localhost:9080', resource: 'http://localhost:9090/mcp', client: 'id-jag-kit', resourceAsClient: 'id-jag-playground' };

test('issuer: creates the key, publisher, static JWKS, processor, policy, client link and SP connection', async () => {
  const f = fakePf(issuerSeed());
  await quiet(() => issuer.run(f.api, O));
  assert.ok(f.store.has('/keyPairs/signing/idjagkit-signing'));
  const publisher = f.store.get('/oauth/accessTokenManagers/idJagKitKeyPublisher');
  const field = (n) => publisher.configuration.fields.find((x) => x.name === n)?.value;
  assert.equal(field('Publish Keys to the PingFederate JWKS Endpoint'), 'true');
  assert.equal(field('Active Signing Certificate Key ID'), 'idjagkit-signing');
  assert.equal(field('Issuer Claim Value'), PF_URL);
  assert.equal(field('JWS Algorithm'), 'RS256');
  assert.deepEqual(publisher.configuration.tables[0].rows[0].fields.map((x) => x.value), ['idjagkit-signing', 'idjagkit-signing']);
  const jwks = f.store.get('/keyPairs/oauthOpenIdConnect');
  assert.equal(jwks.staticJwksEnabled, true);
  assert.equal(jwks.rsaActiveCertRef.id, 'idjagkit-signing');
  assert.equal(jwks.publishDynamicKeyX5cs, false);
  assert.ok(f.store.has('/idp/tokenProcessors/idJagKitRefreshToken'));
  assert.equal(f.store.get('/oauth/tokenExchange/processor/settings').defaultProcessorPolicyRef.id, 'idJagKitPolicy');
  assert.equal(f.store.get('/oauth/clients/id-jag-kit').tokenExchangeProcessorPolicyRef.id, 'idJagKitPolicy');
  const sp = f.store.get('/idp/spConnections/idJagKitResourceAsSp');
  assert.equal(sp.entityId, 'http://localhost:9080');
  assert.deepEqual(sp.oauthTokenExchangeSettings.resourceUris, ['http://localhost:9090/mcp']);
  assert.equal(sp.oauthTokenExchangeSettings.idJagEnabled, true);
  assert.equal(sp.credentials.signingSettings.signingKeyPairRef.id, 'idjagkit-signing');
  const m = sp.oauthTokenExchangeSettings.processorPolicyMappings[0].attributeContractFulfillment;
  assert.deepEqual([m.client_id.value, m.scope.value], ['id-jag-playground', 'read mcp:invoke']);
  for (const name of ['read', 'mcp:invoke']) assert.ok(f.calls.some((c) => c.path === '/oauth/authServerSettings/scopes/commonScopes' && c.body.name === name));
});

test('issuer: a second run writes nothing', async () => {
  const f = fakePf(issuerSeed());
  await quiet(() => issuer.run(f.api, O));
  // PingFederate fills in defaults on what it stores; mimic the SP connection round trip.
  f.store.get('/idp/spConnections/idJagKitResourceAsSp').oauthTokenExchangeSettings.processorPolicyMappings[0].attributeContractFulfillment.extra = { source: { type: 'NO_MAPPING' } };
  f.store.set('/oauth/authServerSettings', { scopes: [{ name: 'openid' }, { name: 'read' }, { name: 'mcp:invoke' }] });
  const before = f.writes().length;
  await quiet(() => issuer.run(f.api, O));
  assert.equal(f.writes().length, before);
});

test('issuer: an SP connection that also carries the desktop clients\' mapping keeps it when ours changes', async () => {
  const f = fakePf(issuerSeed());
  await quiet(() => issuer.run(f.api, O));
  const sp = f.store.get('/idp/spConnections/idJagKitResourceAsSp');
  sp.oauthTokenExchangeSettings.processorPolicyMappings.push({ processorPolicyRef: { id: 'idJagKitIdTokenPolicy' }, attributeContractFulfillment: {} });
  await quiet(() => issuer.run(f.api, { ...O, resourceAsClient: 'another-client' }));
  const maps = f.store.get('/idp/spConnections/idJagKitResourceAsSp').oauthTokenExchangeSettings.processorPolicyMappings;
  assert.deepEqual(maps.map((x) => x.processorPolicyRef.id).sort(), ['idJagKitIdTokenPolicy', 'idJagKitPolicy']);
  assert.equal(maps.find((x) => x.processorPolicyRef.id === 'idJagKitPolicy').attributeContractFulfillment.client_id.value, 'another-client');
});

test('issuer: an existing default exchange policy is not replaced; only idJagKit ids and the kit client are touched', async () => {
  const seed = issuerSeed();
  seed['/oauth/tokenExchange/processor/settings'] = { defaultProcessorPolicyRef: { id: 'someoneElses' } };
  const f = fakePf(seed);
  await quiet(() => issuer.run(f.api, O));
  assert.equal(f.store.get('/oauth/tokenExchange/processor/settings').defaultProcessorPolicyRef.id, 'someoneElses');
  const touched = f.writes().map((c) => c.path).filter((p) => !/idJagKit|idjagkit|commonScopes|oauthOpenIdConnect|\/oauth\/clients\/id-jag-kit$|\/keyPairs\/signing\/generate|\/idp\/spConnections$|\/idp\/tokenProcessors$|\/oauth\/(accessTokenManagers|tokenExchange\/processor\/policies)$/.test(p));
  assert.deepEqual(touched, [], 'nothing outside the kit\'s own objects is written');
});

test('issuer: no sign-in client yet is reported, not invented', async () => {
  const seed = issuerSeed();
  delete seed['/oauth/clients/id-jag-kit'];
  const f = fakePf(seed);
  await quiet(() => issuer.run(f.api, O));
  assert.ok(!f.store.has('/oauth/clients/id-jag-kit'));
  assert.equal(pf.hasFailed(), true);
});

// ---- the local-only guard and the redirect URIs ----
import { spawnSync } from 'node:child_process';
const script = (name, env) => spawnSync(process.execPath, [new URL(`../pingfederate/${name}`, import.meta.url).pathname], { encoding: 'utf8', env: { PATH: process.env.PATH, PF_ADMIN_PASSWORD: 'x', ...env } });

test('the local scripts refuse any admin API that is not loopback, and run only with PF_ADMIN_URL', () => {
  for (const name of ['configure-base-url.js', 'configure-local-tls.js', 'configure-idjag-issuer.js']) {
    for (const env of [{}, { PF_ADMIN_URL: 'https://pf-acme.example.invalid:9999' }, { PF_ADMIN_URL: 'https://10.0.0.5:4731' }]) {
      const r = script(name, { PF_URL, ...env });
      assert.equal(r.status, 2, `${name} ${JSON.stringify(env)}`);
      assert.match(r.stderr, /local PingFederate/);
    }
  }
});

test('signinRedirects: a local origin registers localhost, 127.0.0.1 and the default port; others register just their own', () => {
  const cb = (o) => [`${o}/auth/callback`, `${o}/api/id-jag-playground/issuer/callback`];
  assert.deepEqual(pf.signinRedirects('http://localhost:4720'), [...cb('http://localhost:4720'), ...cb('http://127.0.0.1:4720')]);
  assert.deepEqual(new Set(pf.signinRedirects('http://localhost:4724')), new Set([...cb('http://localhost:4724'), ...cb('http://127.0.0.1:4724'), ...cb('http://localhost:4720'), ...cb('http://127.0.0.1:4720')]));
  assert.deepEqual(pf.signinRedirects('https://kit.example.invalid'), cb('https://kit.example.invalid'));
});
