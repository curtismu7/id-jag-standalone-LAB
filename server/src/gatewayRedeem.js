// Gateway redeem: the playground mode where the Privilege MCP gateway turns the caller's token into the target app's own access
// token with two exchanges. Ping release claim (2026-11-02), UNVERIFIED on our tenant: everything here runs against in-process mocks.
//   leg 1  the gateway, configured with an On-Behalf-Of spec (OBO), exchanges the caller's token at the exchange issuer (RFC 8693).
//          The result is an ID-JAG assertion addressed to OBO.Resource.
//   leg 2  only when OBO.Redeem.TokenURL is set: the gateway redeems that assertion at the TARGET APP'S OWN issuer (RFC 7523 jwt-bearer),
//          so the target app sees the user with no shared credential. Without Redeem the exchange result is NOT redeemed.
// Field names OBO{TokenURL, ClientID, ClientSecret, AuthMethod, Resource, Scope, PrivateKeyPEM, KeyID, SubjectTokenType,
// RequestedTokenType, Redeem} and Redeem{TokenURL, ClientID, ClientSecret, AuthMethod, Scope, PrivateKeyPEM, KeyID} are the console
// swagger names (2026-10-31, schema only). Everything else is tagged in CLAIMS below. ClientSecret and PrivateKeyPEM are write-only.

import { createPrivateKey } from 'node:crypto';
import * as jose from 'jose';
import { gatewayWorld } from './mock/index.js';
import { ORIGINS } from './mock/env.js';
import { AUTH_METHODS, CLIENT_ASSERTION_TYPE, GATEWAY_RESOURCE, TOKEN_TYPES, runWith } from './mock/gatewayWorld.js';
import { outboundFetch } from './outbound.js';
import { decodeJwt } from './tokenChecks.js';
import { childTraceparent, newTraceparent } from './trace/traceparent.js';

export { AUTH_METHODS, TOKEN_TYPES };

export const CLAIM_BANNER = 'Ping release claim (2026-11-02), UNVERIFIED on our tenant';
export const LIVE_UNAVAILABLE = 'Live mode is not available for gateway redeem: the 2026-11-02 release is not on our tenant, so there is nothing real to call. This mode runs against in-process mocks only.';

export const TAG = {
  swagger: 'console swagger name, 2026-10-31, schema only',
  reading: 'lab reading',
  invented: 'lab-invented',
  claim: CLAIM_BANNER,
};

const SPEC_FIELDS = ['TokenURL', 'ClientID', 'ClientSecret', 'AuthMethod', 'Resource', 'Scope', 'PrivateKeyPEM', 'KeyID', 'SubjectTokenType', 'RequestedTokenType'];
const REDEEM_FIELDS = ['TokenURL', 'ClientID', 'ClientSecret', 'AuthMethod', 'Scope', 'PrivateKeyPEM', 'KeyID'];
export const WRITE_ONLY = ['ClientSecret', 'PrivateKeyPEM'];
/** Every editable field of the spec, by path. A test keeps one mutation test per entry. */
export const FIELD_PATHS = [...SPEC_FIELDS.map((f) => `OBO.${f}`), 'OBO.Redeem', ...REDEEM_FIELDS.map((f) => `OBO.Redeem.${f}`)];

