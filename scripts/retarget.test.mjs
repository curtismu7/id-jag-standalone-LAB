// sync-id-jag-trusted-idps.js and configure-kid-workaround.js were copied from AI-DEMO2. They now work on the kit's own local
// PingFederate only: no AI-DEMO2 container, registry, token manager, namespace or "idjag-" id may remain in them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fakePf } from './fake-pf.mjs';

process.env.PF_SETTINGS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retarget-')), 'settings.env');
const require = createRequire(import.meta.url);
const sync = require('../pingfederate/sync-id-jag-trusted-idps.js');
const kid = require('../pingfederate/configure-kid-workaround.js');
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

const FILES = ['sync-id-jag-trusted-idps.js', 'configure-kid-workaround.js'];
const AI_DEMO2 = /ai-?demo|aiDemo|demo-namespace|ping-devops|["'`]idjag-|pingfederate-admin|\bkubectl\b|docker['"]?,\s*\[?['"]exec|localhost:4000|:19999|PINGFEDERATE_NAMESPACE|--target/i;

test('no AI-DEMO2 container, registry, token manager, namespace, cluster or "idjag-" id remains', () => {
  for (const f of FILES) {
    const text = fs.readFileSync(new URL(`../pingfederate/${f}`, import.meta.url), 'utf8');
    const hits = text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => AI_DEMO2.test(l));
    assert.deepEqual(hits, [], `${f}: ${hits.map(([n]) => n).join(', ')}`);
  }
});

test('both scripts are local-only: loopback admin API through pf-admin direct mode', () => {
  for (const f of FILES) {
    const text = fs.readFileSync(new URL(`../pingfederate/${f}`, import.meta.url), 'utf8');
    assert.match(text, /pf\.requireLocalAdmin\(\)/, f);
    assert.match(text, /adminApi\('direct', 0\)/, f);
  }
});

// ---- sync ----
const idps = [{ id: 'acme', name: 'Acme', issuer: 'https://idp.example.invalid', jwksUrl: 'https://idp.example.invalid/jwks' }];

test('sync: one kit-prefixed IdP connection per registry entry, mapped into the redeemer token manager; a rerun changes nothing', async () => {
  const f = fakePf();
  const log = [];
  const a = await sync.sync(f.api, idps, { log: (l) => log.push(l) });
  assert.equal(a.changed, true);
  const c = f.store.get('/sp/idpConnections/idJagKit-acme');
  assert.equal(c.entityId, 'https://idp.example.invalid');
  assert.equal(c.idpBrowserSso.oidcProviderSettings.jwksURL, 'https://idp.example.invalid/jwks');
  assert.equal(c.idpOAuthGrantAttributeMapping.accessTokenManagerMappings[0].accessTokenManagerRef.id, 'idJagKitRedeemerAtm');
  assert.deepEqual(Object.keys(c.idpOAuthGrantAttributeMapping.accessTokenManagerMappings[0].attributeContractFulfillment), ['sub', 'client_id', 'scope']);
  const before = f.writes().length;
  const b = await sync.sync(f.api, idps, { log: (l) => log.push(l) });
  assert.equal(b.changed, false);
  assert.equal(f.writes().length, before);
  assert.ok(log.some((l) => /keep idJagKit-acme/.test(l)));
});

test('sync: an issuer another connection already trusts is skipped, --dry-run writes nothing, a changed JWKS URL updates', async () => {
  const f = fakePf({ '/sp/idpConnections/someones-own': { id: 'someones-own', entityId: 'https://idp.example.invalid' } });
  const log = [];
  await sync.sync(f.api, idps, { log: (l) => log.push(l) });
  assert.deepEqual(f.writes(), []);
  assert.match(log.join('\n'), /skip https:\/\/idp\.example\.invalid: already trusted by connection someones-own/);
  const g = fakePf();
  await sync.sync(g.api, idps, { dry: true, log: () => {} });
  assert.deepEqual(g.writes(), []);
  await sync.sync(g.api, idps, { log: () => {} });
  const moved = [{ ...idps[0], jwksUrl: 'https://idp.example.invalid/other-jwks' }];
  const r = await sync.sync(g.api, moved, { log: () => {} });
  assert.equal(r.changed, true);
  assert.equal(g.store.get('/sp/idpConnections/idJagKit-acme').idpBrowserSso.oidcProviderSettings.jwksURL, 'https://idp.example.invalid/other-jwks');
});

test('sync: connection ids are kit-prefixed, safe and at most 32 characters', () => {
  assert.equal(sync.connectionId({ id: 'a b/c' }), 'idJagKit-a-b-c');
  assert.equal(sync.connectionId({ id: 'x'.repeat(60) }).length, 32);
  assert.ok(sync.connectionId({ id: 'z' }).startsWith(sync.PREFIX));
});

// ---- kid workaround ----
const JWT_ATM = {
  id: 'idJagKitKeyPublisher',
  configuration: { fields: ['Include Key ID Header Parameter', 'Type Header Value', 'Audience Claim Value', 'Issuer Claim Value', 'Token Lifetime', 'Publish Keys to the PingFederate JWKS Endpoint']
    .map((name) => ({ name, value: 'x' })), tables: [] },
};
const kidSeed = () => ({ '/oauth/tokenExchange/processor/settings': { defaultProcessorPolicyRef: { id: 'idJagKitPolicy' } }, '/oauth/accessTokenManagers/idJagKitKeyPublisher': JWT_ATM });

test('kid workaround: clones the kit\'s own token manager, maps the kit\'s exchange policy, creates the id-jag-kit-kid client', async () => {
  const f = fakePf(kidSeed());
  await quiet(() => kid.run(f.api, { pfUrl: 'https://127.0.0.1:4732' }));
  const atm = f.store.get('/oauth/accessTokenManagers/idJagKidWaMotd');
  const field = (n) => atm.configuration.fields.find((x) => x.name === n).value;
  assert.equal(field('Issuer Claim Value'), 'https://127.0.0.1:4732');
  assert.equal(field('Include Key ID Header Parameter'), 'true');
  assert.equal(field('Publish Keys to the PingFederate JWKS Endpoint'), 'false');
  assert.deepEqual(atm.selectionSettings.resourceUris, ['https://motd.xaa.rocks/mcp']);
  const mapping = f.calls.find((c) => c.method === 'POST' && c.path === '/oauth/accessTokenMappings').body;
  assert.equal(mapping.context.contextRef.id, 'idJagKitPolicy');
  assert.equal(mapping.attributeContractFulfillment.sub.value, 'id-jag-kit-lab-subject');
  assert.equal(f.store.get('/oauth/clients/id-jag-kit-kid').clientId, 'id-jag-kit-kid');
  const secret = fs.readFileSync(process.env.PF_SETTINGS_FILE, 'utf8');
  assert.match(secret, /^INTEROP_KID_CLIENT_ID=id-jag-kit-kid$/m);
  assert.match(secret, /^INTEROP_KID_CLIENT_SECRET=\S{20,}$/m);
});

test('kid workaround: refuses before the kit\'s issuer setup, and --remove deletes what it made', async () => {
  const none = fakePf();
  await assert.rejects(() => quiet(() => kid.run(none.api, {})), /no default token exchange processor policy/);
  const noAtm = fakePf({ '/oauth/tokenExchange/processor/settings': { defaultProcessorPolicyRef: { id: 'idJagKitPolicy' } } });
  await assert.rejects(() => quiet(() => kid.run(noAtm.api, {})), /idJagKitKeyPublisher .*missing/);
  const f = fakePf(kidSeed());
  await quiet(() => kid.run(f.api, {}));
  await quiet(() => kid.run(f.api, { remove: true }));
  assert.ok(!f.store.has('/oauth/accessTokenManagers/idJagKidWaMotd'));
  assert.ok(!f.store.has('/oauth/clients/id-jag-kit-kid'));
  assert.ok(f.store.has('/oauth/accessTokenManagers/idJagKitKeyPublisher'), 'the source token manager is never deleted');
});
