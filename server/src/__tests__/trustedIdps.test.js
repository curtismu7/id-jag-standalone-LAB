import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import router from '../idJagPlayground.js';
import * as trustedIdps from '../trustedIdps.js';

const ORIGIN = 'https://app.test';
const PF = 'https://pf.test';
const AS = 'https://mcp-as.test';
const OUT = 'https://idp.partner.test';

const ENTRY = {
  id: 'partner', name: 'Partner IdP', issuer: OUT, jwksUrl: `${OUT}/jwks`, idJagClientId: 'partner-knows-us-as',
  scopes: 'mcp:read', targets: ['resource-as', 'pingfederate'],
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const theirIdJag = (over = {}) => `${b64({ alg: 'RS256', typ: 'oauth-id-jag+jwt', x5t: 'k1' })}.${b64({
  iss: OUT, sub: 'alice', aud: AS, client_id: 'partner-knows-us-as', jti: 'j9', iat: now(), exp: now() + 300, scope: 'mcp:read', ...over,
})}.c2lnbmF0dXJl`;
const accessToken = `${b64({ alg: 'RS256' })}.${b64({ iss: AS, sub: 'alice', scope: 'mcp:read' })}.c2ln`;
const reply = (status, data) => ({ status, json: async () => data });

let dataDir;
let fetchMock;
function appWith(session = {}) {
  const app = express();
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/pg', router);
  return app;
}
// A v1-format registry file: entries migrate to approved (owner system) and keep their client ids.
const seed = (...entries) => fs.writeFileSync(path.join(dataDir, 'trusted-idps.json'), JSON.stringify(entries.map((e) => ({
  clientId: 'id-jag-playground', pfClientId: 'id-jag-redeemer', scopes: '', enabled: true, ...e,
}))));
const send = (app, method, p, body) => request(app)[method](p).set('Origin', ORIGIN).send(body);
const sentForm = (i) => new URLSearchParams(fetchMock.mock.calls[i][1].body);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-'));
  vi.stubEnv('DATA_DIR', dataDir);
  vi.stubEnv('APP_ORIGIN', ORIGIN);
  vi.stubEnv('PF_URL', PF);
  vi.stubEnv('RESOURCE_AS_ISSUER', AS);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('trusted-IdP registry module (v2)', () => {
  const OWNER = 'olivia@pingidentity.com';

  it('creates a pending entry with defaults and persists atomically as JSON under DATA_DIR', async () => {
    const e = await trustedIdps.create({ ...ENTRY, scopes: '  mcp:read   mcp:write ' }, OWNER);
    expect(e).toEqual(expect.objectContaining({
      clientId: 'idp-partner', pfClientId: 'id-jag-redeemer', scopes: 'mcp:read mcp:write', status: 'pending', owner: OWNER, product: 'generic',
    }));
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'trusted-idps.json'), 'utf8'))).toHaveLength(1);
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([]); // no temp file left behind
    expect(trustedIdps.findByIssuer(OUT)).toBeNull(); // pending is not trusted
  });

  it.each([
    ['http issuer', { issuer: 'http://idp.test' }, /issuer must be an https URL/],
    ['bad jwks', { jwksUrl: 'not a url' }, /jwksUrl must be an https URL/],
    ['bad slug', { id: 'Has Spaces' }, /slug/],
    ['no name', { name: ' ' }, /name is required/],
    ['bad target', { targets: ['okta'] }, /targets/],
    ['old demo target', { targets: ['oauth-mcp'] }, /targets/],
    ['no targets', { targets: [] }, /targets/],
    ['no idJagClientId', { idJagClientId: '' }, /idJagClientId/],
    ['non-string scopes', { scopes: ['a'] }, /scopes/],
    ['bad product', { product: 'azure' }, /product/],
  ])('rejects %s', async (_n, over, msg) => {
    await expect(trustedIdps.create({ ...ENTRY, ...over }, OWNER)).rejects.toThrow(msg);
  });

  it('keeps id and issuer unique, but lets an entry update itself', async () => {
    await trustedIdps.create(ENTRY, OWNER);
    await expect(trustedIdps.create({ ...ENTRY, issuer: 'https://other.test' }, OWNER)).rejects.toThrow(/already used/);
    await expect(trustedIdps.create({ ...ENTRY, id: 'two' }, OWNER)).rejects.toThrow(/already registered/);
    expect((await trustedIdps.update('partner', { ...ENTRY, name: 'Renamed' }, OWNER)).name).toBe('Renamed');
    await expect(trustedIdps.update('nope', ENTRY, OWNER)).rejects.toThrow(/no trusted IdP/);
  });

  it('a corrupt file reads as an empty registry', () => {
    fs.writeFileSync(path.join(dataDir, 'trusted-idps.json'), '{not json');
    expect(trustedIdps.list()).toEqual([]);
  });
});