/** Every claim the screens make, with where it comes from. One list: the UI shows it and a test checks every field is in it. */
export const CLAIMS = [
  ...SPEC_FIELDS.map((f) => ({ id: `OBO.${f}`, text: `modelMcpOBOSpec.${f}`, tag: TAG.swagger })),
  { id: 'OBO.Redeem', text: 'modelMcpOBOSpec.Redeem (modelMcpOBORedeemSpec)', tag: TAG.swagger },
  ...REDEEM_FIELDS.map((f) => ({ id: `OBO.Redeem.${f}`, text: `modelMcpOBORedeemSpec.${f}`, tag: TAG.swagger })),
  { id: 'redeem-gated-by-tokenurl', text: 'Leg 2 runs only when Redeem.TokenURL is set; without it the exchange result is not redeemed', tag: TAG.claim },
  { id: 'resource-is-aud', text: 'OBO.Resource (RFC 8707) becomes the aud of the exchanged assertion', tag: TAG.swagger },
  { id: 'resource-is-target-issuer', text: 'The lab sets Resource to the target app issuer, so the assertion is addressed to the authorization server that redeems it', tag: TAG.reading },
  { id: 'auth-method-values', text: 'AuthMethod values client_secret_basic, client_secret_post and private_key_jwt (OAuth client authentication names)', tag: TAG.reading },
  { id: 'token-type-values', text: 'SubjectTokenType and RequestedTokenType values (RFC 8693 token type URNs, ID-JAG draft id-jag)', tag: TAG.reading },
  { id: 'act-claim', text: 'The assertion carries sub = the user and act.sub = the calling client', tag: TAG.reading },
  { id: 'single-use-jti', text: 'The target issuer accepts each assertion jti once', tag: TAG.reading },
  { id: 'allow-list', text: 'The gateway may call only the allow-listed mock issuer hosts, over https, and follows no redirect', tag: TAG.invented },
  { id: 'clear-with-null', text: 'Writing null to a write-only field clears it; leaving it out or empty keeps it', tag: TAG.invented },
  { id: 'scenarios', text: 'The ten scenarios and the faults they inject', tag: TAG.invented },
  { id: 'cast', text: 'Alice, the agent app, the company IdP, the partner issuer, the target app and its ledger API', tag: TAG.invented },
  { id: 'only-pf-idjag', text: 'Only PingFederate supports ID-JAG and DPoP in this lab family; the gateway redeem leg here is a mock, not a product test', tag: TAG.reading },
];

// ---- The spec: validation, masking, the stored copy --------------------------------------------------------------------

const printable = (s) => /^[\x20-\x7e]*$/.test(s);
const isUrl = (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };
const text = (v, max) => typeof v === 'string' && v.length <= max;

const RULES = {
  TokenURL: (v) => (text(v, 2048) && (v === '' || isUrl(v)) ? null : 'must be an http(s) URL of at most 2048 characters, or empty'),
  ClientID: (v) => (text(v, 200) && printable(v) ? null : 'must be printable text of at most 200 characters'),
  AuthMethod: (v) => (AUTH_METHODS.includes(v) ? null : `must be one of ${AUTH_METHODS.join(', ')}`),
  Resource: (v) => (text(v, 2048) && (v === '' || isUrl(v)) ? null : 'must be an http(s) URL of at most 2048 characters, or empty'),
  Scope: (v) => (text(v, 500) && printable(v) ? null : 'must be printable text of at most 500 characters'),
  KeyID: (v) => (text(v, 200) && printable(v) ? null : 'must be printable text of at most 200 characters'),
  SubjectTokenType: (v) => (text(v, 200) && v !== '' && /^[\x21-\x7e]+$/.test(v) ? null : 'must be a token type URN of at most 200 characters'),
  RequestedTokenType: (v) => (text(v, 200) && v !== '' && /^[\x21-\x7e]+$/.test(v) ? null : 'must be a token type URN of at most 200 characters'),
  ClientSecret: (v) => (text(v, 512) && v.length >= 8 && !/[\x00-\x1f]/.test(v) ? null : 'must be 8 to 512 characters without control characters'),
  PrivateKeyPEM: (v) => {
    if (!text(v, 8192)) return 'must be a PEM private key of at most 8192 characters';
    try { createPrivateKey(v); return null; } catch { return 'is not a PEM private key this server can read'; }
  },
};

/** A fresh, empty Redeem leg (what a first Redeem edit starts from). */
const emptyRedeem = () => ({ TokenURL: '', ClientID: '', ClientSecret: '', AuthMethod: 'client_secret_post', Scope: '', PrivateKeyPEM: '', KeyID: '' });

/**
 * Apply an edit to a spec. Returns { spec, errors } and never throws. An error names the field and the rule, never the value.
 * Write-only fields: a non-empty string replaces the stored one, null clears it, undefined or empty keeps it.
 */
