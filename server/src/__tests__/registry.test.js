import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import registry from '../registry/routes.js';
import { discover, getJson, guardedLookup, isPrivateAddress, testIdp } from '../registry/net.js';

const ORIGIN = 'https://app.test';
const BEARER = 'Bearer registry-test-token';
const OWNER = { email: 'olivia@pingidentity.com', name: 'Olivia', isAdmin: false };
const OTHER = { email: 'oscar@pingone.com', name: 'Oscar', isAdmin: false };
const ADMIN = { email: 'ada@pingidentity.com', name: 'Ada', isAdmin: true };
const ENTRY = {
  id: 'acme', name: 'Acme PingFederate', product: 'pingfederate', issuer: 'https://acme.example.com',
  jwksUrl: 'https://acme.example.com/pf/JWKS', idJagClientId: 'acme-agent', scopes: 'read mcp:invoke', targets: ['resource-as'],
};

let dataDir;
let clientsFile;
let logs;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-reg-'));
  clientsFile = path.join(dataDir, 'shared', 'clients.json');
  fs.mkdirSync(path.dirname(clientsFile));
  fs.writeFileSync(clientsFile, JSON.stringify([{ client_id: 'id-jag-playground', client_secret_hash: 'a'.repeat(64), scope: 'read' }]));
  vi.stubEnv('DATA_DIR', dataDir);
  vi.stubEnv('APP_ORIGIN', ORIGIN);
  vi.stubEnv('ID_JAG_REGISTRY_TOKEN', 'registry-test-token');
  vi.stubEnv('RESOURCE_AS_CLIENTS_FILE', clientsFile);
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error']) vi.spyOn(console, level).mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function as(user) {
  const app = express();
  app.use((req, _res, next) => { req.session = user ? { user } : {}; next(); });
  app.use('/r', registry);
  const call = (method, p, body) => {
    const r = request(app)[method](`/r${p}`).set('Origin', ORIGIN);
    return body === undefined ? r : r.send(body);
  };
  return { get: (p) => request(app).get(`/r${p}`), post: (p, b = {}) => call('post', p, b), put: (p, b) => call('put', p, b), del: (p) => call('delete', p), app };
}
const owner = () => as(OWNER);
const admin = () => as(ADMIN);
const publicIds = async () => (await as(null).get('/registry').set('Authorization', BEARER)).body.idps.map((e) => e.id);
const clients = () => JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const auditLog = () => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8');

