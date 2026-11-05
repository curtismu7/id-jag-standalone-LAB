// CIMD tester, after client.dev (stytchauth/client.dev, MIT licence, Copyright (c) Stytch): the same
// two sides, run against this kit's PingFederate. The validation rules are ported from client.dev's
// app/clients/utils.ts, plus the rules client.dev leaves out (shared secrets, PingFederate's size limit)
// and its client_uri host check fixed (client.dev compared .hostname on strings, so it never fired).
//   Client side: check a client ID metadata document against the draft's rules (validateCimdDocument),
//   then ask PingFederate itself what it makes of good and bad documents (probe).
//   Server side: read PingFederate's discovery document for CIMD support (checkServer).
// Nothing here fetches a URL the user typed: documents are pasted, or are this app's own.
// Every outbound call goes through outboundFetch (netguard). Probe is mock only: in live mode the
// kit's PingFederate has no CIMD policy pointing at this app's documents, so the honest answer is 409.

import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { isMock } from './mode.js';
import { outboundFetch } from './outbound.js';
import { ORIGINS } from './mock/env.js';
import { wireMockCimd } from './mock/cimdSource.js';
import { LIVE_UNAVAILABLE } from './gatewayRedeem.js';

const MAX_PASTED_BYTES = 16 * 1024;
// PingFederate's own cap on a fetched document (CIMD settings, maxFileSizeBytes, default 5120).
const PF_MAX_DOCUMENT_BYTES = 5120;
const SHARED_SECRET_METHODS = new Set(['client_secret_basic', 'client_secret_post', 'client_secret_jwt']);
const REQUEST_TIMEOUT_MS = 10_000;

// The app's CIMD document and the paths PingFederate's CIMD policy allows on this app's origin.
export const CIMD_METADATA_PATH = '/api/cimd/client-metadata.json';
export const CIMD_NEGATIVE_PATH = '/api/cimd/negative';

// Documents that break one rule each, served by this app at fixed paths the (mock) PingFederate's
// CIMD policy allows, so it fetches them and gives its verdict.
export const NEGATIVE_DOCUMENTS = {
  // Served at its own URL but claiming the app's real client_id: a document impersonating another client.
  'client-id-mismatch': {
    title: 'Document claims another client\'s client_id',
    build: (good) => ({ ...good }),
  },
  'shared-secret': {
    title: 'Document asks for a shared client secret',
    build: (good, url) => ({ ...good, client_id: url, token_endpoint_auth_method: 'client_secret_basic' }),
  },
};

export const documentUrl = () => `${config().appOrigin}${CIMD_METADATA_PATH}`;
export const negativeUrl = (name) => `${config().appOrigin}${CIMD_NEGATIVE_PATH}/${name}.json`;

