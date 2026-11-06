// ID-JAG playground API (/api/id-jag-playground): run the PingFederate ID-JAG flow one step at
// a time, inspect each artifact, and check it against draft-ietf-oauth-identity-assertion-authz-grant.
//
// Custody: real tokens never leave the server. The ID-JAG and the redeemed access token live in
// the session; in Live mode responses carry decoded header/claims and redacted request bodies only.
// Mock mode (rule 4) shows its mock-issued tokens raw: they are labelled mock (claims mock:true, simulated:true, X-Simulated).
//
// Modes:
//   pf-as  PingFederate (PF_URL) issues, our resource AS (resource-as/) redeems, mcp-sample serves. The ID-JAG can come
//          from the user's refresh token (OIDC) or from a SAML assertion this app signs for them (saml.js).
//   pf-pf  The outside "Acme" PingFederate issues, PingFederate (PF_URL) redeems via JWT bearer.
//          Two PingFederates because an IdP must not redeem its own ID-JAG (draft §9.3).
//   byo    An outside IdP from the trusted-IdP registry issued the ID-JAG; the user pastes it, or gets one
//          from xaa.dev's IdenX (/xaa/*, below).
//   gateway-redeem  The Privilege MCP gateway exchanges the caller's token (leg 1) and redeems the result at the target app's
//          own issuer (leg 2). Ping release claim 2026-11-02, UNVERIFIED on our tenant: mock only, routes in gatewayRedeemRoutes.js.
//   aws-agentcore  The AgentCore leg: the exchange issuer turns the caller token into an ID-JAG, the target issuer redeems it,
//          and a (mock) Bedrock AgentCore runtime runs a tool under a workload identity. Lab simulation, no AWS call: mock
//          only, routes in agentcoreRedeemRoutes.js.
// A mode whose settings are missing answers 409 not_configured, naming what to set.

import crypto from 'node:crypto';
import express from 'express';
import { config, secret } from './config.js';
import { isMock, runtimeEnv } from './mode.js';
import { setRegistrySource } from './mock/index.js';
import { mockSigninProblem } from './mockSignin.js';
import { getIssuerSubjectToken } from './issuerSession.js';
import { mountInterop } from './interop.js';
import { outboundFetch } from './outbound.js';
import * as trustedIdps from './trustedIdps.js';
import { SPEC, decodeJwt, inspect, issuerKeyCheck, scopeList, trimSlash } from './tokenChecks.js';
import { piFlowHandlers } from './auth/piFlow.js';
import { allowedDomains, checkEmail } from './auth/emailRules.js';
import gatewayRedeemRoutes from './gatewayRedeemRoutes.js';
import { LIVE_UNAVAILABLE, getSpec, resetGatewayRedeem } from './gatewayRedeem.js';
import agentcoreRedeemRoutes from './agentcoreRedeemRoutes.js';
import { currentWorkspace } from './workspace.js';
import { ORIGINS } from './mock/env.js';
import { API_AUDIENCE } from './mock/gatewayWorld.js';
import { buildAssertion, describeAssertion, samlClientProblem, samlFilesProblem, samlSettings, samlUnavailableReason, signerCertPem } from './saml.js';

export { decodeJwt, inspect };

const router = express.Router();
router.use(express.json());
// Every write acts on the caller's tokens or the registry: same-origin only (CSRF).
router.use((req, res, next) => (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== config().appOrigin
  ? res.status(403).json({ error: 'invalid_origin' }) : next()));

const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const REFRESH_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:refresh_token';
const SAML2_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:saml2';
const claimScopes = (c) => (Array.isArray(c?.scope) ? c.scope.map(String) : String(c?.scope || '').split(/\s+/).filter(Boolean));
const MODES = ['pf-as', 'pf-pf', 'byo', 'gateway-redeem', 'aws-agentcore'];
const DEFAULT_MODE = 'byo'; // the only mode that needs no settings to start (inspect works)

const need = (pairs) => pairs.filter(([, v]) => !v).map(([k]) => k); // [name, value] pairs -> the unset names
const pfEndpoints = (url) => ({
  issuer: url,
  jwksUrl: url ? `${url}/pf/JWKS` : '',
  tokenEndpoint: url ? `${url}/as/token.oauth2` : '',
  authorizationEndpoint: url ? `${url}/as/authorization.oauth2` : '',
});

function pfRedeemer(c = config()) {
  return { name: 'PingFederate (redeemer)', issuer: c.pfUrl, tokenEndpoint: pfEndpoints(c.pfUrl).tokenEndpoint, clientId: c.pfRedeemerClientId };
}
function ourResourceAs(c = config()) {
  return { name: 'Resource AS', issuer: c.resourceAsIssuer, tokenEndpoint: c.resourceAsTokenEndpoint, clientId: c.resourceAsClientId };
}

export function settings(mode = 'pf-as') {
  const c = config();
  if (mode === 'pf-pf') {
    return {
      idp: { name: 'Acme PingFederate (issuer)', ...pfEndpoints(c.acmePfUrl), exchangeClientId: c.acmeExchangeClientId },
      resourceAs: pfRedeemer(c),
      request: { audience: c.pfUrl, resource: c.pfResource, scope: c.scope, subjectTokenType: REFRESH_TOKEN_TYPE },
    };
  }
  const resourceAs = ourResourceAs(c);
  return {
    idp: { name: 'PingFederate (issuer)', ...pfEndpoints(c.pfUrl), exchangeClientId: c.pfExchangeClientId },
    resourceAs,
    request: { audience: resourceAs.issuer, resource: c.resource, scope: c.scope, subjectTokenType: REFRESH_TOKEN_TYPE },
  };
}

/** gateway-redeem: the page's config shape, filled from the stored spec (no secret in it). */
function gatewayRedeemSettings() {
  const o = getSpec().OBO;
  return {
    target: 'gateway-redeem',
    idp: { name: 'Exchange issuer (mock)', issuer: ORIGINS.gwIdp, jwksUrl: `${ORIGINS.gwIdp}/jwks`, tokenEndpoint: o.TokenURL, authorizationEndpoint: '', exchangeClientId: o.ClientID },
    resourceAs: { name: 'Target app issuer (mock)', issuer: ORIGINS.gwTarget, tokenEndpoint: o.Redeem?.TokenURL || '', clientId: o.Redeem?.ClientID || '' },
    request: { audience: o.Resource, resource: API_AUDIENCE, scope: o.Scope, subjectTokenType: o.SubjectTokenType },
  };
}

/** byo: the outside IdP (registry entry) issues; our resource AS or PingFederate redeems. */
function byoSettings(target = 'resource-as', entry = null) {
  const c = config();
  const pf = target === 'pingfederate';
  const resourceAs = pf ? pfRedeemer(c) : ourResourceAs(c);
  return {
    target,
    idp: { name: entry?.name || 'Your IdP', issuer: entry?.issuer || '', jwksUrl: entry?.jwksUrl || '', tokenEndpoint: '', exchangeClientId: '' },
    resourceAs: { ...resourceAs, clientId: (pf ? entry?.pfClientId : entry?.clientId) || resourceAs.clientId },
    request: { audience: resourceAs.issuer, resource: pf ? c.pfResource : c.resource, scope: entry?.scopes || '' },
  };
}

/** Env vars a mode (or a byo target) still needs, in the order to set them. A SAML run never uses the refresh-token client's secret. */
function missing(mode, target, saml = false) {
  if (mode === 'gateway-redeem') return []; // mock only; whether it can run is the mode check below (isMock)
  if (mode === 'aws-agentcore') return []; // mock only (a lab simulation, no AWS call); availability is the mode check below
  const c = config();
  const pfRedeem = [['PF_URL', c.pfUrl], ['PF_REDEEMER_CLIENT_SECRET', secret('PF_REDEEMER_CLIENT_SECRET')]];
  const asRedeem = [['RESOURCE_AS_ISSUER', c.resourceAsIssuer], ['RESOURCE_AS_CLIENT_SECRET', secret('RESOURCE_AS_CLIENT_SECRET')]];
  if (mode === 'pf-pf') {
    return need([['ACME_PF_URL', c.acmePfUrl], ['ACME_EXCHANGE_CLIENT_ID', c.acmeExchangeClientId],
      ['ACME_EXCHANGE_CLIENT_SECRET', secret('ACME_EXCHANGE_CLIENT_SECRET')], ...pfRedeem]);
  }
  if (mode === 'pf-as') {
    return need([['PF_URL', c.pfUrl], ['PF_EXCHANGE_CLIENT_ID', c.pfExchangeClientId],
      ...(saml ? [] : [['PF_EXCHANGE_CLIENT_SECRET', secret('PF_EXCHANGE_CLIENT_SECRET')]]), ...asRedeem]);
  }
  return need(target === 'pingfederate' ? pfRedeem : asRedeem);
}
// The Acme values are not the user's to invent: the owner of the shared Acme PingFederate supplies them.
const ACME_KEYS = ['ACME_PF_URL', 'ACME_EXCHANGE_CLIENT_ID', 'ACME_EXCHANGE_CLIENT_SECRET'];
const supplyHint = (keys) => (keys.some((k) => ACME_KEYS.includes(k))
  ? ` ${ACME_KEYS.filter((k) => keys.includes(k)).join(', ')} come from the owner of the shared Acme PingFederate as a three-key settings block: run npm run setup -- --mode=pf-pf --acme-settings=<file>, which also sets up the redeemer on your PingFederate (PF_REDEEMER_CLIENT_SECRET, PF_RESOURCE). The acme-user password is sent separately and typed into the sign-in modal.`
  : keys.includes('PF_REDEEMER_CLIENT_SECRET') ? ' PF_REDEEMER_CLIENT_SECRET is written by npm run setup -- --mode=pf-pf (it sets up the redeemer on your PingFederate).' : '');