describe('registry v2 lifecycle', () => {
  it('a signed-in user registers; the entry is pending and NOT trusted', async () => {
    const res = await owner().post('', ENTRY);
    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ id: 'acme', status: 'pending', owner: OWNER.email, product: 'pingfederate', clientId: 'idp-acme' }));
    expect(await publicIds()).toEqual([]);
    expect((await as(null).get('/pingfederate').set('Authorization', BEARER)).body.idps).toEqual([]);
    expect((await as(null).get('')).body.idps).toEqual([]);
    expect((await owner().get('/mine')).body.idps.map((e) => e.id)).toEqual(['acme']);
    expect((await as(OTHER).get('/mine')).body.idps).toEqual([]);
  });

  it('registering needs a signed-in user and a same-origin request', async () => {
    expect((await as(null).post('', ENTRY)).status).toBe(401);
    expect((await request(owner().app).post('/r').set('Origin', 'https://evil.test').send(ENTRY)).status).toBe(403);
  });

  it('ignores status, owner and clientId in the request body', async () => {
    const res = await owner().post('', { ...ENTRY, status: 'approved', owner: 'admin@pingidentity.com', clientId: 'id-jag-playground' });
    expect(res.body).toEqual(expect.objectContaining({ status: 'pending', owner: OWNER.email, clientId: 'idp-acme' }));
  });

  it('admin approval trusts the entry and provisions a locked client; the owner gets the secret once', async () => {
    await owner().post('', ENTRY);
    expect((await owner().post('/acme/approve')).status).toBe(403);
    const ok = await admin().post('/acme/approve');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual(expect.objectContaining({ status: 'approved', reviewedBy: ADMIN.email }));
    expect(JSON.stringify(ok.body)).not.toMatch(/secret"?\s*:\s*"/i);
    expect((await as(null).get('/registry').set('Authorization', BEARER)).body.idps).toEqual([{
      id: 'acme', issuer: ENTRY.issuer, jwksUrl: ENTRY.jwksUrl, clientAliases: { 'acme-agent': 'idp-acme' }, scopes: 'read mcp:invoke',
    }]);
    const provisioned = clients().find((c) => c.client_id === 'idp-acme');
    expect(provisioned).toEqual({ client_id: 'idp-acme', client_secret_hash: expect.stringMatching(/^[0-9a-f]{64}$/), scope: 'read mcp:invoke' });
    expect(clients().find((c) => c.client_id === 'id-jag-playground')).toBeTruthy(); // others kept

    // only the owner may fetch (= rotate) the secret; each call shows a new one once
    expect((await admin().post('/acme/secret')).status).toBe(403);
    expect((await as(OTHER).post('/acme/secret')).status).toBe(403);
    const s1 = await owner().post('/acme/secret');
    expect(s1.status).toBe(200);
    expect(s1.headers['cache-control']).toBe('no-store');
    expect(s1.body).toEqual({ clientId: 'idp-acme', clientSecret: expect.stringMatching(/^[\w-]{40,}$/) });
    expect(clients().find((c) => c.client_id === 'idp-acme').client_secret_hash).toBe(sha256(s1.body.clientSecret));
    const s2 = await owner().post('/acme/secret');
    expect(s2.body.clientSecret).not.toBe(s1.body.clientSecret);
    expect(clients().find((c) => c.client_id === 'idp-acme').client_secret_hash).toBe(sha256(s2.body.clientSecret));

    // never again in a read, the audit log or a log line
    const reads = [(await owner().get('/mine')).text, (await admin().get('/all')).text, (await admin().get('/audit')).text, auditLog(), logs.join('\n')];
    for (const text of reads) {
      expect(text).not.toContain(s1.body.clientSecret);
      expect(text).not.toContain(s2.body.clientSecret);
      expect(text).not.toContain(sha256(s2.body.clientSecret));
    }
    expect((await owner().get('/mine')).body.idps[0].secretIssuedAt).toEqual(expect.any(String));
  });

  it('no secret before approval, and none for a PingFederate-only entry', async () => {
    await owner().post('', ENTRY);
    expect((await owner().post('/acme/secret')).status).toBe(409);
    await owner().post('', { ...ENTRY, id: 'pf-only', issuer: 'https://pf-only.example.com', targets: ['pingfederate'] });
    await admin().post('/pf-only/approve');
    expect(clients().map((c) => c.client_id)).not.toContain('idp-pf-only');
    expect((await owner().post('/pf-only/secret')).status).toBe(409);
  });

  it('approval of a resource-as entry needs RESOURCE_AS_CLIENTS_FILE', async () => {
    vi.stubEnv('RESOURCE_AS_CLIENTS_FILE', '');
    await owner().post('', ENTRY);
    const res = await admin().post('/acme/approve');
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/RESOURCE_AS_CLIENTS_FILE/);
    expect(await publicIds()).toEqual([]);
  });

  it("an owner's edit to trust fields sends an approved entry back to pending and removes its client", async () => {
    await owner().post('', ENTRY);
    await admin().post('/acme/approve');
    expect((await owner().put('/acme', { ...ENTRY, name: 'Renamed' })).body.status).toBe('approved'); // cosmetic edit
    for (const change of [{ jwksUrl: 'https://acme.example.com/other-jwks' }, { issuer: 'https://acme2.example.com' }, { idJagClientId: 'x' }]) {
      await admin().post('/acme/approve');
      const res = await owner().put('/acme', { ...ENTRY, ...change });
      expect(res.body.status).toBe('pending');
      expect(await publicIds()).toEqual([]);
      expect(clients().map((c) => c.client_id)).not.toContain('idp-acme');
    }
  });

  it('approval is bound to the version the admin reviewed (updatedAt)', async () => {
    const created = (await owner().post('', ENTRY)).body;
    await owner().put('/acme', { ...ENTRY, jwksUrl: 'https://acme.example.com/swapped' }); // edited after the admin loaded it
    const stale = await admin().post('/acme/approve', { updatedAt: created.updatedAt });
    expect(stale.status).toBe(409);
    expect(await publicIds()).toEqual([]);
    const fresh = (await admin().get('/all')).body.idps[0];
    expect((await admin().post('/acme/approve', { updatedAt: fresh.updatedAt })).status).toBe(200);
  });

  it('a non-owner cannot edit, withdraw or rotate; an admin can edit and delete', async () => {
    await owner().post('', ENTRY);
    expect((await as(OTHER).put('/acme', { ...ENTRY, name: 'Hijack' })).status).toBe(403);
    expect((await as(OTHER).del('/acme')).status).toBe(403);
    expect((await owner().get('/mine')).body.idps[0].name).toBe('Acme PingFederate');
    expect((await admin().put('/acme', { ...ENTRY, name: 'Fixed by admin' })).body.name).toBe('Fixed by admin');
    expect((await as(OTHER).get('/all')).status).toBe(403);
    expect((await as(OTHER).get('/audit')).status).toBe(403);
    expect((await admin().del('/acme')).status).toBe(204);
    expect((await admin().get('/audit')).body.entries[0]).toEqual(expect.objectContaining({ action: 'delete', actor: ADMIN.email }));
  });

  it('owner withdraws: entry and client are gone', async () => {
    await owner().post('', ENTRY);
    await admin().post('/acme/approve');
    expect((await owner().del('/acme')).status).toBe(204);
    expect((await owner().get('/mine')).body.idps).toEqual([]);
    expect(await publicIds()).toEqual([]);
    expect(clients().map((c) => c.client_id)).toEqual(['id-jag-playground']);
    expect((await owner().del('/acme')).status).toBe(404);
  });

  it('reject needs a reason; the owner sees it and an edit resubmits', async () => {
    await owner().post('', ENTRY);
    expect((await admin().post('/acme/reject', {})).status).toBe(400);
    const rej = await admin().post('/acme/reject', { reason: 'JWKS publishes three RSA keys' });
    expect(rej.body).toEqual(expect.objectContaining({ status: 'rejected', reviewReason: 'JWKS publishes three RSA keys', reviewedBy: ADMIN.email }));
    expect((await owner().get('/mine')).body.idps[0].reviewReason).toBe('JWKS publishes three RSA keys');
    expect(await publicIds()).toEqual([]);
    expect((await owner().put('/acme', { ...ENTRY, name: 'Fixed' })).body.status).toBe('pending');
  });

  it('disable untrusts an approved entry and removes its client', async () => {
    await owner().post('', ENTRY);
    await admin().post('/acme/approve');
    expect((await admin().post('/acme/disable', { reason: 'partner offboarded' })).body.status).toBe('disabled');
    expect(await publicIds()).toEqual([]);
    expect(clients().map((c) => c.client_id)).not.toContain('idp-acme');
    expect((await admin().post('/acme/disable')).status).toBe(409);
  });

  it('every change lands in the append-only audit log, newest first, paged', async () => {
    await owner().post('', ENTRY);
    await admin().post('/acme/approve');
    await owner().post('/acme/secret');
    await owner().put('/acme', { ...ENTRY, jwksUrl: 'https://acme.example.com/k2' });
    await admin().post('/acme/reject', { reason: 'nope' });
    await owner().del('/acme');
    const all = (await admin().get('/audit')).body;
    expect(all.entries.map((e) => e.action)).toEqual(['withdraw', 'reject', 'update', 'rotate-secret', 'approve', 'create']);
    expect(all.entries.every((e) => e.at && e.id === 'acme')).toBe(true);
    expect(all.entries[0].actor).toBe(OWNER.email);
    expect(all.entries[1]).toEqual(expect.objectContaining({ actor: ADMIN.email, reason: 'nope' }));
    expect(all.entries[2].before.jwksUrl).toBe(ENTRY.jwksUrl);
    expect(all.entries[2].after).toEqual(expect.objectContaining({ jwksUrl: 'https://acme.example.com/k2', status: 'pending' }));
    const p1 = (await admin().get('/audit?limit=4')).body;
    expect(p1.entries.map((e) => e.action)).toEqual(['withdraw', 'reject', 'update', 'rotate-secret']);
    const p2 = (await admin().get(`/audit?limit=4&before=${p1.next}`)).body;
    expect(p2.entries.map((e) => e.action)).toEqual(['approve', 'create']);
    expect(p2.next).toBeNull();
  });

  it('migrates v1 entries to approved (or disabled), owned by system', async () => {
    fs.writeFileSync(path.join(dataDir, 'trusted-idps.json'), JSON.stringify([
      { id: 'old', name: 'Old', issuer: 'https://old.example.com', jwksUrl: 'https://old.example.com/jwks', idJagClientId: 'c', clientId: 'id-jag-playground', pfClientId: 'id-jag-redeemer', scopes: '', targets: ['resource-as'], enabled: true },
      { id: 'off', name: 'Off', issuer: 'https://off.example.com', jwksUrl: 'https://off.example.com/jwks', idJagClientId: 'c', clientId: 'id-jag-playground', pfClientId: 'id-jag-redeemer', scopes: '', targets: ['resource-as'], enabled: false },
    ]));
    expect(await publicIds()).toEqual(['old']);
    const all = (await admin().get('/all')).body.idps;
    expect(all.map((e) => [e.id, e.status, e.owner, e.product])).toEqual([['old', 'approved', 'system', 'generic'], ['off', 'disabled', 'system', 'generic']]);
    expect((await as(null).get('/registry').set('Authorization', BEARER)).body.idps[0].clientAliases).toEqual({ c: 'id-jag-playground' });
  });

  it('the public list (playground panel) shows approved entries without owner or review details', async () => {
    await owner().post('', ENTRY);
    await admin().post('/acme/approve');
    const { body } = await as(null).get('');
    expect(body.canManage).toBe(false);
    expect(body.idps).toEqual([expect.objectContaining({ id: 'acme', enabled: true })]);
    expect(body.idps[0]).not.toHaveProperty('owner');
    expect(body.idps[0]).not.toHaveProperty('reviewedBy');
  });

  it.each(['registry', 'pingfederate'])('/%s needs the shared registry token', async (p) => {
    const get = () => as(null).get(`/${p}`);
    expect((await get()).status).toBe(401);
    expect((await get().set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await get().set('Authorization', BEARER)).status).toBe(200);
    vi.stubEnv('ID_JAG_REGISTRY_TOKEN', '');
    expect((await get().set('Authorization', BEARER)).status).toBe(503);
  });

  it.each([
    ['loopback issuer', { issuer: 'https://127.0.0.1' }],
    ['localhost JWKS', { jwksUrl: 'https://localhost/jwks' }],
    ['private IPv6 JWKS', { jwksUrl: 'https://[fd00::1]/jwks' }],
    ['metadata IP', { jwksUrl: 'https://169.254.169.254/latest' }],
    ['unknown product', { product: 'azure' }],
  ])('rejects a %s at registration', async (_n, over) => {
    expect((await owner().post('', { ...ENTRY, ...over })).status).toBe(400);
  });

  it('ALLOW_PRIVATE_ISSUERS=true lets a private issuer register (dev)', async () => {
    vi.stubEnv('ALLOW_PRIVATE_ISSUERS', 'true');
    expect((await owner().post('', { ...ENTRY, issuer: 'https://localhost:9031', jwksUrl: 'https://localhost:9031/pf/JWKS' })).status).toBe(201);
  });
});