export function applyPatch(current, patch) {
  const errors = [];
  const spec = structuredClone(current);
  const bad = (field, message) => errors.push({ field, message });
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(patch)) return { spec: current, errors: [{ field: '(body)', message: 'must be an object' }] };
  for (const k of Object.keys(patch)) if (k !== 'OBO') bad(k, 'is not a field of the spec');
  const obo = patch.OBO;
  if (obo === undefined) return { spec: errors.length ? current : spec, errors };
  if (!isObj(obo)) return { spec: current, errors: [...errors, { field: 'OBO', message: 'must be an object' }] };

  const apply = (target, src, fields, prefix) => {
    for (const k of Object.keys(src)) if (!fields.includes(k) && !(prefix === 'OBO' && k === 'Redeem')) bad(`${prefix}.${k}`, 'is not a field of the spec');
    for (const f of fields) {
      const v = src[f];
      if (v === undefined) continue;
      if (WRITE_ONLY.includes(f)) {
        if (v === null) { target[f] = ''; continue; }
        if (v === '') continue;
        const why = typeof v === 'string' ? RULES[f](v) : 'must be text';
        if (why) bad(`${prefix}.${f}`, why); else target[f] = v;
        continue;
      }
      const why = typeof v === 'string' ? RULES[f](v) : 'must be text';
      if (why) bad(`${prefix}.${f}`, why); else target[f] = v;
    }
  };
  apply(spec.OBO, obo, SPEC_FIELDS, 'OBO');
  if (obo.Redeem === null) spec.OBO.Redeem = null;
  else if (obo.Redeem !== undefined) {
    if (!isObj(obo.Redeem)) bad('OBO.Redeem', 'must be an object or null');
    else {
      spec.OBO.Redeem = spec.OBO.Redeem ?? emptyRedeem();
      apply(spec.OBO.Redeem, obo.Redeem, REDEEM_FIELDS, 'OBO.Redeem');
    }
  }
  return { spec: errors.length ? current : spec, errors };
}

/** The spec as a response shows it: write-only fields become { set } and never carry a value. */
export function maskSpec(spec) {
  const mask = (o, fields) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fields.includes(k) ? { set: typeof v === 'string' && v !== '', writeOnly: true } : v]));
  const { Redeem, ...rest } = spec.OBO;
  return { OBO: { ...mask(rest, WRITE_ONLY), Redeem: Redeem ? mask(Redeem, WRITE_ONLY) : null } };
}

/** Every write-only value in a spec (and in an edit), as strings that must never appear in anything sent back. */
export function secretsIn(...objects) {
  const out = new Set();
  const take = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (WRITE_ONLY.includes(k) && typeof v === 'string' && v.length >= 4) {
        out.add(v);
        if (k === 'PrivateKeyPEM') {
          const body = v.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
          if (body.length >= 8) out.add(body);
          for (const line of v.split(/\r?\n/)) if (line.length >= 8 && !line.startsWith('-----')) out.add(line.trim());
        } else if (typeof o.ClientID === 'string' && o.ClientID) out.add(Buffer.from(`${o.ClientID}:${v}`).toString('base64'));
      } else if (v && typeof v === 'object') take(v);
    }
  };
  objects.forEach(take);
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replace every needle in every string of `value` (keys too). Returns a new value. */
export function scrub(value, needles) {
  const clean = (s) => needles.reduce((acc, n) => acc.split(n).join('[write-only]'), s);
  const walk = (v) => {
    if (typeof v === 'string') return clean(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k), walk(x)]));
    return v;
  };
  return walk(value);
}

// The stored spec, per workspace, in memory only (a secret is never written to disk). A new mock world starts over.
let store = { world: null, byWorkspace: new Map() };
function specs() {
  const world = gatewayWorld();
  if (store.world !== world) store = { world, byWorkspace: new Map() };
  return store.byWorkspace;
}
export const getSpec = (workspaceId = 'default') => {
  const m = specs();
  if (!m.has(workspaceId)) m.set(workspaceId, gatewayWorld().defaults());
  return m.get(workspaceId);
};
export const setSpec = (workspaceId, spec) => { specs().set(workspaceId, spec); };
/** Reset: the current workspace's spec back to the defaults, and the mock servers forget their used assertions. */
export function resetGatewayRedeem(workspaceId = 'default') {
  specs().delete(workspaceId);
  gatewayWorld().reset();
}

// ---- The gateway --------------------------------------------------------------------------------------------------------

/** A refusal by the gateway itself (not by an issuer): kind says which rule. */
class GatewayRefused extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