const notConfigured = (res, keys) => res.status(409).json({ error: 'not_configured', missing: keys,
  message: `Not configured yet: set ${keys.join(', ')} (see .env.example), then restart the server.${supplyHint(keys)}` });

const issuerSecret = (mode) => secret(mode === 'pf-pf' ? 'ACME_EXCHANGE_CLIENT_SECRET' : 'PF_EXCHANGE_CLIENT_SECRET');

const modeOf = (req) => (MODES.includes(req?.session?.idJagPlaygroundMode) ? req.session.idJagPlaygroundMode : DEFAULT_MODE);

/** Settings for the session's mode; byo reads the IdP and target stored with the pasted ID-JAG. */
function settingsFor(req) {
  const mode = modeOf(req);
  if (mode === 'gateway-redeem') return gatewayRedeemSettings();
  if (mode === 'aws-agentcore') return settings('pf-as'); // live: this leg uses the pf-as issuer session and servers; the panel reads its own /state
  if (mode !== 'byo') return settings(mode);
  const byo = req.session?.idJagPlayground?.byo || {};
  return byoSettings(byo.target, byo.idpId ? trustedIdps.findById(byo.idpId) : null);
}

/** Who redeems for this session, with which secret, and what is still missing. */
function redeemContext(req) {
  const mode = modeOf(req);
  const s = settingsFor(req);
  const c = config();
  if (mode === 'pf-pf') return { s, defaultSecret: secret('PF_REDEEMER_CLIENT_SECRET'), missing: missing(mode) };
  if (mode === 'pf-as') return { s, defaultSecret: secret('RESOURCE_AS_CLIENT_SECRET'), missing: missing(mode, undefined, isSamlSession(req)) };
  const target = s.target === 'pingfederate' ? 'pingfederate' : 'resource-as';
  if (target === 'pingfederate') return { s, defaultSecret: secret('PF_REDEEMER_CLIENT_SECRET'), missing: missing('byo', target) };
  // byo to the resource AS: the secret belongs to our configured client only, not to a client id an entry names.
  const ours = s.resourceAs.clientId === c.resourceAsClientId;
  if (!ours && s.resourceAs.clientId === secret('XAA_DEV_RESOURCE_AS_CLIENT_ID')) {
    // xaa.dev: the IdenX entry's own idp-<id> client, with the secret its owner fetched once and set by name.
    return { s, defaultSecret: secret('XAA_DEV_RESOURCE_AS_CLIENT_SECRET'),
      missing: need([['RESOURCE_AS_ISSUER', c.resourceAsIssuer], ['XAA_DEV_RESOURCE_AS_CLIENT_SECRET', secret('XAA_DEV_RESOURCE_AS_CLIENT_SECRET')]]) };
  }
  return { s, defaultSecret: ours ? secret('RESOURCE_AS_CLIENT_SECRET') : '', missing: missing('byo', target) };
}

const signedIn = (req) => Boolean(getIssuerSubjectToken(req, modeOf(req)));
/** This session's ID-JAG came from a SAML assertion: there is no issuer refresh token behind it. */
const isSamlSession = (req) => modeOf(req) === 'pf-as' && req.session?.idJagPlayground?.saml === true;

const decoded = (token) => {
  const d = decodeJwt(token);
  return d ? { header: d.header, claims: d.claims } : null;
};

/** Real steps need the mode's settings and a sign-in at its issuer (byo brings its own ID-JAG); `samlOf(req)` says the run is SAML, which has no issuer sign-in. */
const requireRealWhen = (samlOf) => (req, res, next) => {
  const mode = modeOf(req);
  if (mode === 'gateway-redeem') return res.status(409).json({ error: 'not_applicable', message: 'Gateway redeem has no sign-in, issue or redeem steps here: use its own panel (/api/id-jag-playground/gateway-redeem).' });
  if (mode === 'aws-agentcore') return isMock()
    ? res.status(409).json({ error: 'not_applicable', message: 'The AWS AgentCore leg has no sign-in, issue or redeem steps here: use its own panel (/api/id-jag-playground/aws-agentcore).' })
    : next(); // live: this leg reuses the pf-as issuer sign-in (its refresh token is what leg 1 exchanges)
  if (mode === 'byo') return next();
  const saml = samlOf(req);
  const keys = missing(mode, undefined, saml);
  if (keys.length) return notConfigured(res, keys);
  if (!signedIn(req) && !saml) {
    return res.status(409).json({ error: 'sign_in_required', message: `Sign in at ${settings(mode).idp.name} first (step 1): it issues the ID-JAG from your session.` });
  }
  return next();
};
const requireReal = requireRealWhen(isSamlSession);
const requireIssuerSignIn = requireRealWhen(() => false); // issuing by refresh token: a SAML session does not stand in

const basic = (id, sec) => `Basic ${Buffer.from(`${id}:${sec}`).toString('base64')}`;

