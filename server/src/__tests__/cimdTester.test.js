// CIMD document rules (after client.dev) and the CIMD tester routes over HTTP, through the real app.
// Mock mode: the probe asks the in-process mock PingFederate, which fetches this app's documents
// through the CIMD policy wired in demo/index.js. The real fetch is a spy that fails the test.
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { CIMD_METADATA_PATH, NEGATIVE_DOCUMENTS, enableMockCimd, validateCimdDocument, documentUrl, metadataDocument } from '../cimdTester.js';
import { ORIGIN, expectNoRealCalls, post, useMockMode } from './mockHelpers.js';

const state = useMockMode();
const API = '/api/cimd/tester';

const good = () => ({ ...metadataDocument(), redirect_uris: [`${metadataDocument().redirect_uris[0]}`] });

// demo/index.js skips enableMockCimd() under NODE_ENV=test, and _dropMockWorld() in useMockMode()
// rebuilds the mock world before each test, so the CIMD policy is wired fresh each time too.
beforeEach(() => enableMockCimd());

describe('CIMD document rules (after client.dev)', () => {
  it('a good document passes with only the plain-HTTP warnings of a test origin', () => {
    const result = validateCimdDocument(good(), documentUrl());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.every((w) => w.message.includes('HTTPS'))).toBe(true);
  });

  it.each([
    ['client_id must match the URL', { client_id: 'https://other.example.invalid/client' }, 'client_id', 'client_id must match the URL the document was fetched from'],
    ['client_id must be a URL at all', { client_id: 'not a url' }, 'client_id', 'client_id must be an HTTPS URL'],
    ['redirect_uris required', { redirect_uris: undefined }, 'redirect_uris', 'Missing required field: redirect_uris (must be an array)'],
    ['redirect_uris unique', { redirect_uris: [`${ORIGIN}/auth/callback`, `${ORIGIN}/auth/callback`] }, 'redirect_uris', 'Redirect URIs must be unique'],
    ['no shared-secret method', { token_endpoint_auth_method: 'client_secret_basic' }, 'token_endpoint_auth_method', 'needs a shared secret'],
    ['no client secret', { client_secret: 'hunter2' }, 'client_secret', 'A metadata document must not contain a client secret'],
  ])('%s', (_name, patch, path, message) => {
    const result = validateCimdDocument({ ...good(), ...patch }, documentUrl());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === path && e.message.includes(message.split(' ').slice(0, 3).join(' ')))).toBe(true);
  });

  it('warns when client_uri is on another host (the client.dev bug, fixed)', () => {
    const result = validateCimdDocument({ ...good(), client_uri: 'https://elsewhere.example.invalid/' }, documentUrl());
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.path === 'client_uri')).toBe(true);
  });

  it('a non-object is refused, not thrown on', () => {
    for (const bad of [null, [], 'x']) {
      const result = validateCimdDocument(bad, null);
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('document');
    }
  });
});

describe('the app\'s documents', () => {
  it('serves its own document and the negative documents publicly', async () => {
    const agent = request.agent(createApp());
    const own = (await agent.get(CIMD_METADATA_PATH).expect(200)).body;
    expect(own.client_id).toBe(documentUrl());
    expect(own.token_endpoint_auth_method).toBe('none');
    for (const name of Object.keys(NEGATIVE_DOCUMENTS)) {
      const doc = (await agent.get(`/api/cimd/negative/${name}.json`).expect(200)).body;
      expect(typeof doc.client_id).toBe('string');
    }
    await agent.get('/api/cimd/negative/unknown.json').expect(404);
  });
});

describe('tester routes', () => {
  it('checks the pasted document without any outbound call', async () => {
    const agent = request.agent(createApp());
    const r = await post(agent, `${API}/client`, { document: JSON.stringify(good()) }).expect(200);
    expect(r.body).toMatchObject({ source: 'pasted', valid: true });
    expect(r.body.errors).toEqual([]);
    expect(state.realFetch).not.toHaveBeenCalled();
  });

  it('an invalid method still gets the rules run on it (pasted)', async () => {
    const agent = request.agent(createApp());
    const doc = good();
    doc.token_endpoint_auth_method = 'client_secret_jwt';
    const r = await post(agent, `${API}/client`, { document: JSON.stringify(doc) }).expect(200);
    expect(r.body.valid).toBe(false);
  });

  it('a non-JSON paste answers 400 cimd_document_invalid', async () => {
    const agent = request.agent(createApp());
    const r = await post(agent, `${API}/client`, { document: 'not json' }).expect(400);
    expect(r.body.error).toBe('cimd_document_invalid');
  });

  it('a paste over the size cap answers 413', async () => {
    const agent = request.agent(createApp());
    const r = await post(agent, `${API}/client`, { document: `{"x":"${'a'.repeat(17 * 1024)}"}` }).expect(413);
    expect(r.body.error).toBe('cimd_document_too_large');
  });

  it('checks this app\'s own document against its URL', async () => {
    const agent = request.agent(createApp());
    const r = await post(agent, `${API}/client`, {}).expect(200);
    expect(r.body.valid).toBe(true);
    expect(r.body.source).toBe(documentUrl());
  });

  it('the discovery check reads the mock PingFederate and reports CIMD support', async () => {
    const agent = request.agent(createApp());
    const r = await post(agent, `${API}/server`, {}).expect(200);
    expect(r.body.issuer).toBe('https://pf.mock.invalid');
    for (const c of r.body.checks) expect(c.ok, c.name).toBe(true);
    expectNoRealCalls(state);
  });

  it('the probe asks the mock PingFederate about good and bad documents, and it answers as expected', async () => {
    const agent = request.agent(createApp());
    const r = await post(agent, `${API}/probe`, {}).expect(200);
    const byId = new Map(r.body.results.map((x) => [x.id, x]));
    expect(byId.get('valid')).toMatchObject({ asExpected: true, accepted: true });
    for (const id of ['redirect-not-listed', 'not-in-policy', ...Object.keys(NEGATIVE_DOCUMENTS)]) {
      expect(byId.get(id), id).toMatchObject({ asExpected: true, accepted: false });
      expect(byId.get(id).pfSays).toMatch(/Invalid/i);
    }
    // The impersonating document names its own URL as the client_id (the mismatch case).
    expect(byId.get('client-id-mismatch').clientId).toContain('/api/cimd/negative/client-id-mismatch.json');
    expectNoRealCalls(state);
  });

  it('every probe request went to the mock authorization endpoint with PKCE', async () => {
    const agent = request.agent(createApp());
    const r = await post(agent, `${API}/probe`, {}).expect(200);
    for (const x of r.body.results) {
      expect(x.trace.request.url).toBe('https://pf.mock.invalid/as/authorization.oauth2');
      expect(x.trace.request.params.code_challenge_method).toBe('S256');
    }
  });
});
