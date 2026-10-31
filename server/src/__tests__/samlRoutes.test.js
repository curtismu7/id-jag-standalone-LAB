import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import router, { _clearProbeCache } from '../idJagPlayground.js';
import { signerCertPem } from '../saml.js';

const ORIGIN = 'https://app.test';
const PF = 'https://pf.test';
const AS = 'https://mcp-as.test';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const SAML2 = 'urn:ietf:params:oauth:token-type:saml2';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (header, claims) => `${b64(header)}.${b64(claims)}.c2lnbmF0dXJl`;
const now = () => Math.floor(Date.now() / 1000);
const goodIdJag = () => jwt({ alg: 'RS256', typ: 'oauth-id-jag+jwt' }, {
  iss: PF, sub: 'a@pingidentity.com', aud: AS, client_id: 'id-jag-playground', jti: 'j1', iat: now(), exp: now() + 300,
  resource: `${AS}/mcp`, scope: 'mcp:invoke',
});
const accessToken = jwt({ alg: 'RS256' }, { iss: AS, sub: 'a@pingidentity.com', aud: 'mcp', scope: 'mcp:invoke' });

const reply = (status, data) => ({ status, json: async () => data });
let fetchMock;
let keyFile;
let certFile;

function appWith(session) {
  const app = express();
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/pg', router);
  return app;
}
const post = (app, p, body) => request(app).post(p).set('Origin', ORIGIN).send(body || {});
const sentForm = (i) => new URLSearchParams(fetchMock.mock.calls[i][1].body);
const setEnv = (o) => Object.entries(o).forEach(([k, v]) => vi.stubEnv(k, v));
const user = (email = 'a@pingidentity.com') => ({ sub: 'sub1', email, name: 'A', isAdmin: false });
const samlSession = (over = {}) => ({ idJagPlaygroundMode: 'pf-as', user: user(), ...over });

// pf-as configured WITHOUT PF_EXCHANGE_CLIENT_SECRET: the SAML path never uses it.
const ENV = {
  APP_ORIGIN: ORIGIN, PF_URL: PF, PF_EXCHANGE_CLIENT_ID: 'id-jag-kit', RESOURCE_AS_ISSUER: AS, RESOURCE_AS_CLIENT_SECRET: 'redeem-secret',
  ID_JAG_RESOURCE: `${AS}/mcp`, ID_JAG_SCOPE: 'mcp:invoke',
};

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-saml-routes-'));
  keyFile = path.join(dir, 'signer.key.pem');
  certFile = path.join(dir, 'signer.cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=test-saml-idp',
    '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
});