async function postForm(url, form, headers = {}) {
  const r = await outboundFetch(url, {
    method: 'POST', body: form.toString(), signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

/**
 * What to show of a token. Mock mode shows the mock-issued token raw, for education (rule 4; every answer in mock mode
 * carries simulated:true and X-Simulated, and the token's own claims say mock:true). Live mode never sends a token to the
 * browser: the placeholder is shown.
 */
const shownToken = (token, placeholder) => (isMock() && token ? token : placeholder);

/**
 * The RFC 8693 exchange for an ID-JAG: the form to send and the redacted form to show. The subject token is this session's
 * issuer refresh token, or (assertionXml) the signed SAML assertion, sent base64url by the SAML client.
 */
function exchangeRequest(req, scopeOverride, assertionXml) {
  const mode = modeOf(req);
  const s = settings(mode);
  const scope = scopeOverride ?? s.request.scope;
  const saml = typeof assertionXml === 'string';
  const clientId = saml ? samlSettings().clientId : s.idp.exchangeClientId;
  const subjectTokenType = saml ? SAML2_TOKEN_TYPE : s.request.subjectTokenType;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requested_token_type: ID_JAG_TOKEN_TYPE,
    subject_token: saml ? Buffer.from(assertionXml, 'utf8').toString('base64url') : getIssuerSubjectToken(req, mode),
    subject_token_type: subjectTokenType,
    audience: s.request.audience,
  });
  if (s.request.resource) body.set('resource', s.request.resource);
  if (scope) body.set('scope', scope);
  const shown = {
    endpoint: `POST ${s.idp.tokenEndpoint}`,
    body: {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: ID_JAG_TOKEN_TYPE,
      subject_token: shownToken(body.get('subject_token'), saml ? '[the signed SAML assertion, base64url, kept server-side]' : '[your session token, never sent to the browser]'),
      subject_token_type: subjectTokenType,
      audience: s.request.audience,
      resource: s.request.resource || undefined,
      scope: scope || undefined,
      client_id: clientId,
    },
  };
  return { s, auth: { Authorization: basic(clientId, saml ? secret('PF_SAML_CLIENT_SECRET') : issuerSecret(mode)) }, body, shown };
}

/** RFC 8693 exchange for an ID-JAG at the mode's issuer PingFederate, with the issuer-side refresh token or a signed SAML assertion. */
async function mintIdJag(req, scopeOverride, assertionXml) {
  const { s, auth, body, shown } = exchangeRequest(req, scopeOverride, assertionXml);
  const r = await postForm(s.idp.tokenEndpoint, body, auth);
  if (r.status !== 200 || !r.data?.access_token) {
    throw Object.assign(new Error(`${s.idp.name} refused the exchange (HTTP ${r.status} ${r.data?.error || ''})`),
      { pfError: r.data?.error, pfErrorDescription: r.data?.error_description });
  }
  return { idJag: r.data.access_token, request: shown };
}

/** Redeem at the resource AS and return status + body, error or not (negative tests need both). */
async function redeem(assertion, { clientId, clientSecret, scope, s, defaultSecret = '' }) {
  const id = clientId ?? s.resourceAs.clientId;
  const sec = clientSecret !== undefined ? clientSecret : defaultSecret;
  const body = new URLSearchParams({ grant_type: JWT_BEARER, assertion, client_id: id });
  if (s.request.resource) body.set('resource', s.request.resource);
  if (scope) body.set('scope', scope);
  const r = await postForm(s.resourceAs.tokenEndpoint, body, sec ? { Authorization: basic(id, sec) } : {});
  return { ...r, request: {
    endpoint: `POST ${s.resourceAs.tokenEndpoint}`,
    body: { grant_type: JWT_BEARER, assertion: shownToken(assertion, '[the ID-JAG]'), client_id: id, resource: s.request.resource || undefined, scope: scope || undefined },
  } };
}

function redactedTokenResponse(data) {
  const out = { ...data };
  if (out.access_token) out.access_token = shownToken(out.access_token, '[access token, kept server-side]');
  if (out.refresh_token) out.refresh_token = shownToken(out.refresh_token, '[refresh token, kept server-side]');
  return out;
}

const MODE_LABELS = { 'pf-as': 'PingFederate → resource AS', 'pf-pf': 'Acme PingFederate → PingFederate', byo: 'Your IdP → our resource AS', 'gateway-redeem': 'Gateway redeems the ID-JAG (mock only)', 'aws-agentcore': 'ID-JAG → mock AgentCore runtime (mock only)' };

function configFor(req) {
  const mode = modeOf(req);
  const c = config();
  return { ...settingsFor(req), mode,
    modes: MODES.map((id) => {
      if (id === 'gateway-redeem') return { id, label: MODE_LABELS[id], available: isMock(), reason: isMock() ? null : LIVE_UNAVAILABLE };
      if (id === 'aws-agentcore') return { id, label: MODE_LABELS[id], available: true, reason: isMock() ? null : 'Live runs legs 1-2 for real (PingFederate, the kit\'s resource-as); the runtime hop refuses until a live AgentCore runtime is deployed.' };
      const keys = id === 'byo' ? [] : missing(id);
      return { id, label: MODE_LABELS[id], available: !keys.length, reason: keys.length ? `Not configured: set ${keys.join(', ')}.${supplyHint(keys)}` : null };
    }),
    // What an outside IdP needs: aud = the issuer, and where its client redeems.
    publicEndpoints: {
      // Public: the issuer's own /token (RESOURCE_AS_TOKEN_ENDPOINT may be an internal address, e.g. in compose).
      'resource-as': { issuer: c.resourceAsIssuer, tokenEndpoint: c.resourceAsIssuer ? `${c.resourceAsIssuer}/token` : '' },
      pingfederate: { issuer: c.pfUrl, tokenEndpoint: pfEndpoints(c.pfUrl).tokenEndpoint },
    },
    byo: req.session?.idJagPlayground?.byo || null,
    xaa: { available: !xaaUnavailableReason(), reason: xaaUnavailableReason(), signedIn: !!req.session?.idJagXaa,
      user: req.session?.idJagXaa ? (req.session.idJagXaa.email || req.session.idJagXaa.sub) : null },
    saml: { available: !samlUnavailableReason(), reason: samlUnavailableReason(), audience: samlSettings().audience, issuer: samlSettings().issuer, supportedModes: ['pf-as'], appSignedIn: Boolean(req.session?.user?.email) },
    signedIn: signedIn(req), hasIdJag: !!req.session?.idJagPlayground?.idJag,
    // Who the sign-in belongs to, so step 1 can say so. In pf-as the issuer session IS the app sign-in's refresh token.
    signedInAs: signedIn(req) && mode === 'pf-as' ? (req.session?.user?.email || null) : null,
    hasAccessToken: !!req.session?.idJagPlayground?.accessToken };
}

router.get('/config', (req, res) => res.json(configFor(req)));

// Gateway redeem: its own routes (spec, scenarios, run). Mock only. A body that cannot be read gets a plain answer, never a parser message.
router.use('/gateway-redeem', gatewayRedeemRoutes);
router.use('/gateway-redeem', (err, _req, res, next) => (err ? res.status(err.status === 413 ? 413 : 400).json({ error: 'invalid_request', message: 'The request body could not be read.' }) : next()));
// AWS AgentCore leg: its own routes (spec, scenarios, run). Mock only.
router.use('/aws-agentcore', agentcoreRedeemRoutes);
router.use('/aws-agentcore', (err, _req, res, next) => (err ? res.status(err.status === 413 ? 413 : 400).json({ error: 'invalid_request', message: 'The request body could not be read.' }) : next()));

router.post('/mode', (req, res) => {
  const mode = req.body?.mode;
  if (!MODES.includes(mode)) return res.status(400).json({ error: 'invalid_mode' });
  if (modeOf(req) !== mode) delete req.session.idJagPlayground; // tokens belong to one pairing
  req.session.idJagPlaygroundMode = mode;
  return req.session.save(() => res.json(configFor(req)));
});

// ---- Preflight: what would make the next button fail, checked before it is pressed. ----

const PREFLIGHT_STEPS = ['signin', 'issue', 'redeem', 'call', 'negative', 'resource', 'mode', 'xaa', 'revoke'];
const PROBE_TTL_MS = 30 * 1000;
const probes = new Map();
export const _clearProbeCache = () => probes.clear();

/** GET with a 4 s timeout. 2xx answers are cached 30 s; anything else never is, so Re-check sees a fix at once. */
export async function probe(url, fresh) {
  const hit = probes.get(url);
  if (!fresh && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.result;
  probes.delete(url);
  try {
    const r = await outboundFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    const result = { status: r.status, data: await r.json().catch(() => null) };
    if (r.status >= 200 && r.status < 300) probes.set(url, { at: Date.now(), result });
    return result;
  } catch (err) {
    return { error: err.name === 'TimeoutError' ? 'no answer within 4 s' : err.cause?.code || err.message };
  }
}

const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const unreachable = (url, r) => (r.error ? `Could not reach ${url} (${r.error}).` : `${url} answered HTTP ${r.status}.`);
const protectedResourceUrl = () => (config().mcpUrl ? new URL('/protected/profile', config().mcpUrl).toString() : '');

const SLOW_MS = 1500;
const PROBE_TIMEOUT_MS = 4000;
/**
 * One discovery GET per configured backend, in parallel, from this server (so internal addresses work): up, slow
 * (over 1.5 s) or down (error, non-2xx, or no answer in 4 s). A resource AS without RFC 8414 metadata
 * (PingFederate as redeemer) falls back to its OpenID configuration.
 */
export async function probeBackends(s, mcpUrl, fetchImpl = outboundFetch) {
  // The issuer, not just its origin: a hosted resource AS can live under a path
  // (https://host/resource-as), whose discovery and JWKS are served under that path.
  const as = trimSlash(s.resourceAs.issuer || originOf(s.resourceAs.tokenEndpoint));
  const targets = [
    { id: 'idp', label: s.idp.name, urls: s.idp.issuer ? [`${trimSlash(s.idp.issuer)}/.well-known/openid-configuration`] : [] },
    { id: 'resource-as', label: s.resourceAs.name, urls: as ? [`${as}/.well-known/oauth-authorization-server`, `${as}/.well-known/openid-configuration`] : [] },
    { id: 'mcp', label: 'MCP server', urls: mcpUrl ? [`${originOf(mcpUrl)}/.well-known/oauth-protected-resource`] : [] },
  ];
  // A backend this mode has no address for is not shown (byo: the IdP is the user's own; a missing setting is
  // the preflight's and the mode banner's to report, not a red chip).
  return Promise.all(targets.filter((t) => t.urls.length).map(async ({ id, label, urls }) => {
    const started = Date.now();
    for (const [i, url] of urls.entries()) {
      let status;
      try {
        ({ status } = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }));
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return { id, label, url, state: 'down', ms: null, detail: timedOut ? 'no answer in 4 s' : String(err?.cause?.code || err?.message) };
      }
      if (status === 404 && i < urls.length - 1) continue;
      const ms = Date.now() - started;
      if (status < 200 || status >= 300) return { id, label, url, state: 'down', ms, detail: `HTTP ${status}` };
      return { id, label, url, state: ms > SLOW_MS ? 'slow' : 'up', ms, detail: `${ms} ms` };
    }
    return { id, label, url: urls.at(-1), state: 'down', ms: null, detail: 'HTTP 404' };
  }));
}

router.get('/backends', async (req, res) => res.json({ backends: await probeBackends(settingsFor(req), config().mcpUrl) }));

/**
 * What the resource AS recorded about this session's redemption (its own /events), so step 3 can show the AS
 * received the ID-JAG. A convenience: any failure answers 200 with a plain reason and never breaks the page.
 */
