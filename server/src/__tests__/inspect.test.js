import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import router, { checkToken, classify } from '../inspectApi.js';

const PF = 'https://pf.test';
const AS = 'https://mcp-as.test';
const MCP = 'https://mcp.test/mcp';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (header, claims) => `${b64(header)}.${b64(claims)}.c2ln`;
const now = () => Math.floor(Date.now() / 1000);
const idJag = (over = {}, hdr = {}) => jwt({ alg: 'RS256', typ: 'oauth-id-jag+jwt', ...hdr }, {
  iss: PF, sub: 'u1', aud: AS, client_id: 'agent-1', jti: 'jti-12345678', iat: now(), exp: now() + 300, scope: 'read', ...over });
const idToken = (over = {}) => jwt({ alg: 'RS256' }, { iss: PF, sub: 'u1', aud: 'app', nonce: 'n', iat: now(), exp: now() + 300, ...over });
const accessToken = (over = {}) => jwt({ alg: 'RS256', typ: 'at+jwt' }, { iss: AS, sub: 'u1', aud: MCP, scope: 'read', iat: now(), exp: now() + 300, ...over });
const SAML = '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" IssueInstant="2026-01-01T00:00:00Z"><saml:Issuer>https://idp.test</saml:Issuer>'
  + '<saml:Subject><saml:NameID>u1</saml:NameID></saml:Subject><saml:Conditions NotBefore="2026-01-01T00:00:00Z" NotOnOrAfter="2026-01-01T00:05:00Z"><saml:AudienceRestriction><saml:Audience>https://aud.test</saml:Audience></saml:AudienceRestriction></saml:Conditions></saml:Assertion>';
const ok = { ok: true, note: 'valid' };
const byId = (r, id) => r.checks.find((c) => c.id === id);

let fetchMock;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-'));
  vi.stubEnv('DATA_DIR', dir);
  vi.stubEnv('PF_URL', PF);
  vi.stubEnv('RESOURCE_AS_ISSUER', AS);
  vi.stubEnv('MCP_URL', MCP);
  vi.stubEnv('RESOURCE_AS_CLIENT_ID', 'agent-1');
  fs.writeFileSync(path.join(dir, 'trusted-idps.json'), JSON.stringify([{
    id: 'pf', name: 'SE PingFederate', product: 'pingfederate', issuer: PF, jwksUrl: `${PF}/pf/JWKS`, idJagClientId: 'agent-1',
    clientId: 'idp-pf', pfClientId: 'x', scopes: 'read', targets: ['resource-as'], status: 'approved' }]));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('classify', () => {
  it('tells the token kinds apart', () => {
    expect(classify(idJag())).toBe('id-jag');
    expect(classify(idToken())).toBe('id-token');
    expect(classify(accessToken())).toBe('access-token');
    expect(classify(SAML)).toBe('saml');
    expect(classify(Buffer.from(SAML).toString('base64'))).toBe('saml');
    expect(classify('hello')).toBe('unknown');
  });
});

describe('checkToken', () => {
  it('checks a trusted-IdP ID-JAG against draft-04 and the registry', async () => {
    const r = await checkToken(idJag(), { verify: async () => ok, redeemed: async () => false });
    expect(r.type).toBe('id-jag');
    expect(r.checks.every((c) => c.status !== 'fail')).toBe(true);
    expect(byId(r, 'trusted-idp').status).toBe('pass');
    expect(byId(r, 'client_id').status).toBe('pass');
    expect(byId(r, 'replay').status).toBe('pass');
    expect(r.claims.jti).toBe('jti-12345678');
  });

  it('fails an untrusted issuer, a wrong client_id and a replay', async () => {
    const bad = await checkToken(idJag({ iss: 'https://other.test' }), { verify: async () => ok, redeemed: async () => false });
    expect(byId(bad, 'trusted-idp').status).toBe('fail');
    const wrong = await checkToken(idJag({ client_id: 'someone-else' }), { verify: async () => ok, redeemed: async () => true });
    expect(byId(wrong, 'client_id').status).toBe('fail');
    expect(byId(wrong, 'replay').status).toBe('fail');
  });

  it('checks an ID token without a signature check it cannot do', async () => {
    const r = await checkToken(idToken({ exp: now() - 10 }));
    expect(r.type).toBe('id-token');
    expect(byId(r, 'exp').status).toBe('fail');
    expect(byId(r, 'claim-sub').status).toBe('pass');
    expect(byId(r, 'signature').status).toBe('warn');
  });

  it('checks an access token', async () => {
    const r = await checkToken(accessToken({ aud: undefined }));
    expect(r.type).toBe('access-token');
    expect(byId(r, 'claim-aud').status).toBe('fail');
    expect(byId(r, 'claim-iss').status).toBe('pass');
  });

  it('decodes and checks a SAML assertion', async () => {
    const r = await checkToken(SAML);
    expect(r.type).toBe('saml');
    expect(r.assertion.issuer).toBe('https://idp.test');
    expect(byId(r, 'saml-expiry').status).toBe('fail');
    expect(byId(r, 'saml-signature').status).toBe('fail');
  });
});