/** The one rule for where the gateway may call: https, a host on the allow-list (exact origin), no credentials in the URL. */
export function assertAllowedUrl(url, allowed = gatewayWorld().allowedOrigins) {
  let u;
  try { u = new URL(url); } catch { throw new GatewayRefused('ssrf', 'the URL is not a valid absolute URL'); }
  if (u.protocol !== 'https:') throw new GatewayRefused('ssrf', `only https is allowed, not ${u.protocol.replace(':', '')}`);
  if (u.username || u.password) throw new GatewayRefused('ssrf', 'a URL with credentials is not allowed');
  if (!allowed.includes(u.origin)) throw new GatewayRefused('ssrf', `${u.host} is not on the allow-list (${allowed.map((o) => new URL(o).host).join(', ')})`);
  return u;
}

const SHOW_FORM_REDACT = { client_secret: '[write-only]', client_assertion: '[signed with PrivateKeyPEM, write-only]' };
const showForm = (form) => Object.fromEntries([...form.entries()].map(([k, v]) => [k, SHOW_FORM_REDACT[k] ?? v]));

/** Client authentication for one leg: the headers and form fields to send, and the redacted view to show. */
async function clientAuth({ ClientID, ClientSecret, AuthMethod, PrivateKeyPEM, KeyID }, tokenUrl, form) {
  const headers = {};
  const need = (cond, msg) => { if (!cond) throw new GatewayRefused('config', msg); };
  need(ClientID, 'ClientID is not set');
  let shownAuth = 'none';
  if (AuthMethod === 'client_secret_basic') {
    need(ClientSecret, 'ClientSecret is not set (write-only)');
    headers.authorization = `Basic ${Buffer.from(`${ClientID}:${ClientSecret}`).toString('base64')}`;
    shownAuth = 'Basic [client credentials, write-only]';
  } else if (AuthMethod === 'client_secret_post') {
    need(ClientSecret, 'ClientSecret is not set (write-only)');
    form.set('client_id', ClientID); form.set('client_secret', ClientSecret);
    shownAuth = 'client_secret_post [write-only]';
  } else if (AuthMethod === 'private_key_jwt') {
    need(PrivateKeyPEM, 'PrivateKeyPEM is not set (write-only)');
    let key;
    try { key = createPrivateKey(PrivateKeyPEM); } catch { throw new GatewayRefused('config', 'PrivateKeyPEM is not a key this server can read'); }
    const alg = key.asymmetricKeyType === 'ec' ? 'ES256' : key.asymmetricKeyType === 'rsa' ? 'RS256' : null;
    need(alg, 'PrivateKeyPEM must be an EC or RSA key');
    const assertion = await new jose.SignJWT({}).setProtectedHeader({ alg, ...(KeyID ? { kid: KeyID } : {}) })
      .setIssuer(ClientID).setSubject(ClientID).setAudience(tokenUrl).setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime('60s').sign(key);
    form.set('client_id', ClientID); form.set('client_assertion_type', CLIENT_ASSERTION_TYPE); form.set('client_assertion', assertion);
    shownAuth = 'private_key_jwt [signed with PrivateKeyPEM, write-only]';
  } else {
    throw new GatewayRefused('config', `AuthMethod ${String(AuthMethod).slice(0, 40)} is not supported`);
  }
  return { headers, shownAuth };
}

/** One POST of the gateway to an issuer: allow-listed, no redirect followed, time and size capped, traced. */
async function post(ctx, { label, from, to, url, form, authHeaders, shownAuth }) {
  const hop = { n: ctx.hops.length + 1, label, from, to, method: 'POST', url: String(url).slice(0, 300), traceparent: childTraceparent(ctx.traceparent),
    request: { authentication: shownAuth, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: showForm(form) } };
  ctx.hops.push(hop);
  try {
    assertAllowedUrl(url, ctx.allowed);
  } catch (err) {
    hop.blocked = { kind: err.kind, reason: err.message };
    throw err;
  }
  const res = await outboundFetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', traceparent: hop.traceparent, ...authHeaders },
  });
  hop.status = res.status;
  if (res.status >= 300 && res.status < 400) {
    // fetch with redirect: 'error' throws on a real redirect; the in-process mock hands back the 3xx, which is refused just the same.
    hop.blocked = { kind: 'redirect', reason: `the server answered ${res.status} with a redirect; the gateway follows none` };
    throw new GatewayRefused('redirect', hop.blocked.reason);
  }
  const raw = await res.text();
  if (raw.length > 65536) throw new GatewayRefused('size', 'the response is larger than 64 KB');
  let data = {};
  try { data = JSON.parse(raw); } catch { /* not JSON: shown as an empty object */ }
  hop.response = data;
  return { status: res.status, data };
}