router.get('/as-events', async (req, res) => {
  const mode = modeOf(req);
  if (!(mode === 'pf-as' || (mode === 'byo' && req.session?.idJagPlayground?.byo?.target === 'resource-as'))) {
    return res.json({ available: false, reason: "This mode redeems at PingFederate, not at the kit's resource AS." });
  }
  try {
    // Fixed base: the configured token endpoint with its last segment dropped (…/token → …), never a caller-supplied URL.
    // `.origin` alone is wrong for an issuer that lives under a path (e.g. https://host/resource-as/token).
    const te = new URL(config().resourceAsTokenEndpoint);
    te.pathname = te.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '') || '/';
    const r = await outboundFetch(`${te.toString().replace(/\/$/, '')}/events`, { signal: AbortSignal.timeout(4000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const events = (await r.json()).events;
    const jti = decodeJwt(req.session?.idJagPlayground?.idJag)?.claims?.jti;
    const prefix = typeof jti === 'string' && jti ? jti.slice(0, 8) : null;
    // An accepted event wins over a newer refused replay (or forged same-jti attempt) of the same ID-JAG.
    const matches = prefix ? events.filter((e) => typeof e?.jti === 'string' && e.jti.startsWith(prefix)) : [];
    return res.json({
      available: true,
      entry: matches.find((e) => e.decision === 'accepted') || matches[0] || null,
      recent: events.slice(0, 5),
    });
  } catch {
    return res.json({ available: true, entry: null, recent: [], reason: "Could not read the resource AS's record." });
  }
});

/** Access token from step 3: presence and time left. */
function accessTokenCheck(add, pg, nowSec, byo) {
  const exp = decodeJwt(pg?.accessToken)?.claims?.exp;
  const left = typeof exp === 'number' ? exp - nowSec : null;
  if (!pg?.accessToken) add('access-token', 'Access token from step 3', 'fail', 'No access token yet.', 'Redeem the ID-JAG (step 3).');
  else if (left !== null && left <= 0) {
    add('access-token', 'Access token from step 3', 'fail', `It expired ${-left} s ago.`,
      byo ? 'Paste a fresh ID-JAG (step 1) and redeem it (step 3).' : 'Request a new ID-JAG (step 2) and redeem it (step 3).');
  } else add('access-token', 'Access token from step 3', 'pass', left === null ? 'Present (expiry unknown).' : `${left} s left.`);
}

/** The MCP server is up, and (with a token) trusts its issuer and is its audience. */
async function mcpCheck(add, pg, fresh, pfRedeems) {
  const { mcpUrl } = config();
  if (!mcpUrl) {
    add('mcp', 'MCP server is configured', 'fail', 'MCP_URL is unset.', 'Set MCP_URL to mcp-sample\'s /mcp (http://mcp-sample:9090/mcp in docker compose, http://localhost:9090/mcp locally), then restart the server.');
    return;
  }
  const url = new URL('/.well-known/oauth-protected-resource', mcpUrl).toString();
  const r = await probe(url, fresh);
  if (r.status !== 200 || !r.data?.resource) {
    add('mcp', 'MCP server answers', 'fail', unreachable(url, r), `Start mcp-sample (npm start -w mcp-sample, or docker compose), or fix MCP_URL (${mcpUrl}).`);
    return;
  }
  add('mcp', 'MCP server answers', 'pass', `${url} names resource ${r.data.resource}.`);
  const t = decodeJwt(pg?.accessToken)?.claims;
  if (!t) return;
  const trusted = (r.data.authorization_servers || []).includes(t.iss);
  const aud = [t.aud].flat();
  if (pfRedeems && !trusted) {
    add('mcp-trust', 'MCP server trusts this token\'s issuer', 'warn',
      `In this mode PingFederate (${t.iss}) minted the access token; mcp-sample trusts ${(r.data.authorization_servers || []).join(', ')} only.`,
      'Expect a refusal (401 invalid_token). Pick PingFederate → resource AS to see the token accepted.');
  } else if (!trusted) {
    add('mcp-trust', 'MCP server trusts this token\'s issuer', 'fail', `Token iss ${t.iss} is not in its authorization_servers (${(r.data.authorization_servers || []).join(', ')}).`,
      'Set mcp-sample\'s AS_ISSUER to RESOURCE_AS_ISSUER exactly, then restart it.');
  } else if (!aud.includes(r.data.resource)) {
    add('mcp-trust', 'Token audience is this MCP server', 'fail', `Token aud ${JSON.stringify(t.aud)}, but the MCP server is ${r.data.resource}.`,
      `Set ID_JAG_RESOURCE to ${r.data.resource} (and list it in resource-as ACCEPTED_RESOURCES), then request and redeem a new ID-JAG.`);
  } else {
    add('mcp-trust', 'MCP server trusts this token', 'pass', `iss ${t.iss} is trusted and aud is ${r.data.resource}.`);
  }
}

/** Every check that can make the next button fail, for the session's mode. Never returns a token or a secret. */
async function preflight(req, step) {
  const checks = [];
  const add = (id, label, status, detail, fix) => checks.push(status === 'pass' ? { id, label, status, detail } : { id, label, status, detail, fix });
  const at = (...steps) => steps.includes(step);
  const fresh = req.query.fresh === '1';
  const nowSec = Math.floor(Date.now() / 1000);
  const c = config();
  const here = originOf(req.query.origin);

  // Every POST must carry Origin = APP_ORIGIN (CSRF check): a page on another host fails every action.
  add('origin', 'This page is on APP_ORIGIN', !here ? 'warn' : here === c.appOrigin ? 'pass' : 'fail',
    !here ? 'Could not tell which host this page is on.' : here === c.appOrigin ? here
      : `This page is on ${here}, but APP_ORIGIN is ${c.appOrigin}: the server refuses every action from this page (invalid_origin).`,
    `Open ${c.appOrigin}, or set APP_ORIGIN=${here || 'this page\'s origin'} in .env and restart the server.`);

  if (step === 'mode') {
    const target = String(req.query.mode || '');
    const known = MODES.includes(target);
    const keys = known && target !== 'byo' ? missing(target) : [];
    const liveBlocked = target === 'gateway-redeem' && !isMock();
    const liveReason = LIVE_UNAVAILABLE;
    add('mode', `This server can run ${known ? target : 'that mode'}`, !known || keys.length || liveBlocked ? 'fail' : 'pass',
      !known ? `"${target}" is not a playground mode.` : liveBlocked ? liveReason : keys.length ? `Not configured: ${keys.join(', ')} unset.` : target === 'aws-agentcore' && !isMock() ? 'Available: legs 1-2 run for real; the runtime hop refuses until a live AgentCore runtime is deployed.' : 'Available.',
      liveBlocked ? 'Switch the header toggle to Mock to use this mode.' : known ? `Set ${keys.join(', ')} in .env (see .env.example), then restart the server.${supplyHint(keys)}` : 'Pick a mode from the toolbar.');
    return checks;
  }

  const mode = modeOf(req);
  if (req.query.mode && req.query.mode !== mode) {
    add('mode-sync', 'The server session is in this mode', 'fail',
      `This page is in ${req.query.mode}, the server session in ${mode} (the server restarted, or another tab changed it).`,
      'Reload the page: it puts the server session back in this mode.');
    return checks;
  }

  const byo = mode === 'byo';
  const s = settingsFor(req);
  const pg = req.session?.idJagPlayground;
  const pfRedeems = mode === 'pf-pf' || s.target === 'pingfederate';
  const samlIssue = step === 'issue' && req.query.protocol === 'saml';
  const samlRun = samlIssue || (step !== 'issue' && isSamlSession(req)); // no issuer refresh token behind this run
  if (samlIssue) {
    const files = samlFilesProblem();
    add('saml-configured', 'SAML signing key and certificate are present', files ? 'fail' : 'pass', files || 'This app can sign assertions.', 'Run pingfederate/configure-saml.js, then restart with deploy/docker-compose.saml.yml.');
    const client = samlClientProblem();
    add('saml-client', 'SAML exchange client secret is set', client ? 'fail' : 'pass', client || `Client ${samlSettings().clientId} has a secret.`, 'Run pingfederate/configure-saml.js (it writes PF_SAML_CLIENT_SECRET to .env), then restart the server.');
  }

  if (step === 'resource') {
    await mcpCheck(add, pg, fresh, pfRedeems);
    const variant = req.query.variant;
    if (variant === 'token') accessTokenCheck(add, pg, nowSec, byo);
    if (variant === 'id-jag') {
      add('id-jag', 'An ID-JAG to present', pg?.idJag ? 'pass' : 'fail', pg?.idJag ? 'Present.' : 'No ID-JAG in this session yet.',
        byo ? 'Paste your ID-JAG in step 1.' : 'Click Request ID-JAG (step 2).');
    }
    return checks;
  }

  if (step === 'xaa') {
    const reason = xaaUnavailableReason();
    add('xaa-available', 'xaa.dev is available on this server', reason ? 'fail' : 'pass', reason || 'IdenX client and our redeeming client set; resource-as has a public https issuer.',
      'See "Use xaa.dev (IdenX) as a free outside IdP" in the setup guides (/guides).');
    const url = `${XAA_ISSUER}/.well-known/openid-configuration`;
    const r = await probe(url, fresh);
    const up = r.status === 200 && r.data?.issuer === XAA_ISSUER;
    add('idenx', 'IdenX (xaa.dev) answers', up ? 'pass' : 'fail', up ? `${url} names ${XAA_ISSUER}.` : unreachable(url, r),
      `xaa.dev may be down (try again later), or this server cannot reach ${XAA_ISSUER}.`);
    const e = xaaEntry();
    const ok = e?.status === 'approved' && e.targets.includes('resource-as');
    add('xaa-trusted-idp', 'IdenX is an approved trusted IdP for resource-as', ok ? 'pass' : 'fail',
      !e ? `No trusted IdP has issuer ${XAA_ISSUER}.` : ok ? `${e.name} (${e.id}) is approved for resource-as.`
        : e.status !== 'approved' ? `${e.name} (${e.id}) is ${e.status}.` : `${e.name} (${e.id}) does not target resource-as.`,
      `On the Trusted IdPs page, register issuer ${XAA_ISSUER}, JWKS ${XAA_ISSUER}/jwks, target resource AS, scope cap read; an admin approves it.`);
    const unset = need([['XAA_DEV_RESOURCE_AS_CLIENT_ID', secret('XAA_DEV_RESOURCE_AS_CLIENT_ID')], ['XAA_DEV_RESOURCE_AS_CLIENT_SECRET', secret('XAA_DEV_RESOURCE_AS_CLIENT_SECRET')]]);
    const named = !!e && secret('XAA_DEV_RESOURCE_AS_CLIENT_ID') === e.clientId;
    const client = e?.clientId || 'idp-<id>';
    add('xaa-client', 'Our redeeming client at resource-as is configured', !unset.length && named ? 'pass' : 'fail',
      unset.length ? `Missing: ${unset.join(', ')}.` : named ? `Set: ${client}.` : `XAA_DEV_RESOURCE_AS_CLIENT_ID is not the IdenX entry's client (${client}).`,
      `Fetch the secret for ${client} once (My IdPs on the Trusted IdPs page, as the entry's owner), set XAA_DEV_RESOURCE_AS_CLIENT_ID=${client} and XAA_DEV_RESOURCE_AS_CLIENT_SECRET, then restart the server.`);
    return checks;
  }

  if (byo && step === 'issue') {
    const target = req.query.target === 'pingfederate' ? 'pingfederate' : 'resource-as';
    const n = trustedIdps.trusted().filter((e) => e.targets.includes(target)).length;
    add('trusted-idp', `A trusted IdP can redeem at ${target}`, n ? 'pass' : 'warn', `${n} approved trusted IdP(s) target ${target}.`,
      `Register your IdP on the Trusted IdPs page with ${target} as a target and have an admin approve it, or the inspection reports it untrusted.`);
    return checks;
  }
  if (byo && step === 'signin') return checks;

  const keys = byo ? missing('byo', s.target) : missing(mode, undefined, samlRun);
  add('config', 'Required settings are present', keys.length ? 'fail' : 'pass', keys.length ? `Missing: ${keys.join(', ')}.` : 'All set.',
    `Set ${keys.join(', ')} in .env (see .env.example), then restart the server.`);

  if (!byo && step !== 'signin') {
    const ok = samlIssue ? Boolean(req.session?.user?.email) : signedIn(req) || samlRun;
    add('signed-in', samlIssue ? 'Signed in to this app' : `Signed in at ${s.idp.name}`, ok ? 'pass' : 'fail',
      samlIssue ? (ok ? 'This server holds your app sign-in (the assertion names its email).' : 'No app sign-in with an email in this session.')
        : ok ? 'This server holds your issuer session.' : 'No sign-in at this mode\'s issuer in this session (never signed in, signed in for the other mode, or the server restarted).',
      'Click the sign-in button in step 1.');
  }

  if (!byo && at('signin', 'issue', 'negative', 'revoke') && s.idp.issuer) {
    const key = mode === 'pf-pf' ? 'ACME_PF_URL' : 'PF_URL';
    const url = `${s.idp.issuer}/.well-known/openid-configuration`;
    const r = await probe(url, fresh);
    const got = r.status === 200 ? r.data?.issuer : undefined;
    add('issuer', `${s.idp.name} is up and is the issuer`, got === s.idp.issuer ? 'pass' : 'fail',
      r.status !== 200 ? unreachable(url, r) : !got ? `${url} names no issuer.` : got === s.idp.issuer ? `${url} names ${got}.` : `Discovery says the issuer is ${got}, but ${key} is ${s.idp.issuer}.`,
      got ? `Set ${key} to ${got} exactly.` : `Start ${s.idp.name} at ${s.idp.issuer}, or fix ${key}.`);
  }

  if (mode === 'pf-as' && at('issue') && !s.request.resource) {
    add('resource', 'The ID-JAG names the MCP resource', 'warn', 'ID_JAG_RESOURCE is unset, so the exchange asks for no resource.',
      'Set ID_JAG_RESOURCE to the MCP server\'s resource (mcp-sample MCP_RESOURCE): resource-as refuses an ID-JAG without one (invalid_target).');
  }

  if (s.idp.jwksUrl && at('issue', 'redeem', 'negative')) {
    const url = s.idp.jwksUrl;
    const r = await probe(url, fresh);
    const jwks = Array.isArray(r.data?.keys) ? r.data.keys : [];
    // A key listed under several kids is one key: count distinct moduli.
    const rsa = [...new Map(jwks.filter((k) => k.kty === 'RSA').map((k) => [`${k.n}.${k.e}`, k])).values()];
    const withX5t = rsa.filter((k) => k.x5t).length;
    if (r.error || r.status !== 200) {
      add('jwks', `${s.idp.name} signing keys`, 'fail', unreachable(url, r), `Make ${url} reachable: the redeemer fetches ${s.idp.name}'s signing keys there.`);
    } else if (!jwks.length) {
      add('jwks', `${s.idp.name} signing keys`, 'fail', `${url} lists no keys.`, `Give ${s.idp.name} an active signing key (on PingFederate: publish it through a JWT access token manager).`);
    } else if (pfRedeems && (rsa.length !== 1 || withX5t !== 1)) {
      add('jwks', `${s.idp.name} signing keys`, 'warn',
        `${rsa.length} distinct RSA keys (${withX5t} with x5t): the PingFederate redeemer may pick the wrong key and answer "Invalid JWT token".`,
        'Publish a single-key JWKS at the issuer, then make the redeeming PingFederate re-fetch it: re-save its IdP connection for this issuer, or restart it.');
    } else if (mode === 'pf-as' && !isMock() && issuerKeyCheck(jwks).status !== 'pass') { // the mock PingFederate signs with an EC key
      const v = issuerKeyCheck(jwks);
      add('jwks', `${s.idp.name} signing keys`, v.status,
        v.status === 'fail' ? `${rsa.length} distinct RSA key(s), none with x5t: PingFederate signs ID-JAGs with an x5t header and no kid, so resource-as cannot pick the key.`
          : `${rsa.length} distinct RSA keys (${withX5t} with x5t): PingFederate's own JWT-bearer consumer may pick the wrong one and answer "Invalid JWT token".`,
        'Rerun npm run setup -- --mode=pf-local, or publish the ID-JAG signing key through a JWT access token manager and set a static JWKS that holds only that key.');
    } else {
      add('jwks', `${s.idp.name} signing keys`, 'pass', `${jwks.length} key(s), ${rsa.length} distinct RSA.`);
    }
  }

  if (step === 'redeem' || (byo && step === 'negative')) {
    const again = byo ? 'Get a fresh ID-JAG from your IdP and paste it in step 1.' : 'Request a new ID-JAG (step 2).';
    const cl = pg?.idJag ? (decodeJwt(pg.idJag)?.claims || {}) : null;
    const left = typeof cl?.exp === 'number' ? cl.exp - nowSec : null;
    if (!cl) add('id-jag', 'An unused, unexpired ID-JAG', 'fail', 'No ID-JAG in this session yet.', byo ? 'Paste your ID-JAG and click Inspect ID-JAG (step 1).' : 'Click Request ID-JAG (step 2).');
    else if (pg.redeemed) add('id-jag', 'An unused, unexpired ID-JAG', 'fail', 'This ID-JAG was already redeemed, and each one is single-use.', again);
    else if (left !== null && left <= 0) add('id-jag', 'An unused, unexpired ID-JAG', 'fail', `It expired ${-left} s ago (ID-JAGs live about 5 minutes).`, again);
    else add('id-jag', 'An unused, unexpired ID-JAG', 'pass', left === null ? 'Unused (no exp claim).' : `Unused, ${left} s left.`);
    if (cl && typeof cl.exp === 'number' && typeof cl.iat === 'number' && cl.exp - cl.iat > 300) {
      add('lifetime', 'ID-JAG lifetime is 5 minutes or less', 'warn', `${cl.exp - cl.iat} s; the profile expects 300 s or less.`,
        `Lower the ID-JAG lifetime at ${s.idp.name} to 300 s${byo ? '' : ' (on PingFederate: the token lifetime of the access token manager that mints it)'}.`);
    }
    if (cl && step === 'redeem') {
      const asked = scopeList(req.query.scope);
      const extra = asked.filter((x) => !claimScopes(cl).includes(x));
      add('scope', 'Requested scope is in the ID-JAG', extra.length ? 'fail' : 'pass',
        extra.length ? `The ID-JAG does not grant ${extra.join(' ')}.` : asked.length ? `Narrowing to ${asked.join(' ')}.` : 'All scopes in this ID-JAG.',
        'Pick a scope from the list in step 3, or "All scopes in this ID-JAG".');
    }
  }

  if (at('redeem', 'negative') && s.resourceAs.tokenEndpoint) {
    const url = s.resourceAs.tokenEndpoint;
    const r = await probe(url, fresh);
    const bad = !!r.error || r.status >= 500;
    add('resource-as', `${s.resourceAs.name} token endpoint answers`, bad ? 'fail' : 'pass', bad ? unreachable(url, r) : `${url} answered (HTTP ${r.status}).`,
      pfRedeems ? 'Check PF_URL and that PingFederate is up.' : 'Start resource-as (npm start -w resource-as, or docker compose), or fix RESOURCE_AS_TOKEN_ENDPOINT.');
  }

  if (!pfRedeems && at('redeem', 'negative') && !runtimeEnv().ID_JAG_REGISTRY_TOKEN) {
    add('registry', 'resource-as can read this server\'s trust list', 'warn',
      'ID_JAG_REGISTRY_TOKEN is unset, so resource-as cannot read the Trusted IdPs registry (which also lists PF_URL for pf-as). Unless its TRUSTED_IDPS_FILE names the issuer, it answers "ID-JAG issuer is not trusted".',
      'Set ID_JAG_REGISTRY_TOKEN (openssl rand -hex 32) in .env for both this server and resource-as, then restart both.');
  }

  if (step === 'call') {
    accessTokenCheck(add, pg, nowSec, byo);
    await mcpCheck(add, pg, fresh, pfRedeems);
  }
  return checks;
}

router.get('/preflight', async (req, res) => {
  const step = String(req.query.step || '');
  if (!PREFLIGHT_STEPS.includes(step)) return res.status(400).json({ error: 'invalid_step', message: `step must be one of ${PREFLIGHT_STEPS.join(', ')}` });
  try {
    const checks = await preflight(req, step);
    return res.json({ ok: !checks.some((x) => x.status === 'fail'), step, mode: step === 'mode' ? req.query.mode : modeOf(req), checks });
  } catch (err) {
    return res.status(500).json({ error: 'preflight_failed', message: err.message });
  }
});

// Same-origin relative path only: no //host, no /\host (browsers read a backslash as a slash), printable ASCII.
const safeReturnTo = (p) => (typeof p === 'string' && /^\/(?![/\\])[!-~]*$/.test(p) ? p : '/');
const issuerRedirectUri = () => `${config().appOrigin}/api/id-jag-playground/issuer/callback`;

/** The pending issuer login (kept in the session) and the authorize URL for it. Shared with the pi.flow driver. */
function issuerAuthorizeRequest(mode, returnTo) {
  const s = settings(mode);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const login = { mode, state, verifier, returnTo: safeReturnTo(returnTo), at: Date.now() };
  const url = new URL(s.idp.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: s.idp.exchangeClientId, redirect_uri: issuerRedirectUri(),
    scope: mode === 'pf-pf' ? 'offline_access' : 'openid profile email offline_access', state, // the outside Acme PingFederate defines no OIDC scopes or policy
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  return { login, url };
}

// Sign in at the mode's issuer PingFederate (code + PKCE) without a redirect (auth/piFlow.js): this router already enforces same-origin and parses JSON.
const issuerFlow = piFlowHandlers({
  kind: 'issuer',
  key: 'idJagIssuerLogin',
  redirectUri: issuerRedirectUri,
  prepare(req) {
    const blocked = mockSigninProblem(req);
    if (blocked) return { fail: [blocked.status, { error: blocked.error, message: blocked.message }] };
    const mode = modeOf(req);
    if (mode === 'byo') return { fail: [409, { error: 'byo_mode', message: 'Your IdP issues the ID-JAG: no sign-in here.' }] };
    const keys = missing(mode);
    if (keys.length) return { fail: [409, { error: 'not_configured', missing: keys }] };
    const p = issuerAuthorizeRequest(mode, req.query.return_to);
    p.url.searchParams.set('prompt', 'login');
    return p;
  },
});
router.get('/issuer/pi-flow/start', issuerFlow.start);
router.post('/issuer/pi-flow/credentials', issuerFlow.credentials);

router.get('/issuer/callback', async (req, res) => {
  const pending = req.session?.idJagIssuerLogin;
  const back = pending?.returnTo || '/';
  delete req.session.idJagIssuerLogin;
  if (!pending || !req.query.code || req.query.state !== pending.state || Date.now() - pending.at > 10 * 60 * 1000) {
    return req.session.save(() => res.redirect(`${back}?issuer_error=invalid_state`));
  }
  const s = settings(pending.mode);
  try {
    const r = await postForm(s.idp.tokenEndpoint, new URLSearchParams({
      grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: issuerRedirectUri(), code_verifier: pending.verifier,
    }), { Authorization: basic(s.idp.exchangeClientId, issuerSecret(pending.mode)) });
    if (r.status !== 200 || !r.data?.refresh_token) {
      return req.session.save(() => res.redirect(`${back}?issuer_error=${encodeURIComponent(r.data?.error || `http_${r.status}`)}`));
    }
    req.session.idJagIssuer = { mode: pending.mode, refreshToken: r.data.refresh_token, sub: decodeJwt(r.data.id_token || '')?.claims?.sub || null };
    delete req.session.idJagPlayground;
    return req.session.save(() => res.redirect(back));
  } catch {
    return req.session.save(() => res.redirect(`${back}?issuer_error=exchange_failed`));
  }
});

/** The signed assertion for the app's signed-in user. The subject is the session's email, never anything from a request. */
const samlAssertionFor = (req) => buildAssertion({ subject: req.session?.user?.email, audience: samlSettings().audience }).xml;

/** Mint the ID-JAG (refresh token, or the SAML assertion when `assertionXml` is given), keep it in the session, answer with the redacted view. */
async function issueIdJag(req, res, assertionXml) {
  try {
    const { idJag, request } = await mintIdJag(req, assertionXml ? undefined : req.body?.scope, assertionXml); // the SAML client is not scope-restricted: its scope is fixed, never the caller's
    req.session.idJagPlayground = { idJag, issuedAt: Date.now(), redeemed: false, ...(assertionXml && { saml: true }) };
    res.json({
      ...(assertionXml && { assertion: describeAssertion(assertionXml) }),
      request, response: { issued_token_type: ID_JAG_TOKEN_TYPE, token_type: 'N_A', access_token: shownToken(idJag, '[the ID-JAG, kept server-side]') }, token: decoded(idJag),
    });
  } catch (err) {
    res.status(502).json({ error: 'id_jag_issue_failed', message: err.message, pfError: err.pfError, pfErrorDescription: err.pfErrorDescription });
  }
}

/** protocol "saml": this app signs an assertion for the signed-in user and PingFederate trades it for an ID-JAG in one exchange. */
async function issueSaml(req, res) {
  if (modeOf(req) !== 'pf-as') {
    return res.status(409).json({ error: 'saml_unsupported_mode', message: 'SAML works in the "PingFederate → resource AS" mode only.' });
  }
  const reason = samlUnavailableReason();
  if (reason) return res.status(409).json({ error: 'saml_not_configured', message: reason });
  const keys = missing('pf-as', undefined, true);
  if (keys.length) return notConfigured(res, keys);
  const email = req.session?.user?.email;
  if (typeof email !== 'string' || !email) {
    return res.status(401).json({ error: 'sign_in_required', message: 'Sign in to this app first (step 1): the SAML assertion names your email address.' });
  }
  // The app sign-in already passed these rules (and verified the email); apply them again to what is about to be signed.
  const refusal = checkEmail({ email, email_verified: true }, allowedDomains());
  if (refusal) return res.status(403).json({ error: 'email_not_allowed', message: refusal.message });
  let xml;
  try { xml = samlAssertionFor(req); } catch {
    return res.status(500).json({ error: 'saml_sign_failed', message: 'Could not sign the assertion: check SAML_SIGNING_KEY_FILE and SAML_SIGNING_CERT_FILE.' });
  }
  return issueIdJag(req, res, xml);
}

router.post('/issue', (req, res, next) => (req.body?.protocol === 'saml' ? issueSaml(req, res) : next()), requireIssuerSignIn, async (req, res) => {
  if (modeOf(req) === 'byo') return res.status(409).json({ error: 'byo_mode', message: 'Your IdP issues the ID-JAG: paste it in step 1.' });
  return issueIdJag(req, res);
});

/** The signer certificate, for anyone configuring another PingFederate to trust this app's SAML assertions. */
router.get('/saml/cert', (_req, res) => {
  try {
    if (samlUnavailableReason()) throw new Error('unavailable');
    return res.type('application/x-pem-file').send(signerCertPem());
  } catch {
    return res.status(404).json({ error: 'saml_not_configured' });
  }
});

/**
 * Revoke and prove it: check the exchange works (control), revoke this session's refresh token at the issuer
 * PingFederate (RFC 7009), then ask for a new ID-JAG with it. Proved = control 200, revoke accepted, and the
 * retry refused with an OAuth error. A failed control revokes nothing and keeps the sign-in; otherwise the issuer
 * sign-in is dropped: its refresh token is meant to be dead now. Tokens never leave the server.
 */
router.post('/revoke', requireReal, async (req, res) => {
  const mode = modeOf(req);
  if (mode === 'byo') return res.status(409).json({ error: 'byo_mode', message: 'Your IdP holds that session: revoke it there.' });
  if (isSamlSession(req)) return res.status(409).json({ error: 'no_refresh_token', message: 'A SAML sign-in has no refresh token to revoke.' });
  const { s, auth, body, shown } = exchangeRequest(req);
  const url = `${s.idp.issuer}/as/revoke_token.oauth2`;
  const revokeShown = { endpoint: `POST ${url}`, body: { token: shownToken(getIssuerSubjectToken(req, mode), '[your session token, never sent to the browser]'), token_type_hint: 'refresh_token', client_id: s.idp.exchangeClientId } };
  const outcome = (r) => ({ request: shown, status: r.status, error: r.status === 200 ? null : r.data?.error || `HTTP ${r.status}`, error_description: r.data?.error_description });
  try {
    // Control: the same exchange must work BEFORE revoking, or a later refusal proves nothing about the revocation.
    const control = await postForm(s.idp.tokenEndpoint, body, auth);
    if (control.status !== 200 || !control.data?.access_token) return res.json({ control: outcome(control), proved: false });
    const rv = await postForm(url, new URLSearchParams({ token: getIssuerSubjectToken(req, mode), token_type_hint: 'refresh_token' }), auth);
    const rt = await postForm(s.idp.tokenEndpoint, body, auth);
    delete req.session.idJagIssuer;
    delete req.session.idJagPlayground;
    return res.json({
      control: outcome(control),
      revoke: { request: revokeShown, status: rv.status, ...(rv.data?.error ? { error: rv.data.error, error_description: rv.data.error_description } : {}) },
      retry: outcome(rt),
      // RFC 8693 §2.2.2 refuses an invalid subject token with invalid_request; some servers say invalid_grant.
      proved: rv.status === 200 && rt.status !== 200 && ['invalid_request', 'invalid_grant'].includes(rt.data?.error),
    });
  } catch (err) {
    delete req.session.idJagIssuer;
    return res.status(502).json({ error: 'revoke_failed', message: `Could not reach ${s.idp.name} (${err.cause?.code || err.message}).` });
  }
});

router.post('/inspect', requireReal, async (req, res) => {
  const idJag = req.session?.idJagPlayground?.idJag;
  if (!idJag) return res.status(409).json({ error: 'no_id_jag', message: 'Issue an ID-JAG first.' });
  const s = settingsFor(req);
  // byo: the ID-JAG carries the client_id the IdP knows us by, not the redeeming client.
  const entry = modeOf(req) === 'byo' ? trustedIdps.findById(req.session.idJagPlayground.byo?.idpId) : null;
  res.json(await inspect(idJag, entry ? { ...s, resourceAs: { ...s.resourceAs, clientId: entry.idJagClientId } } : s));
});

const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]*$/;

/** byo step 1: inspect an ID-JAG against the trusted IdP its (unverified) iss names, and keep it for redeem. */
async function loadByoIdJag(req, idJag, target) {
  delete req.session.idJagPlayground;
  const d = decoded(idJag) || { header: {}, claims: {} };
  const iss = d.claims?.iss;
  const entry = trustedIdps.findByIssuer(iss);
  if (!entry || !entry.targets.includes(target)) {
    return { ...d, trusted: false,
      hint: entry ? `${entry.name} is trusted, but not for ${target}. Add ${target} to its targets on the Trusted IdPs panel.`
        : 'Add this issuer on the Trusted IdPs panel (admin) so our resource AS trusts it.',
      checks: [{ id: 'trusted-idp', label: 'Issuer is a trusted IdP', status: 'fail',
        expected: `an enabled Trusted IdP targeting ${target}`, actual: iss || '(missing)', cite: 'RFC 7523 §3: the AS MUST trust the issuer' }] };
  }
  req.session.idJagPlayground = { idJag, issuedAt: Date.now(), redeemed: false, byo: { target, idpId: entry.id } };
  const s = byoSettings(target, entry);
  const result = await inspect(idJag, { ...s, resourceAs: { ...s.resourceAs, clientId: entry.idJagClientId } });
  return { ...result, trusted: true, idp: { id: entry.id, name: entry.name }, config: configFor(req) };
}

router.post('/byo/inspect', async (req, res) => {
  if (modeOf(req) !== 'byo') return res.status(409).json({ error: 'not_byo_mode', message: 'Switch to the "Your IdP" mode first.' });
  const idJag = typeof req.body?.idJag === 'string' ? req.body.idJag.trim() : '';
  const target = req.body?.target === 'pingfederate' ? 'pingfederate' : 'resource-as';
  if (idJag.length > 16384 || !JWT_SHAPE.test(idJag)) return res.status(400).json({ error: 'invalid_id_jag', message: 'Paste a compact JWT (header.payload.signature).' });
  return res.json(await loadByoIdJag(req, idJag, target));
});

// ---- xaa.dev (Okta's free Cross App Access playground): its IdP, IdenX, as a real outside IdP for byo. ----
// Anyone signs in at IdenX with any email (so cap its registry entry to read). Our requesting app there is
// XAA_DEV_IDP_CLIENT_ID; the ID-JAGs it issues name the client registered at xaa.dev as "Target Client ID":
// the IdenX registry entry's idp-<id> client, whose secret this server holds as XAA_DEV_RESOURCE_AS_CLIENT_SECRET.
// IdenX tokens live in session.idJagXaa only; the browser gets decoded claims.

const XAA_ISSUER = 'https://idp.xaa.dev';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const xaaRedirectUri = () => `${config().appOrigin}/api/id-jag-playground/xaa/callback`;
const xaaClient = () => ({ client_id: secret('XAA_DEV_IDP_CLIENT_ID'), client_secret: secret('XAA_DEV_IDP_CLIENT_SECRET') });
/** The registry entry for IdenX, any status (issuers are unique in the registry). */
const xaaEntry = () => trustedIdps.list().find((e) => e.issuer === XAA_ISSUER) || null;

/** null when this server can run the xaa.dev flow, else why not. */
function xaaUnavailableReason() {
  if (isMock()) return 'xaa.dev is a service on the internet and mock mode makes no outside calls. Switch to Live to use it.';
  const issuer = config().resourceAsIssuer;
  if (!/^https:\/\//i.test(issuer)) {
    return `xaa.dev addresses ID-JAGs to a public https issuer registered at xaa.dev, and resource-as's issuer here is ${issuer || '(unset)'}: host this app (Phase 4) and register it.`;
  }
  const keys = need(['XAA_DEV_IDP_CLIENT_ID', 'XAA_DEV_IDP_CLIENT_SECRET', 'XAA_DEV_RESOURCE_AS_CLIENT_ID', 'XAA_DEV_RESOURCE_AS_CLIENT_SECRET'].map((k) => [k, secret(k)]));
  return keys.length ? `Not configured: set ${keys.join(', ')} (see .env.example), then restart the server.` : null;
}

// ponytail: discovery is fetched per call (three per sign-in + exchange); cache it if xaa.dev traffic ever matters.
async function xaaDiscovery() {
  const r = await outboundFetch(`${XAA_ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  const d = await r.json();
  const https = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
  if (d?.issuer !== XAA_ISSUER || ![d.authorization_endpoint, d.token_endpoint, d.jwks_uri].every(https)) throw new Error(`discovery is not for ${XAA_ISSUER}`);
  return d;
}

async function verifyXaaIdToken(idToken, d, nonce) {
  const { jwtVerify, createLocalJWKSet } = await import('jose');
  const jwks = await (await outboundFetch(d.jwks_uri, { signal: AbortSignal.timeout(10000) })).json();
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
    issuer: XAA_ISSUER, audience: secret('XAA_DEV_IDP_CLIENT_ID'), algorithms: ['RS256'], clockTolerance: 5,
  });
  if (payload.nonce !== nonce) throw new Error('nonce mismatch');
  return payload;
}

/** Sign in at IdenX: code + PKCE + state + nonce. */
router.get('/xaa/login', async (req, res) => {
  const back = safeReturnTo(req.query.return_to);
  if (xaaUnavailableReason()) return res.redirect(`${back}?xaa_error=unavailable`);
  let d;
  try { d = await xaaDiscovery(); } catch { return res.redirect(`${back}?xaa_error=idenx_unreachable`); }
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  req.session.idJagXaaLogin = { state, nonce, verifier, returnTo: back, at: Date.now() };
  const u = new URL(d.authorization_endpoint);
  // prompt=consent: an OpenID Provider grants offline_access (the refresh token we exchange) only with it (OIDC Core §11).
  u.search = new URLSearchParams({
    response_type: 'code', client_id: secret('XAA_DEV_IDP_CLIENT_ID'), redirect_uri: xaaRedirectUri(),
    scope: 'openid profile email offline_access', prompt: 'consent', state, nonce,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  return req.session.save(() => res.redirect(u.toString()));
});

router.get('/xaa/callback', async (req, res) => {
  const pending = req.session?.idJagXaaLogin;
  const back = pending?.returnTo || '/';
  delete req.session.idJagXaaLogin;
  const done = (q) => req.session.save(() => res.redirect(`${back}?${q}`));
  if (!pending || req.query.state !== pending.state || Date.now() - pending.at > 10 * 60 * 1000) return done('xaa_error=invalid_state');
  if (!req.query.code) return done(`xaa_error=${encodeURIComponent(String(req.query.error || 'no_code'))}`);
  try {
    const d = await xaaDiscovery();
    const r = await postForm(d.token_endpoint, new URLSearchParams({ // client_secret_post
      grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: xaaRedirectUri(), code_verifier: pending.verifier, ...xaaClient(),
    }));
    if (r.status !== 200 || !r.data?.id_token) return done(`xaa_error=${encodeURIComponent(r.data?.error || `http_${r.status}`)}`);
    let claims;
    try { claims = await verifyXaaIdToken(r.data.id_token, d, pending.nonce); } catch { return done('xaa_error=invalid_id_token'); }
    req.session.idJagXaa = { refreshToken: r.data.refresh_token || null, idToken: r.data.id_token, sub: claims.sub, email: claims.email || null };
    return done('xaa=signed_in');
  } catch {
    return done('xaa_error=exchange_failed');
  }
});

/** RFC 8693 at IdenX for an ID-JAG addressed to our resource-as, then the byo inspect path. */
router.post('/xaa/id-jag', async (req, res) => {
  if (modeOf(req) !== 'byo') return res.status(409).json({ error: 'not_byo_mode', message: 'Switch to the "Your IdP" mode first.' });
  const reason = xaaUnavailableReason();
  if (reason) return res.status(409).json({ error: 'xaa_unavailable', message: reason });
  const x = req.session?.idJagXaa;
  if (!x) return res.status(409).json({ error: 'xaa_sign_in_required', message: 'Sign in at IdenX (xaa.dev) first.' });
  const c = config();
  const [subject, type, name] = x.refreshToken
    ? [x.refreshToken, REFRESH_TOKEN_TYPE, 'refresh token']
    : [x.idToken, 'urn:ietf:params:oauth:token-type:id_token', 'ID token'];
  const body = { grant_type: TOKEN_EXCHANGE, requested_token_type: ID_JAG_TOKEN_TYPE, subject_token_type: type,
    audience: c.resourceAsIssuer, ...(c.resource ? { resource: c.resource } : {}), scope: 'read' };
  try {
    const d = await xaaDiscovery();
    const request = { endpoint: `POST ${d.token_endpoint}`,
      body: { ...body, subject_token: `[your IdenX ${name}, kept server-side]`, client_id: secret('XAA_DEV_IDP_CLIENT_ID') } };
    const r = await postForm(d.token_endpoint, new URLSearchParams({ ...body, subject_token: subject, ...xaaClient() }));
    if (r.status !== 200 || !r.data?.access_token) {
      if (r.data?.error === 'invalid_grant') delete req.session.idJagXaa; // dead IdenX session: the next click signs in again
      return res.status(502).json({ error: 'xaa_exchange_failed', message: `IdenX refused the ID-JAG exchange (HTTP ${r.status}${r.data?.error ? ` ${r.data.error}` : ''}).`,
        idpError: r.data?.error, idpErrorDescription: r.data?.error_description, request });
    }
    return res.json({ ...(await loadByoIdJag(req, r.data.access_token, 'resource-as')), request, response: redactedTokenResponse(r.data) });
  } catch (err) {
    return res.status(502).json({ error: 'xaa_exchange_failed', message: `Could not reach IdenX (${err.cause?.code || err.message}).` });
  }
});

router.post('/redeem', requireReal, async (req, res) => {
  const pg = req.session?.idJagPlayground;
  if (!pg?.idJag) return res.status(409).json({ error: 'no_id_jag', message: 'Issue an ID-JAG first.' });
  const ctx = redeemContext(req);
  if (ctx.missing.length) return notConfigured(res, ctx.missing);
  // Narrowing only: never ask for a scope the ID-JAG does not carry (the negative test does that on purpose).
  const granted = claimScopes(decodeJwt(pg.idJag)?.claims);
  const extra = scopeList(req.body?.scope).filter((x) => !granted.includes(x));
  if (extra.length) {
    return res.status(400).json({ error: 'scope_not_in_id_jag',
      message: `The ID-JAG does not grant ${extra.join(' ')}. Pick one it carries (${granted.join(' ') || 'none'}), or send no scope to get all of them.` });
  }
  try {
    const r = await redeem(pg.idJag, { scope: req.body?.scope, ...ctx });
    if (r.status === 200 && r.data.access_token) {
      req.session.idJagPlayground = { ...pg, redeemed: true, accessToken: r.data.access_token };
    }
    res.status(r.status === 200 ? 200 : 422).json({ request: r.request, status: r.status, response: redactedTokenResponse(r.data),
      token: r.data.access_token ? decoded(r.data.access_token) : null });
  } catch (err) {
    res.status(502).json({ error: 'redeem_failed', message: err.message });
  }
});

/** One JSON-RPC request to the MCP server (MCP_URL) with the access token. Server-side only: mcp-sample has no CORS. */
async function mcpRpc(token, rpc) {
  const r = await outboundFetch(config().mcpUrl, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...rpc }), signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
  });
  return { status: r.status, wwwAuthenticate: r.headers?.get?.('www-authenticate') || null, data: await r.json().catch(() => ({})) };
}

/** Step 4: tools/list (no tool) or tools/call at mcp-sample with the redeemed access token. */
router.post('/call', requireReal, async (req, res) => {
  const token = req.session?.idJagPlayground?.accessToken;
  if (!token) return res.status(409).json({ error: 'no_access_token', message: 'Redeem the ID-JAG first (step 3).' });
  if (!config().mcpUrl) return notConfigured(res, ['MCP_URL']);
  const tool = typeof req.body?.tool === 'string' ? req.body.tool : '';
  const args = req.body?.arguments && typeof req.body.arguments === 'object' ? req.body.arguments : {};
  const rpc = tool ? { method: 'tools/call', params: { name: tool, arguments: args } } : { method: 'tools/list' };
  const request = { endpoint: `POST ${config().mcpUrl}`, authorization: `Bearer ${shownToken(token, '[access token]')}`, body: { jsonrpc: '2.0', id: 1, ...rpc } }; // exactly what mcpRpc sends
  try {
    const r = await mcpRpc(token, rpc);
    const rpcError = r.data?.error && typeof r.data.error === 'object' ? r.data.error : null;
    if (r.status !== 200 || rpcError) {
      // The MCP server's own answer: HTTP status, OAuth error (401/403) or JSON-RPC error.
      const need = rpcError?.data?.requiredScope;
      return res.status(422).json({
        error: rpcError?.message || r.data?.error || `mcp_http_${r.status}`,
        message: need ? `${rpcError.data.tool} needs scope ${need}; this token does not carry it.` : rpcError ? rpcError.message : r.data?.error_description || `The MCP server answered HTTP ${r.status}.`,
        mcpStatus: r.status, wwwAuthenticate: r.wwwAuthenticate, request,
      });
    }
    if (tool) return res.json({ request, result: r.data.result });
    const list = r.data.result || {};
    const denied = Array.isArray(list._meta?.deniedTools) ? list._meta.deniedTools : [];
    return res.json({ request,
      tools: (list.tools || []).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 160), inputSchema: t.inputSchema || null })),
      deniedTools: denied.map((d) => (d.requiredScope ? `${d.name} (needs ${d.requiredScope})` : String(d.name ?? d))) });
  } catch (err) {
    return res.status(502).json({ error: 'mcp_unreachable', message: `Could not reach ${config().mcpUrl} (${err.cause?.code || err.message}).`, request });
  }
});

const RESOURCE_VARIANTS = {
  token: { token: (pg) => pg?.accessToken, shown: (t) => `Bearer ${shownToken(t, '[access token]')}`, missing: 'Redeem the ID-JAG first (step 3).' },
  'no-token': { token: () => null, shown: () => 'none' },
  'id-jag': { token: (pg) => pg?.idJag, shown: (t) => `Bearer ${shownToken(t, '[the ID-JAG]')}`, missing: 'Get an ID-JAG first (step 2, or paste one in step 1).' },
};

/** mcp-sample's /protected/profile with the access token, no token, or the raw ID-JAG. Tokens stay server-side. */
router.post('/resource', async (req, res) => {
  const v = RESOURCE_VARIANTS[req.body?.variant];
  if (!v) return res.status(400).json({ error: 'invalid_variant', message: `variant must be one of ${Object.keys(RESOURCE_VARIANTS).join(', ')}` });
  const url = protectedResourceUrl();
  if (!url) return notConfigured(res, ['MCP_URL']);
  const token = v.token(req.session?.idJagPlayground);
  if (v.missing && !token) return res.status(409).json({ error: 'no_token', message: v.missing });
  const request = { method: 'GET', url, authorization: v.shown(token) };
  try {
    const r = await outboundFetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) });
    return res.json({ request, status: r.status, wwwAuthenticate: r.headers?.get?.('www-authenticate') || null, body: await r.json().catch(() => null) });
  } catch (err) {
    return res.status(502).json({ error: 'resource_unreachable', message: `Could not reach ${url} (${err.cause?.code || err.message}).`, request });
  }
});

/**
 * Live negative tests against the real resource AS. Each one uses a FRESH ID-JAG
 * (PingFederate's are single-use), breaks one thing, and expects a refusal with no token.
 */
const NEGATIVE_TESTS = {
  replay: { label: 'Replay a redeemed ID-JAG', expect: 'invalid_grant',
    why: 'The resource AS enforces single-use jti (a hardening beyond the draft, which lets clients resubmit).' },
  'bad-signature': { label: 'Tampered signature', expect: 'invalid_grant', why: 'RFC 7523 §3: the AS MUST verify the signature.' },
  'client-mismatch': { label: 'Redeemed by a different client', expect: 'invalid_grant or invalid_client',
    why: `${SPEC} §4.4.1: client_id MUST identify the authenticating client.` },
  'scope-not-granted': { label: 'Ask for a scope the IdP did not grant', expect: 'invalid_scope',
    why: `${SPEC} §4.4.1: the AS grants at most what the ID-JAG grants.` },
};

router.get('/negative', (_req, res) => res.json(Object.entries(NEGATIVE_TESTS).map(([id, t]) => ({ id, ...t }))));

router.post('/negative/:id', requireReal, async (req, res) => {
  const test = NEGATIVE_TESTS[req.params.id];
  if (!test) return res.status(404).json({ error: 'unknown_test' });
  const byo = modeOf(req) === 'byo';
  if (byo && req.params.id === 'replay') {
    return res.json({ id: req.params.id, ...test, pass: null, skipped: true, note: 'Skipped: replay would redeem (and so use up) your ID-JAG.' });
  }
  const ctx = redeemContext(req);
  if (ctx.missing.length) return notConfigured(res, ctx.missing);
  try {
    // byo reuses the pasted ID-JAG: we cannot mint one at someone else's IdP.
    const idJag = byo ? req.session?.idJagPlayground?.idJag : (await mintIdJag(req, undefined, isSamlSession(req) ? samlAssertionFor(req) : undefined)).idJag;
    if (!idJag) return res.status(409).json({ error: 'no_id_jag', message: 'Paste and inspect your ID-JAG first.' });
    let r;
    if (req.params.id === 'replay') {
      const first = await redeem(idJag, ctx);
      if (first.status !== 200) return res.json({ id: req.params.id, ...test, pass: false, note: `setup redeem failed (${first.status} ${first.data.error || ''})` });
      r = await redeem(idJag, ctx);
    } else if (req.params.id === 'bad-signature') {
      const [h, p, sig] = idJag.split('.');
      const flipped = sig.slice(0, -2) + (sig.slice(-2) === 'AA' ? 'BB' : 'AA');
      r = await redeem(`${h}.${p}.${flipped}`, ctx);
    } else if (req.params.id === 'client-mismatch') {
      r = await redeem(idJag, { ...ctx, clientId: 'some-other-client', clientSecret: '' });
    } else {
      r = await redeem(idJag, { ...ctx, scope: 'admin:delete' });
    }
    const refused = r.status >= 400 && !r.data.access_token;
    res.json({ id: req.params.id, ...test, pass: refused, status: r.status, error: r.data.error || null,
      error_description: r.data.error_description || null, request: r.request });
  } catch (err) {
    res.status(502).json({ id: req.params.id, ...test, pass: false, note: err.message });
  }
});

// The trusted-IdP registry API lives in registry/routes.js (mounted at /api/id-jag-playground/trusted-idps).

/**
 * pf-as, once configured: resource-as must trust PF_URL's ID-JAGs, so its registry read carries PF_URL too.
 * resource-as binds client_id strictly (listed aliases only), so both ids PingFederate may write map to our
 * client: the exchange client (the refresh token's owner) and our client itself (an SP connection mapping).
 */
export function withPfAsIssuer({ idps }) {
  const c = config();
  if (missing('pf-as').length || idps.some((e) => e.issuer === c.pfUrl)) return { idps };
  return { idps: [{ id: 'pf-as', issuer: c.pfUrl, jwksUrl: pfEndpoints(c.pfUrl).jwksUrl,
    clientAliases: { [c.pfExchangeClientId]: c.resourceAsClientId, [c.resourceAsClientId]: c.resourceAsClientId }, scopes: '' }, ...idps] };
}

// Mock mode: the mock resource AS trusts exactly what the real one would be told to trust.
setRegistrySource(() => withPfAsIssuer(trustedIdps.resourceAsRegistry()));

// Start over from step 2: forget the ID-JAG and the access token (each ID-JAG is single-use, so a redeemed one is dead).
// Unlike /reset this keeps the sign-in at the issuer, so the next Request ID-JAG works straight away.
router.post('/restart', (req, res) => {
  if (req.session) delete req.session.idJagPlayground;
  res.json({ ok: true });
});

router.post('/reset', (req, res) => {
  if (req.session) { delete req.session.idJagPlayground; delete req.session.idJagIssuer; delete req.session.idJagXaa; }
  resetGatewayRedeem(currentWorkspace());
  res.json({ ok: true });
});

mountInterop(router, { requireReal, modeOf, exchangeRequest, postForm, basic, decodeJwt });

export default router;