/** This app's own client ID metadata document. */
export function metadataDocument() {
  return {
    client_id: documentUrl(),
    client_name: 'ID-JAG Kit',
    client_uri: config().appOrigin,
    redirect_uris: [`${config().appOrigin}/auth/callback`],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export function negativeDocument(name) {
  const spec = NEGATIVE_DOCUMENTS[name];
  if (!spec) return null;
  return spec.build(metadataDocument(), negativeUrl(name));
}

function hostnameOf(value) {
  try { return new URL(value).hostname; } catch { return null; }
}

// client.dev's rules, with its client_uri domain check fixed (it compared .hostname on strings, so it
// never fired), plus the draft's rules on secrets and PingFederate's size limit.
export function validateCimdDocument(metadata, sourceUrl) {
  const errors = [];
  const warnings = [];
  const error = (path, message) => errors.push({ path, message });
  const warning = (path, message) => warnings.push({ path, message });
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { valid: false, errors: [{ path: 'document', message: 'The document must be a JSON object' }], warnings };
  }

  if (!metadata.client_id) error('client_id', 'Missing required field: client_id');
  else if (typeof metadata.client_id !== 'string') error('client_id', 'client_id must be an HTTPS URL');
  else {
    let url;
    try { url = new URL(metadata.client_id); } catch { url = null; }
    if (!url || !['https:', 'http:'].includes(url.protocol)) error('client_id', 'client_id must be an HTTPS URL');
    else {
      if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        warning('client_id', 'client_id should use HTTPS');
      }
      if (sourceUrl && metadata.client_id !== sourceUrl) error('client_id', 'client_id must match the URL the document was fetched from');
      else if (url.hash || url.search) error('client_id', 'client_id must not carry a fragment or a query');
    }
  }

  if (!metadata.client_uri) warning('client_uri', 'Missing recommended field: client_uri');
  else if (hostnameOf(metadata.client_uri) !== hostnameOf(metadata.client_id)) warning('client_uri', 'client_uri should share the same host as client_id');

  if (!Array.isArray(metadata.redirect_uris)) error('redirect_uris', 'Missing required field: redirect_uris (must be an array)');
  else {
    if (metadata.redirect_uris.length === 0) error('redirect_uris', 'redirect_uris cannot be empty');
    metadata.redirect_uris.forEach((uri, index) => {
      if (typeof uri !== 'string') error(`redirect_uris[${index}]`, 'Redirect URI must be a string');
      else if (!uri.startsWith('https://') && !uri.startsWith('http://localhost') && !uri.startsWith('http://127.0.0.1')) {
        warning(`redirect_uris[${index}]`, 'Redirect URIs should use HTTPS (except localhost)');
      }
    });
    if (new Set(metadata.redirect_uris).size !== metadata.redirect_uris.length) error('redirect_uris', 'Redirect URIs must be unique');
  }

  for (const field of ['logo_uri', 'policy_uri', 'tos_uri', 'jwks_uri']) {
    if (metadata[field] === undefined) continue;
    if (typeof metadata[field] !== 'string') error(field, `${field} must be a string`);
    else if (!metadata[field].startsWith('https://')) warning(field, `${field} should use HTTPS`);
  }

  // The draft: a metadata document is public, so it cannot describe a shared secret.
  if (SHARED_SECRET_METHODS.has(metadata.token_endpoint_auth_method)) {
    error('token_endpoint_auth_method', `${metadata.token_endpoint_auth_method} needs a shared secret, which a public document cannot hold`);
  }
  if (metadata.client_secret !== undefined || metadata.client_secret_expires_at !== undefined) {
    error('client_secret', 'A metadata document must not contain a client secret');
  }

  const size = Buffer.byteLength(JSON.stringify(metadata));
  if (size > 65536) error('document', 'Document size exceeds 64KB');
  else if (size > PF_MAX_DOCUMENT_BYTES) warning('document', `Larger than PingFederate's default fetch limit (${PF_MAX_DOCUMENT_BYTES} bytes)`);
  if (typeof metadata.client_name === 'string' && metadata.client_name.length > 200) warning('client_name', 'Client name is very long (>200 characters)');

  return { valid: errors.length === 0, errors, warnings };}

/** Client side, part 1: this app's own document (or a pasted one), checked against the rules. */
export function checkClient(body = {}) {
  if (body.document !== undefined) {
    const text = typeof body.document === 'string' ? body.document : JSON.stringify(body.document);
    if (Buffer.byteLength(text) > MAX_PASTED_BYTES) {
      return { status: 413, error: 'cimd_document_too_large', message: `Paste at most ${MAX_PASTED_BYTES} bytes` };
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      return { status: 400, error: 'cimd_document_invalid', message: 'The pasted text is not JSON' };
    }
    return { source: 'pasted', document: parsed, ...validateCimdDocument(parsed, null) };
  }
  const own = metadataDocument();
  const url = documentUrl();
  return { source: url, document: own, ...validateCimdDocument(own, url) };
}

function pfEndpoints(c) {
  return {
    issuer: c.pfUrl,
    discoveryEndpoint: c.pfUrl ? `${c.pfUrl}/.well-known/openid-configuration` : '',
    authorizationEndpoint: c.pfUrl ? `${c.pfUrl}/as/authorization.oauth2` : '',
  };
}