/** A GET with a bearer token to the target API (the gateway's own call, or a control call by the lab). */
async function getWithBearer(ctx, { label, from, to, url, token }) {
  const hop = { n: ctx.hops.length + 1, label, from, to, method: 'GET', url, traceparent: childTraceparent(ctx.traceparent),
    request: { authentication: token ? 'Bearer (mock token, shown raw)' : 'none', headers: token ? { authorization: `Bearer ${token}` } : {}, body: null } };
  ctx.hops.push(hop);
  const res = await outboundFetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json', traceparent: hop.traceparent, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  hop.status = res.status;
  hop.response = await res.json().catch(() => ({}));
  return { status: res.status, body: hop.response };
}

const view = (token) => { const d = decodeJwt(token); return d ? { header: d.header, claims: d.claims } : null; };
const oauthRefusal = (stage, r, check) => ({ stage, kind: 'oauth', status: r.status, error: r.data?.error ?? `http_${r.status}`, description: String(r.data?.error_description ?? '').slice(0, 280), ...(check ? { check } : {}) });

/**
 * The gateway handling one call: verify the caller's token, leg 1, leg 2 when Redeem.TokenURL is set, then present the result
 * to the target API. Returns what happened, stage by stage. It does not throw for a refusal: the refusal is the result.
 */
export async function gatewayCall(ctx, spec, callerToken) {
  const world = gatewayWorld();
  const out = { stage: 'caller', callerOk: false, leg1: null, leg2: null, redeemed: false, refusal: null, target: null, backendToken: null };
  try {
    await jose.jwtVerify(callerToken ?? '', world.company.publicKey, { algorithms: ['ES256'], issuer: ORIGINS.gwIdp, audience: GATEWAY_RESOURCE, typ: 'at+jwt', clockTolerance: 5 });
  } catch (err) {
    out.refusal = { stage: 'caller', kind: 'gateway', error: 'invalid_token', description: `the gateway does not accept the caller token: ${String(err.message).slice(0, 160)}` };
    return out;
  }
  out.callerOk = true;
  const o = spec.OBO;

  // Leg 1: RFC 8693 token exchange at the exchange issuer.
  out.stage = 'leg1';
  const f1 = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: callerToken, subject_token_type: o.SubjectTokenType, requested_token_type: o.RequestedTokenType });
  if (o.Resource) f1.set('resource', o.Resource);
  if (o.Scope) f1.set('scope', o.Scope);
  let r1;
  try {
    const auth = await clientAuth(o, o.TokenURL, f1);
    r1 = await post(ctx, { label: 'Leg 1: exchange the caller token (RFC 8693)', from: 'gateway', to: 'exchange issuer', url: o.TokenURL, form: f1, authHeaders: auth.headers, shownAuth: auth.shownAuth });
  } catch (err) {
    if (!(err instanceof GatewayRefused)) throw err;
    out.refusal = { stage: 'leg1', kind: err.kind, error: err.kind, description: err.message.slice(0, 280) };
    return out;
  }
  const evt1 = (o.TokenURL.startsWith(ORIGINS.gwPartner) ? world.partner : world.company).events.list()[0];
  if (r1.status !== 200 || !r1.data.access_token) { out.refusal = oauthRefusal('leg1', r1, evt1?.check); return out; }
  const exchanged = r1.data.access_token;
  out.leg1 = { issuedTokenType: r1.data.issued_token_type, token: exchanged, decoded: view(exchanged) };

  const redeem = o.Redeem;
  if (!redeem || !redeem.TokenURL) {
    // No Redeem.TokenURL: the exchange result is NOT redeemed. It goes to the target as it is.
    out.stage = 'target';
    out.backendToken = exchanged;
  } else {
    out.stage = 'leg2';
    out.leg2 = await redeemLeg(ctx, redeem, exchanged, out);
    if (out.refusal) return out;
    out.redeemed = true;
    out.backendToken = out.leg2.token;
    out.stage = 'target';
  }
  const t = await getWithBearer(ctx, { label: 'Call the target app API with the backend token', from: 'gateway', to: 'target API', url: `${ORIGINS.gwApi}/ledger/entries`, token: out.backendToken });
  out.target = { status: t.status, body: t.body };
  if (t.status !== 200) out.refusal = { stage: 'target', kind: 'oauth', status: t.status, error: t.body?.error ?? `http_${t.status}`, description: String(t.body?.error_description ?? '').slice(0, 280), check: (t.body?.verified ?? []).find((v) => !v.ok)?.check };
  return out;
}