describe('/api/inspect', () => {
  const app = () => { const a = express(); a.use('/api/inspect', router); return a; };

  it('decodes a pasted token and rejects an empty one', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ keys: [] }) });
    const good = await request(app()).post('/api/inspect/decode').send({ token: idToken() });
    expect(good.status).toBe(200);
    expect(good.body.type).toBe('id-token');
    expect((await request(app()).post('/api/inspect/decode').send({})).status).toBe(400);
  });

  describe('the session ID-JAG (fromSession)', () => {
    const ORIGIN = 'http://localhost:4720';
    const withSession = (idJagPlayground) => { const a = express(); a.use((r, _s, n) => { r.session = { idJagPlayground }; n(); }); a.use('/api/inspect', router); return a; };
    const post = (a, body, origin = ORIGIN) => { const r = request(a).post('/api/inspect/decode'); return (origin ? r.set('Origin', origin) : r).send(body); };
    beforeEach(() => { vi.stubEnv('APP_ORIGIN', ORIGIN); fetchMock.mockResolvedValue({ status: 200, json: async () => ({ keys: [] }) }); });

    it('checks the ID-JAG the playground issued into this session, without sending it back', async () => {
      const none = await post(withSession(undefined), { fromSession: true });
      expect(none.status).toBe(409);
      expect(none.body.error).toBe('no_session_id_jag');
      const res = await post(withSession({ idJag: idJag() }), { fromSession: true });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('id-jag');
      expect(res.body.token).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(idJag());
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('reveals the raw token only on request, only the caller\'s own, never one from the request, no-store', async () => {
      const mine = idJag({ jti: 'mine-1234567' });
      const res = await post(withSession({ idJag: mine }), { fromSession: true, reveal: true, token: idJag({ jti: 'attacker' }) });
      expect(res.status).toBe(200);
      expect(res.body.token).toBe(mine);
      expect(res.headers['cache-control']).toBe('no-store');
      const none = await post(withSession(undefined), { fromSession: true, reveal: true });
      expect(none.status).toBe(409);
      expect(none.body.token).toBeUndefined();
      expect(none.headers['cache-control']).toBe('no-store');
    });

    it('refuses a cross-site request, or one with no Origin', async () => {
      const a = withSession({ idJag: idJag() });
      for (const o of ['https://evil.test', null]) {
        const res = await post(a, { fromSession: true, reveal: true }, o);
        expect(res.status).toBe(403);
        expect(res.body.token).toBeUndefined();
      }
    });

    it('does not log the token', async () => {
      const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
      const t = idJag();
      await post(withSession({ idJag: t }), { fromSession: true, reveal: true });
      for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(t.split('.')[1]);
      spies.forEach((s) => s.mockRestore());
    });
  });

  it('fetches each backend\'s metadata and reports the MCP profile fields', async () => {
    fetchMock.mockImplementation(async (url) => ({ status: 200, json: async () => (String(url).includes('mcp.test')
      ? { resource: MCP, scopes_supported: ['read'] } : { issuer: 'x', authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'] }) }));
    const r = await request(app()).get('/api/inspect/discovery');
    expect(r.status).toBe(200);
    expect(r.body.backends.map((b) => b.id)).toEqual(['resource-as', 'pingfederate', 'mcp']);
    expect(r.body.backends[0].profileFields).toEqual({ authorization_grant_profiles_supported: true, scopes_supported: false });
    expect(r.body.backends[2].profileFields.scopes_supported).toBe(true);
    expect(fetchMock.mock.calls.every(([u]) => String(u).includes('.well-known'))).toBe(true);
  });

  it('shows a backend that is down as an error, not a crash', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const r = await request(app()).get('/api/inspect/discovery');
    expect(r.body.backends[0].error).toBeTruthy();
  });

  it('relays the resource AS decision record', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ issuer: AS, events: [{ decision: 'accepted', jti: 'abc…' }] }) });
    const r = await request(app()).get('/api/inspect/events');
    expect(r.body).toEqual({ available: true, events: [{ decision: 'accepted', jti: 'abc…' }] });
    fetchMock.mockRejectedValue(new Error('down'));
    expect((await request(app()).get('/api/inspect/events')).body.available).toBe(false);
  });
});