describe('byo mode: your IdP -> our resource AS', () => {
  const byoSession = () => ({ idJagPlaygroundMode: 'byo', save: (cb) => cb() });
  beforeEach(() => fetchMock.mockResolvedValue(reply(200, { keys: [] }))); // JWKS: no key, signature fails, no network

  it('is always offered and selectable', async () => {
    const res = await send(appWith({ save: (cb) => cb() }), 'post', '/pg/mode', { mode: 'byo' });
    expect(res.body.mode).toBe('byo');
    expect(res.body.modes.find((m) => m.id === 'byo')).toEqual(expect.objectContaining({ available: true, label: 'Your IdP → our resource AS' }));
    expect(res.body.publicEndpoints['resource-as']).toEqual({ issuer: AS, tokenEndpoint: `${AS}/token` });
    expect(res.body.publicEndpoints.pingfederate).toEqual({ issuer: PF, tokenEndpoint: `${PF}/as/token.oauth2` });
  });

  it('unknown issuer fails "Issuer is a trusted IdP" with a hint and stores nothing', async () => {
    const session = byoSession();
    const res = await send(appWith(session), 'post', '/pg/byo/inspect', { idJag: theirIdJag({ iss: 'https://stranger.test' }) });
    expect(res.body.trusted).toBe(false);
    expect(res.body.checks).toEqual([expect.objectContaining({ id: 'trusted-idp', status: 'fail', actual: 'https://stranger.test' })]);
    expect(res.body.hint).toMatch(/Trusted IdPs panel/);
    expect(session.idJagPlayground).toBeUndefined();
  });

  it('rejects something that is not a JWT', async () => {
    expect((await send(appWith(byoSession()), 'post', '/pg/byo/inspect', { idJag: 'hello' })).status).toBe(400);
  });

  it('inspects against the IdP entry and never echoes the raw token; redeem is not_configured without the resource AS secret', async () => {
    seed(ENTRY);
    const session = byoSession();
    const app = appWith(session);
    const idJag = theirIdJag();
    const res = await send(app, 'post', '/pg/byo/inspect', { idJag, target: 'resource-as' });
    expect(res.body.trusted).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(idJag);
    const byId = Object.fromEntries(res.body.checks.map((c) => [c.id, c]));
    expect(byId.iss.status).toBe('pass');
    expect(byId.aud).toEqual(expect.objectContaining({ status: 'pass', expected: AS }));
    expect(byId.client_id).toEqual(expect.objectContaining({ status: 'pass', expected: 'partner-knows-us-as' }));
    expect(byId.signature.status).toBe('fail');
    expect(fetchMock.mock.calls[0][0]).toBe(`${OUT}/jwks`);
    expect(session.idJagPlayground.byo).toEqual({ target: 'resource-as', idpId: 'partner' });

    fetchMock.mockClear();
    const red = await send(app, 'post', '/pg/redeem', {});
    expect(red.status).toBe(409);
    expect(red.body).toEqual(expect.objectContaining({ error: 'not_configured', missing: ['RESOURCE_AS_CLIENT_SECRET'] }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redeems at the resource AS as entry.clientId once configured', async () => {
    vi.stubEnv('RESOURCE_AS_CLIENT_SECRET', 'redeem-secret');
    seed(ENTRY);
    const session = byoSession();
    const app = appWith(session);
    const idJag = theirIdJag();
    await send(app, 'post', '/pg/byo/inspect', { idJag });
    fetchMock.mockResolvedValue(reply(200, { access_token: accessToken, token_type: 'Bearer' }));
    fetchMock.mockClear();
    const red = await send(app, 'post', '/pg/redeem', {});
    expect(red.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`${AS}/token`);
    expect(sentForm(0).get('client_id')).toBe('id-jag-playground');
    expect(sentForm(0).get('assertion')).toBe(idJag);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('id-jag-playground:redeem-secret').toString('base64')}`);
    expect(JSON.stringify(red.body)).not.toContain(accessToken);
    expect(session.idJagPlayground.accessToken).toBe(accessToken);
  });

  it('never sends our resource AS secret for a client id an entry names', async () => {
    vi.stubEnv('RESOURCE_AS_CLIENT_SECRET', 'redeem-secret');
    seed({ ...ENTRY, clientId: 'their-client' });
    const app = appWith(byoSession());
    await send(app, 'post', '/pg/byo/inspect', { idJag: theirIdJag() });
    fetchMock.mockResolvedValue(reply(400, { error: 'invalid_client' }));
    fetchMock.mockClear();
    await send(app, 'post', '/pg/redeem', {});
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('redeems at PingFederate as entry.pfClientId with the redeemer secret', async () => {
    vi.stubEnv('PF_REDEEMER_CLIENT_SECRET', 'redeemer-secret');
    seed({ ...ENTRY, pfClientId: 'partner-redeemer' });
    const app = appWith(byoSession());
    await send(app, 'post', '/pg/byo/inspect', { idJag: theirIdJag({ aud: PF }), target: 'pingfederate' });
    fetchMock.mockResolvedValue(reply(200, { access_token: accessToken }));
    fetchMock.mockClear();
    expect((await send(app, 'post', '/pg/redeem', {})).status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`${PF}/as/token.oauth2`);
    expect(sentForm(0).get('client_id')).toBe('partner-redeemer');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('partner-redeemer:redeemer-secret').toString('base64')}`);
  });

  it('an IdP not enabled for the chosen target is refused at inspect', async () => {
    seed({ ...ENTRY, targets: ['resource-as'] });
    const res = await send(appWith(byoSession()), 'post', '/pg/byo/inspect', { idJag: theirIdJag(), target: 'pingfederate' });
    expect(res.body.trusted).toBe(false);
    expect(res.body.hint).toMatch(/not for pingfederate/);
  });

  it('negative tests reuse the pasted ID-JAG and skip replay', async () => {
    vi.stubEnv('RESOURCE_AS_CLIENT_SECRET', 'redeem-secret');
    seed(ENTRY);
    const app = appWith(byoSession());
    const idJag = theirIdJag();
    await send(app, 'post', '/pg/byo/inspect', { idJag });
    fetchMock.mockClear();
    expect((await send(app, 'post', '/pg/negative/replay', {})).body).toEqual(expect.objectContaining({ skipped: true, pass: null }));
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(reply(400, { error: 'invalid_scope' }));
    expect((await send(app, 'post', '/pg/negative/scope-not-granted', {})).body.pass).toBe(true);
    expect(sentForm(0).get('assertion')).toBe(idJag);
  });

  it('issue is not available in byo mode', async () => {
    expect((await send(appWith(byoSession()), 'post', '/pg/issue', {})).status).toBe(409);
  });
});