describe('discovery', () => {
  const META = { issuer: 'https://idp.example.com', jwks_uri: 'https://idp.example.com/jwks', token_endpoint: 'https://idp.example.com/token' };

  it('reads jwks_uri from openid-configuration', async () => {
    const fetchJson = vi.fn(async () => META);
    expect(await discover('https://idp.example.com', { fetchJson })).toEqual(expect.objectContaining({ issuer: META.issuer, jwksUrl: META.jwks_uri }));
    expect(fetchJson).toHaveBeenCalledWith('https://idp.example.com/.well-known/openid-configuration');
  });

  it('falls back to RFC 8414 oauth-authorization-server (path inserted after the host)', async () => {
    const issuer = 'https://org.example.com/oauth2/default';
    const fetchJson = vi.fn(async (url) => {
      if (url.includes('openid-configuration')) throw new Error('HTTP 404');
      return { ...META, issuer };
    });
    expect((await discover(issuer, { fetchJson })).jwksUrl).toBe(META.jwks_uri);
    expect(fetchJson.mock.calls.map((c) => c[0])).toEqual([
      'https://org.example.com/oauth2/default/.well-known/openid-configuration',
      'https://org.example.com/.well-known/oauth-authorization-server/oauth2/default',
    ]);
  });

  it('refuses metadata whose issuer is not exactly the one asked for', async () => {
    const fetchJson = async () => ({ ...META, issuer: 'https://idp.example.com/' });
    await expect(discover('https://idp.example.com', { fetchJson })).rejects.toThrow(/issuer/);
  });

  it('refuses http issuers and an http jwks_uri', async () => {
    await expect(discover('http://idp.example.com', { fetchJson: async () => META })).rejects.toThrow(/https/);
    await expect(discover('https://idp.example.com', { fetchJson: async () => ({ ...META, jwks_uri: 'http://idp.example.com/jwks' }) })).rejects.toThrow(/https/);
  });
});

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::127.0.0.1', '::ffff:0:10.0.0.1',
  ])('treats %s as private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('treats %s as public', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('refuses a hostname that resolves to a private address, at connect time', async () => {
    const fakeDns = (_host, _opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    const err = await new Promise((resolve) => guardedLookup(fakeDns)('rebind.example.com', { all: true }, resolve));
    expect(err?.code).toBe('EPRIVATE');
    const ok = await new Promise((resolve) => guardedLookup((_h, _o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]))('a.example.com', {}, (...a) => resolve(a)));
    expect(ok).toEqual([null, '93.184.216.34', 4]);
  });

  it('refuses literal private hosts before connecting', async () => {
    await expect(getJson('https://127.0.0.1/jwks')).rejects.toThrow(/private|loopback/);
    await expect(getJson('https://[::1]/jwks')).rejects.toThrow(/private|loopback/);
    await expect(getJson('http://example.com/jwks')).rejects.toThrow(/https/);
  });
});