/** Leg 2 alone: POST the assertion to Redeem.TokenURL as an assertion grant. Sets out.refusal on a refusal. */
export async function redeemLeg(ctx, redeem, assertion, out = {}) {
  const world = gatewayWorld();
  const f2 = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  if (redeem.Scope) f2.set('scope', redeem.Scope);
  let r2;
  try {
    const auth = await clientAuth(redeem, redeem.TokenURL, f2);
    r2 = await post(ctx, { label: "Leg 2: redeem at the target app's own issuer (RFC 7523)", from: 'gateway', to: 'target issuer', url: redeem.TokenURL, form: f2, authHeaders: auth.headers, shownAuth: auth.shownAuth });
  } catch (err) {
    if (!(err instanceof GatewayRefused)) throw err;
    out.refusal = { stage: 'leg2', kind: err.kind, error: err.kind, description: err.message.slice(0, 280) };
    return null;
  }
  if (r2.status !== 200 || !r2.data.access_token) {
    out.refusal = oauthRefusal('leg2', r2, world.target.events.list()[0]?.check);
    return null;
  }
  return { token: r2.data.access_token, decoded: view(r2.data.access_token), scope: r2.data.scope };
}

// ---- Scenarios ----------------------------------------------------------------------------------------------------------

/** The ten scenarios (lab-invented). patch edits a copy of the spec for one run; fault injects a flaw into the next assertion. */
export const SCENARIOS = {
  happy: { label: 'Both legs, as configured', expect: { outcome: 'ok' },
    why: 'The gateway exchanges the caller token (leg 1) and redeems the assertion at the target issuer (leg 2). The API sees the user. The caller original token is refused by the API.' },
  'no-redeem': { label: 'No Redeem.TokenURL', patch: (s) => { s.OBO.Redeem = null; }, expect: { outcome: 'refused', stage: 'target' },
    why: 'Without Redeem.TokenURL there is no leg 2: the exchange result is not redeemed. It is an assertion, not an access token, so the target API refuses it.' },
  'untrusted-issuer': { label: 'Assertion from an issuer the target does not trust', patch: (s) => { s.OBO.TokenURL = `${ORIGINS.gwPartner}/token`; }, expect: { outcome: 'refused', stage: 'leg2', check: 'issuer' },
    why: 'The partner issuer exchanges fine, but its assertion is not signed by a key the target issuer trusts.' },
  'wrong-audience': { label: 'Assertion addressed to another audience', patch: (s) => { s.OBO.Resource = 'https://other-app.mock.invalid'; }, expect: { outcome: 'refused', stage: 'leg2', check: 'audience' },
    why: 'OBO.Resource becomes the aud of the assertion. The target issuer accepts only an assertion addressed to itself.' },
  expired: { label: 'Expired assertion', fault: 'expired', expect: { outcome: 'refused', stage: 'leg2', check: 'expiry' },
    why: 'The exchange issuer signs an assertion whose exp is already past. The target issuer checks exp.' },
  replay: { label: 'Replayed assertion', replay: true, expect: { outcome: 'ok', replayRefused: 'replay' },
    why: 'A captured assertion is posted a second time. The target issuer accepts each jti once.' },
  'bad-signature': { label: 'Tampered signature', fault: 'bad-signature', expect: { outcome: 'refused', stage: 'leg2', check: 'signature' },
    why: 'The assertion signature is altered after signing. The target issuer verifies it against the trusted key.' },
  ssrf: { label: 'Redeem.TokenURL on a host that is not allow-listed', patch: (s) => { s.OBO.Redeem.TokenURL = `${ORIGINS.pf}/as/token.oauth2`; }, expect: { outcome: 'refused', stage: 'leg2', kind: 'ssrf' },
    why: 'The gateway calls only allow-listed https hosts. Any other host is refused before a request is made.' },
  redirect: { label: 'Redeem.TokenURL that redirects', patch: (s) => { s.OBO.Redeem.TokenURL = `${ORIGINS.gwTarget}/token-redirect`; }, expect: { outcome: 'refused', stage: 'leg2', kind: 'redirect' },
    why: 'The token URL answers with a redirect. The gateway follows none (redirect: error), so the assertion is never sent on.' },
  'auth-method': { label: 'Wrong client authentication method', patch: (s) => { s.OBO.Redeem.AuthMethod = 'client_secret_basic'; }, expect: { outcome: 'refused', stage: 'leg2', error: 'invalid_client', check: 'client authentication method' },
    why: 'The target issuer registered the gateway client for client_secret_post or private_key_jwt. Basic is refused.' },
};