beforeEach(() => {
  setEnv({ ...ENV, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-')), SAML_SIGNING_KEY_FILE: keyFile, SAML_SIGNING_CERT_FILE: certFile,
    PF_SAML_CLIENT_SECRET: 'saml-client-secret' });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  _clearProbeCache();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const decodeSubjectToken = (i = 0) => Buffer.from(sentForm(i).get('subject_token'), 'base64url').toString('utf8');
const verifies = (xml) => {
  const sig = new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(DS, 'Signature')[0];
  const v = new SignedXml({ publicCert: signerCertPem() });
  v.loadSignature(sig);
  try { return v.checkSignature(xml); } catch { return false; }
};

describe('POST /issue {protocol:"saml"}', () => {
  it.each(['byo', 'pf-pf'])('is refused in %s mode: 409 saml_unsupported_mode', async (mode) => {
    const res = await post(appWith(samlSession({ idJagPlaygroundMode: mode })), '/pg/issue', { protocol: 'saml' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('saml_unsupported_mode');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a session with no mode set (byo) is refused too', async () => {
    const res = await post(appWith({ user: user() }), '/pg/issue', { protocol: 'saml' });
    expect(res.body.error).toBe('saml_unsupported_mode');
  });

  it.each([['SAML_SIGNING_KEY_FILE', ''], ['SAML_SIGNING_CERT_FILE', '/nonexistent.pem'], ['PF_SAML_CLIENT_SECRET', '']])(
    'answers 409 saml_not_configured naming %s when it is %j', async (name, value) => {
      vi.stubEnv(name, value);
      const res = await post(appWith(samlSession()), '/pg/issue', { protocol: 'saml' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('saml_not_configured');
      expect(res.body.message).toContain(name);
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it('answers 409 not_configured when the pf-as settings are missing', async () => {
    vi.stubEnv('RESOURCE_AS_ISSUER', '');
    const res = await post(appWith(samlSession()), '/pg/issue', { protocol: 'saml' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ error: 'not_configured', missing: expect.arrayContaining(['RESOURCE_AS_ISSUER']) }));
    expect(res.body.missing).not.toContain('PF_EXCHANGE_CLIENT_SECRET');
  });

  it.each([[{}], [{ user: {} }], [{ user: { sub: 's' } }]])('needs an app sign-in with an email: 401 sign_in_required (%j)', async (extra) => {
    const res = await post(appWith({ idJagPlaygroundMode: 'pf-as', ...extra }), '/pg/issue', { protocol: 'saml' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('sign_in_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([['a+tag@pingidentity.com', 'plus'], ['a@evil.test', 'domain'], ['not-an-email', 'format']])(
    'applies the kit email rules: %s is 403', async (email) => {
      const res = await post(appWith(samlSession({ user: user(email) })), '/pg/issue', { protocol: 'saml' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('email_not_allowed');
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it('sends one exchange: Basic client auth, base64url signed assertion, the OIDC path\'s audience, resource and scope', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag(), issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag' }));
    const res = await post(appWith(samlSession()), '/pg/issue', { protocol: 'saml' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${PF}/as/token.oauth2`);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('id-jag-kit-saml:saml-client-secret').toString('base64')}`);
    expect(Object.fromEntries(sentForm(0))).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
      subject_token: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      subject_token_type: SAML2,
      audience: AS, resource: `${AS}/mcp`, scope: 'mcp:invoke',
    });
    const xml = decodeSubjectToken();
    expect(xml).toMatch(/^<saml:Assertion /);
    expect(verifies(xml)).toBe(true);
    expect(xml).toContain('>a@pingidentity.com</saml:NameID>');
    expect(xml).toContain('<saml:Audience>idJagKitSamlAud</saml:Audience>');
    expect(xml).toContain('<saml:Issuer>https://app.test/saml</saml:Issuer>');
  });

  it('honours SAML_AUDIENCE, SAML_ISSUER and PF_SAML_CLIENT_ID, and ignores a scope in the body (the SAML client is not scope-restricted)', async () => {
    setEnv({ SAML_AUDIENCE: 'custom-aud', SAML_ISSUER: 'https://idp.test/s', PF_SAML_CLIENT_ID: 'my-saml-client' });
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() }));
    const res = await post(appWith(samlSession()), '/pg/issue', { protocol: 'saml', scope: 'mcp:read' });
    expect(res.status).toBe(200);
    expect(sentForm(0).get('scope')).toBe('mcp:invoke');
    expect(res.body.request.body.scope).toBe('mcp:invoke');
    expect(decodeSubjectToken()).toContain('<saml:Audience>custom-aud</saml:Audience>');
    expect(decodeSubjectToken()).toContain('<saml:Issuer>https://idp.test/s</saml:Issuer>');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('my-saml-client:saml-client-secret').toString('base64')}`);
    expect(res.body.request.body.client_id).toBe('my-saml-client');
  });

  it('the subject is always the session user: nothing in the request body can choose it', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() }));
    await post(appWith(samlSession()), '/pg/issue', {
      protocol: 'saml', subject: 'evil@pingidentity.com', email: 'evil@pingidentity.com', nameId: 'evil@pingidentity.com',
      user: { email: 'evil@pingidentity.com' }, audience: 'evil-aud', subject_token: 'x',
    });
    const xml = decodeSubjectToken();
    expect(xml).toContain('>a@pingidentity.com</saml:NameID>');
    expect(xml).not.toContain('evil');
    expect(sentForm(0).get('audience')).toBe(AS);
  });

  it('returns the described assertion, the shown request and a redacted response; no raw assertion, ID-JAG or secret', async () => {
    const idJag = goodIdJag();
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: idJag, issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag', refresh_token: 'should-not-leak' }));
    const session = samlSession();
    const res = await post(appWith(session), '/pg/issue', { protocol: 'saml' });
    expect(res.status).toBe(200);
    expect(res.body.assertion).toEqual(expect.objectContaining({
      issuer: 'https://app.test/saml', nameId: 'a@pingidentity.com', audience: 'idJagKitSamlAud', xml: expect.stringContaining('<ds:SignatureValue>[…]</ds:SignatureValue>'),
    }));
    expect(res.body.request).toEqual({
      endpoint: `POST ${PF}/as/token.oauth2`,
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
        subject_token: '[the signed SAML assertion, base64url, kept server-side]',
        subject_token_type: SAML2,
        audience: AS, resource: `${AS}/mcp`, scope: 'mcp:invoke', client_id: 'id-jag-kit-saml',
      },
    });
    expect(res.body.response).toEqual({ issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag', token_type: 'N_A', access_token: '[the ID-JAG, kept server-side]' });
    expect(res.body.token.claims.client_id).toBe('id-jag-playground');
    const wire = JSON.stringify(res.body);
    const sent = sentForm(0).get('subject_token');
    for (const secretText of [idJag, sent, 'saml-client-secret', 'should-not-leak', '<ds:SignatureValue>Y', 'PRIVATE KEY']) expect(wire).not.toContain(secretText);
    expect(session.idJagPlayground).toEqual(expect.objectContaining({ idJag, redeemed: false, saml: true }));
  });

  it('maps a PingFederate refusal like the OIDC path: 502 id_jag_issue_failed with the PF error, nothing stored', async () => {
    fetchMock.mockResolvedValueOnce(reply(400, { error: 'invalid_request', error_description: 'Certificate path validation failed' }));
    const session = samlSession();
    const res = await post(appWith(session), '/pg/issue', { protocol: 'saml' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual(expect.objectContaining({ error: 'id_jag_issue_failed', pfError: 'invalid_request', pfErrorDescription: 'Certificate path validation failed' }));
    expect(res.body.message).toContain('HTTP 400');
    expect(JSON.stringify(res.body)).not.toContain('saml-client-secret');
    expect(session.idJagPlayground).toBeUndefined();
  });

  it('the OIDC path still needs PF_EXCHANGE_CLIENT_SECRET, which the SAML path never uses', async () => {
    const res = await post(appWith(samlSession()), '/pg/issue', {});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_configured');
  });

  it('an OIDC issue after a SAML one still needs the issuer sign-in and secret (the SAML session does not stand in)', async () => {
    const session = samlSession({ idJagPlayground: { idJag: goodIdJag(), saml: true } });
    const res = await post(appWith(session), '/pg/issue', {});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_configured');
    expect(res.body.missing).toContain('PF_EXCHANGE_CLIENT_SECRET');
    setEnv({ PF_EXCHANGE_CLIENT_SECRET: 'exchange-secret' });
    const res2 = await post(appWith(session), '/pg/issue', {});
    expect(res2.body.error).toBe('sign_in_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the stored ID-JAG works with inspect, redeem and the negative tests, with no issuer sign-in', async () => {
    const session = samlSession();
    const app = appWith(session);
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() }));
    expect((await post(app, '/pg/issue', { protocol: 'saml' })).status).toBe(200);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply(200, { keys: [] }));
    const inspected = await post(app, '/pg/inspect');
    expect(inspected.status).toBe(200);
    expect(inspected.body.claims.sub).toBe('a@pingidentity.com');

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: accessToken, token_type: 'Bearer' }));
    const redeemed = await post(app, '/pg/redeem');
    expect(redeemed.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`${AS}/token`);
    expect(session.idJagPlayground.accessToken).toBe(accessToken);
    expect(session.idJagPlayground.saml).toBe(true);

    // A negative test mints a fresh ID-JAG: through the SAML exchange, since there is no refresh token.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: goodIdJag() })).mockResolvedValueOnce(reply(400, { error: 'invalid_grant' }));
    const neg = await post(app, '/pg/negative/bad-signature');
    expect(neg.body.pass).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`${PF}/as/token.oauth2`);
    expect(sentForm(0).get('subject_token_type')).toBe(SAML2);
  });
});

describe('POST /revoke in a SAML session', () => {
  it('is 409 no_refresh_token', async () => {
    const res = await post(appWith(samlSession({ idJagPlayground: { idJag: goodIdJag(), saml: true } })), '/pg/revoke');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'no_refresh_token', message: 'A SAML sign-in has no refresh token to revoke.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still works for an OIDC session', async () => {
    setEnv({ PF_EXCHANGE_CLIENT_SECRET: 'exchange-secret' });
    fetchMock.mockResolvedValueOnce(reply(400, { error: 'invalid_grant' }));
    const res = await post(appWith({ idJagPlaygroundMode: 'pf-as', idJagIssuer: { mode: 'pf-as', refreshToken: 'rt' } }), '/pg/revoke');
    expect(res.status).toBe(200);
    expect(res.body.proved).toBe(false);
  });
});

describe('GET /config', () => {
  it('carries saml: available, audience, issuer and the supported modes, and no secret', async () => {
    const res = await request(appWith(samlSession())).get('/pg/config');
    expect(res.body.saml).toEqual({ available: true, reason: null, audience: 'idJagKitSamlAud', issuer: 'https://app.test/saml', supportedModes: ['pf-as'], appSignedIn: true });
    expect(JSON.stringify(res.body)).not.toContain('saml-client-secret');
  });

  it('appSignedIn follows the app sign-in, not the issuer refresh-token session', async () => {
    const signedOut = await request(appWith({ idJagPlaygroundMode: 'pf-as', idJagIssuer: { mode: 'pf-as', refreshToken: 'r' } })).get('/pg/config');
    expect(signedOut.body.signedIn).toBe(true);
    expect(signedOut.body.saml.appSignedIn).toBe(false);
    const signedIn = await request(appWith(samlSession())).get('/pg/config');
    expect(signedIn.body.signedIn).toBe(false);
    expect(signedIn.body.saml.appSignedIn).toBe(true);
  });

  it('says why SAML is unavailable', async () => {
    vi.stubEnv('PF_SAML_CLIENT_SECRET', '');
    const res = await request(appWith(samlSession())).get('/pg/config');
    expect(res.body.saml).toEqual(expect.objectContaining({ available: false, reason: expect.stringContaining('PF_SAML_CLIENT_SECRET') }));
  });
});

describe('GET /saml/cert', () => {
  it('serves the signer certificate as PEM, no session needed', async () => {
    const res = await request(appWith({})).get('/pg/saml/cert');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/x-pem-file/);
    expect(res.text).toBe(signerCertPem());
    expect(res.text).not.toContain('PRIVATE KEY');
  });

  it('is 404 saml_not_configured when SAML is unavailable', async () => {
    vi.stubEnv('SAML_SIGNING_CERT_FILE', '');
    const res = await request(appWith({})).get('/pg/saml/cert');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('saml_not_configured');
  });
});

describe('GET /preflight', () => {
  const run = async (query, session = samlSession()) => (await request(appWith(session)).get(`/pg/preflight?${query}`)).body;
  const ids = (body) => body.checks.map((c) => c.id);
  const byId = (body, id) => body.checks.find((c) => c.id === id);
  beforeEach(() => {
    fetchMock.mockImplementation(async (url) => reply(200, String(url).endsWith('/pf/JWKS') ? { keys: [{ kty: 'RSA', n: 'n', e: 'AQAB', x5t: 't' }] } : { issuer: PF }));
  });

  it('protocol=saml adds saml-configured and saml-client (passing), and the existing checks still run', async () => {
    const body = await run('step=issue&protocol=saml');
    expect(byId(body, 'saml-configured').status).toBe('pass');
    expect(byId(body, 'saml-client').status).toBe('pass');
    expect(ids(body)).toEqual(expect.arrayContaining(['origin', 'config', 'signed-in', 'issuer', 'jwks']));
    expect(body.ok).toBe(true);
  });

  it('the signed-in check follows the app sign-in for SAML, not an issuer refresh token', async () => {
    const body = await run('step=issue&protocol=saml', { idJagPlaygroundMode: 'pf-as' });
    expect(byId(body, 'signed-in').status).toBe('fail');
    expect(byId(body, 'signed-in').detail).toMatch(/app/i);
    expect(body.ok).toBe(false);
  });

  it('fails saml-configured with the reason, and saml-client without the secret', async () => {
    vi.stubEnv('SAML_SIGNING_KEY_FILE', '');
    vi.stubEnv('PF_SAML_CLIENT_SECRET', '');
    const body = await run('step=issue&protocol=saml');
    expect(byId(body, 'saml-configured')).toEqual(expect.objectContaining({ status: 'fail', detail: expect.stringContaining('SAML_SIGNING_KEY_FILE') }));
    expect(byId(body, 'saml-client')).toEqual(expect.objectContaining({ status: 'fail', detail: expect.stringContaining('PF_SAML_CLIENT_SECRET') }));
  });

  it('behaves as today without protocol, with an unknown protocol, and on other steps', async () => {
    for (const q of ['step=issue', 'step=issue&protocol=other', 'step=redeem&protocol=saml']) {
      const body = await run(q, samlSession({ idJagIssuer: { mode: 'pf-as', refreshToken: 'rt' } }));
      expect(ids(body), q).not.toContain('saml-configured');
      expect(ids(body), q).not.toContain('saml-client');
    }
  });

  it('the issue step without protocol=saml does not count a SAML session as signed in', async () => {
    const body = await run('step=issue', { idJagPlaygroundMode: 'pf-as', idJagPlayground: { idJag: goodIdJag(), saml: true } });
    expect(byId(body, 'signed-in').status).toBe('fail');
    expect(byId(body, 'config').status).toBe('fail');
  });

  it('later steps of a SAML session count as signed in', async () => {
    const session = { idJagPlaygroundMode: 'pf-as', idJagPlayground: { idJag: goodIdJag(), saml: true } };
    const body = await run('step=redeem', session);
    expect(byId(body, 'signed-in').status).toBe('pass');
    expect(byId(body, 'config').status).toBe('pass');
  });
});