describe('Test this IdP', () => {
  const rsa = (n, extra = {}) => ({ kty: 'RSA', n, e: 'AQAB', alg: 'RS256', ...extra });

  it('reports keys, kid/x5t coverage and distinct RSA keys', async () => {
    const jwks = { keys: [rsa('n1', { kid: 'a', x5t: 't1' }), rsa('n1', { kid: 'b', x5t: 't1' }), { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', alg: 'ES256' }] };
    const r = await testIdp({ jwksUrl: 'https://idp.example.com/jwks', targets: ['pingfederate'] }, { fetchJson: async () => jwks });
    expect(r).toEqual(expect.objectContaining({ keyCount: 3, distinctRsaKeys: 1, withKid: 2, withX5t: 2, warnings: [] }));
    expect(r.keys[2]).toEqual({ kty: 'EC', alg: 'ES256', use: null, kid: null, x5t: null });
  });

  it('warns about several distinct RSA keys when PingFederate redeems', async () => {
    const jwks = { keys: [rsa('n1', { x5t: 't1' }), rsa('n2', { x5t: 't2' })] };
    const pf = await testIdp({ jwksUrl: 'https://idp.example.com/jwks', targets: ['resource-as', 'pingfederate'] }, { fetchJson: async () => jwks });
    expect(pf.distinctRsaKeys).toBe(2);
    expect(pf.warnings.join(' ')).toMatch(/PingFederate's JWT-bearer consumer cannot pick a key by x5t; publish a single-key JWKS/);
    const as = await testIdp({ jwksUrl: 'https://idp.example.com/jwks', targets: ['resource-as'] }, { fetchJson: async () => jwks });
    expect(as.warnings).toEqual([]);
  });

  it('flags an empty JWKS', async () => {
    const r = await testIdp({ jwksUrl: 'https://idp.example.com/jwks', targets: [] }, { fetchJson: async () => ({ keys: [] }) });
    expect(r.warnings.join(' ')).toMatch(/no keys/);
  });

  it('is behind sign-in and same-origin', async () => {
    expect((await as(null).post('/test', { jwksUrl: 'https://idp.example.com/jwks' })).status).toBe(401);
    expect((await as(null).post('/discover', { issuer: 'https://idp.example.com' })).status).toBe(401);
    expect((await owner().post('/test', { jwksUrl: 'https://127.0.0.1/jwks' })).status).toBe(400);
  });
});