export const scenarioList = () => Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label, why: s.why, expect: s.expect, tag: TAG.invented }));

/** Does what happened match what the scenario says should happen? Computed from the outcome, never fixed. */
export function judge(scenario, run) {
  const want = scenario.expect;
  const got = run.refusal ? 'refused' : 'ok';
  const checks = [{ what: 'outcome', want: want.outcome, got }];
  if (want.stage) checks.push({ what: 'stage', want: want.stage, got: run.refusal?.stage ?? null });
  if (want.kind) checks.push({ what: 'kind', want: want.kind, got: run.refusal?.kind ?? null });
  if (want.error) checks.push({ what: 'error', want: want.error, got: run.refusal?.error ?? null });
  if (want.check) checks.push({ what: 'check', want: want.check, got: run.refusal?.check ?? null });
  if (want.replayRefused) checks.push({ what: 'replay refused', want: want.replayRefused, got: run.replay?.refusal?.check ?? null });
  return { pass: checks.every((c) => c.want === c.got), checks };
}

/**
 * Run one scenario end to end: the agent signs in (the mock company IdP issues the caller token), the call goes through the
 * gateway, and the lab then tries the caller's original token and the raw assertion at the target API as controls.
 */
export async function runScenario(id, spec) {
  const scenario = SCENARIOS[id];
  if (!scenario) throw Object.assign(new Error('unknown scenario'), { code: 'unknown_scenario' });
  const world = gatewayWorld();
  const run = spec ? structuredClone(spec) : getSpec();
  scenario.patch?.(run);
  const ctx = { hops: [], traceparent: newTraceparent(), allowed: world.allowedOrigins };
  const callerToken = await world.callerToken();
  ctx.hops.push({ n: 1, label: 'The agent calls the gateway with the caller token', from: 'agent', to: 'gateway', method: 'POST', url: `${GATEWAY_RESOURCE}`, traceparent: ctx.traceparent,
    request: { authentication: 'Bearer (mock token, shown raw)', headers: { authorization: `Bearer ${callerToken}` }, body: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'ledger_entries' } } }, status: null, note: 'in-process: the gateway is part of this server' });
  const result = await runWith({ fault: scenario.fault ?? null }, () => gatewayCall(ctx, run, callerToken));
  ctx.hops[0].status = result.callerOk ? 200 : 401;

  let replay = null;
  if (scenario.replay && result.leg1?.token) {
    const r = { refusal: null };
    const redeemed = await redeemLeg(ctx, run.OBO.Redeem, result.leg1.token, r);
    replay = { attempted: true, accepted: Boolean(redeemed), refusal: r.refusal };
  }

  // Controls: what the target API says to the caller's original token, and to the raw assertion.
  const controls = [];
  const control = async (label, token) => {
    const r = await getWithBearer(ctx, { label, from: 'lab (control)', to: 'target API', url: `${ORIGINS.gwApi}/ledger/entries`, token });
    controls.push({ label, status: r.status, error: r.body?.error ?? null, failedCheck: (r.body?.verified ?? []).find((v) => !v.ok)?.check ?? null, detail: String(r.body?.error_description ?? '').slice(0, 280) });
  };
  await control("The caller's original token presented to the target API", callerToken);
  if (result.leg1?.token && result.redeemed) await control('The raw assertion (ID-JAG) presented to the target API', result.leg1.token);

  const outcome = { ...result, replay };
  return {
    scenario: id, label: scenario.label, why: scenario.why, expect: scenario.expect, verdict: judge(scenario, outcome),
    ...outcome,
    callerToken: { token: callerToken, decoded: view(callerToken) },
    controls,
    traceparent: ctx.traceparent,
    hops: ctx.hops,
    targetIssuerEvents: world.target.events.list().slice(0, 5),
  };
}