// Server side: does PingFederate say it accepts CIMD clients, and with PKCE?
export async function checkServer() {
  const { issuer, discoveryEndpoint } = pfEndpoints(config());
  if (!issuer) return { status: 409, error: 'not_configured', message: 'Set PF_URL to run this check (live mode needs the kit\'s PingFederate settings).' };
  const response = await outboundFetch(discoveryEndpoint, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return { status: 502, error: 'discovery_failed', message: `PingFederate discovery answered HTTP ${response.status}` };
  const document = await response.json();
  const checks = [
    { name: 'client_id_metadata_document_supported', ok: document.client_id_metadata_document_supported === true, value: document.client_id_metadata_document_supported ?? null },
    { name: 'code_challenge_methods_supported includes S256', ok: (document.code_challenge_methods_supported || []).includes('S256'), value: document.code_challenge_methods_supported ?? null },
    { name: 'token_endpoint_auth_methods_supported includes none', ok: (document.token_endpoint_auth_methods_supported || []).includes('none'), value: document.token_endpoint_auth_methods_supported ?? null },
    { name: 'issuer matches the configured issuer', ok: document.issuer === issuer, value: document.issuer ?? null },
  ];
  return { issuer, checks };
}

// PingFederate answers an authorization request with its sign-in page when it accepts the client,
// or with an error page ("400 - Invalid client_id") when it does not. Read that answer back.
export function pfVerdict(status, body) {
  if (status === 200 || status === 302) return { accepted: true, pfSays: 'Sign-in flow started: client accepted' };
  const match = String(body).match(/\d{3}\s*-\s*Invalid[^<]{0,80}/i) || String(body).match(/Invalid[^<]{0,80}/i);
  return { accepted: false, pfSays: match ? match[0].trim() : `HTTP ${status}` };
}

// Client side, part 2: ask the mock PingFederate about documents and requests it should accept or refuse.
export async function probe() {
  if (!isMock()) {
    return { status: 409, error: 'live_unavailable', message: `${LIVE_UNAVAILABLE} (the kit's real PingFederate has no CIMD policy pointing at this app's documents; the probe runs in Mock mode only).` };
  }
  const otherRedirect = 'https://not-registered.example.test/callback';
  const cases = [
    { id: 'valid', title: 'This app\'s document, its own redirect URI', clientId: documentUrl(), redirectUri: metadataDocument().redirect_uris[0], expect: 'accept' },
    { id: 'redirect-not-listed', title: 'Valid document, a redirect URI it does not list', clientId: documentUrl(), redirectUri: otherRedirect, expect: 'refuse' },
    { id: 'not-in-policy', title: 'A document URL the CIMD policy does not allow', clientId: `${documentUrl()}?variant=unlisted`, redirectUri: metadataDocument().redirect_uris[0], expect: 'refuse' },
    ...Object.entries(NEGATIVE_DOCUMENTS).map(([name, spec]) => ({
      id: name, title: spec.title, clientId: negativeUrl(name), redirectUri: metadataDocument().redirect_uris[0], expect: 'refuse',
    })),
  ];
  const challenge = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('base64url');
  const results = [];
  for (const probeCase of cases) {
    const url = new URL(`${ORIGINS.pf}/as/authorization.oauth2`);
    url.search = new URLSearchParams({
      client_id: probeCase.clientId, response_type: 'code', scope: 'openid', redirect_uri: probeCase.redirectUri,
      code_challenge: challenge, code_challenge_method: 'S256', state: crypto.randomBytes(8).toString('hex'),
      response_mode: 'pi.flow',
    }).toString();
    const response = await outboundFetch(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const verdict = pfVerdict(response.status, await response.text());
    results.push({
      ...probeCase,
      ...verdict,
      asExpected: verdict.accepted === (probeCase.expect === 'accept'),
      trace: {
        id: `probe-${probeCase.id}`,
        title: probeCase.title,
        request: { method: 'GET', url: `${ORIGINS.pf}/as/authorization.oauth2`, params: Object.fromEntries(url.searchParams) },
        response: { status: response.status, body: { pingfederate: verdict.pfSays } },
      },
    });
  }
  return { results };
}

/** Serve this app's CIMD documents and the tester API. Mounted at the app root (documents have fixed public paths). */
export function cimdTesterRoutes() {
  const router = express.Router();
  router.get(CIMD_METADATA_PATH, (_req, res) => res.json(metadataDocument()));
  router.get(`${CIMD_NEGATIVE_PATH}/:name.json`, (req, res) => {
    const doc = negativeDocument(req.params.name);
    return doc ? res.json(doc) : res.status(404).json({ error: 'not_found' });
  });

  const api = express.Router();
  api.use(express.json());
  api.post('/tester/client', (req, res) => {
    const out = checkClient(req.body);
    return res.status(out.status ?? 200).json(out);
  });
  api.post('/tester/server', async (_req, res) => {
    try {
      const out = await checkServer();
      return res.status(out.status ?? 200).json(out);
    } catch {
      return res.status(502).json({ error: 'discovery_failed', message: 'PingFederate discovery could not be reached.' });
    }
  });
  api.post('/tester/probe', async (_req, res) => {
    const out = await probe();
    return res.status(out.status ?? 200).json(out);
  });
  router.use('/api/cimd', api);
  return router;
}

/** Point the mock PingFederate at this app's documents (the CIMD policy: the URLs it may fetch). */
export function enableMockCimd() {
  const urls = [documentUrl(), negativeUrl('client-id-mismatch'), negativeUrl('shared-secret')];
  wireMockCimd(async (url) => {
    const name = /negative\/([^/]+)\.json$/.exec(url)?.[1];
    const doc = name ? negativeDocument(name) : metadataDocument();
    return new Response(JSON.stringify(doc), { status: doc ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }, urls);
  return { documentUrl: documentUrl(), policy: urls };
}
