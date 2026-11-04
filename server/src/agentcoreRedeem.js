// AWS AgentCore leg: the playground mode where an agent's caller token becomes, in three hops, the access token a
// (mock) Bedrock AgentCore runtime accepts: the exchange issuer turns the caller token into an ID-JAG (RFC 8693),
// the AgentCore leg's target issuer redeems it (RFC 7523 jwt-bearer) and mints the runtime's access token, and the
// runtime runs one tool under a workload identity. All of it runs against in-process mocks (mock/agentcoreWorld.js).
// The AWS side is a lab simulation: no AWS service is called, nothing here is a product test of AgentCore.
// ClientSecret is write-only: every answer goes through scrub(), which removes any stored or just-typed value.

import { agentCoreWorld } from './mock/index.js';
import { API_AUDIENCE, AUTH_METHODS, CALLER_CLIENT_ID, CALLER_USER, RUNTIME_TOOL, SCOPES, TOKEN_TYPES } from './mock/agentcoreWorld.js';
// The fault context lives in gatewayWorld.js: the exchange issuer is the gateway leg's issuer and reads its fault from there.
import { runWith } from './mock/gatewayWorld.js';
import { ORIGINS } from './mock/env.js';
import { ID_JAG_TYP } from './mock/pf.js';
import { outboundFetch } from './outbound.js';
import { decodeJwt } from './tokenChecks.js';
import { childTraceparent, newTraceparent } from './trace/traceparent.js';

export { AUTH_METHODS, TOKEN_TYPES };

export const LIVE_UNAVAILABLE = 'Live mode is not available for the AWS AgentCore leg yet: the runtime deploy step is a separate, owner-run setup. This leg runs against in-process mocks only.';

export const TAG = {
  reading: 'lab reading',
  invented: 'lab-invented',
};

const EXCHANGE_FIELDS = ['TokenURL', 'ClientID', 'ClientSecret', 'AuthMethod', 'Resource', 'Scope', 'SubjectTokenType', 'RequestedTokenType'];
const REDEEM_FIELDS = ['TokenURL', 'ClientID', 'ClientSecret', 'AuthMethod', 'Scope'];
export const WRITE_ONLY = ['ClientSecret'];
/** Every editable field of the spec, by path. A test keeps one mutation test per entry. */
export const FIELD_PATHS = [...EXCHANGE_FIELDS.map((f) => `Exchange.${f}`), ...REDEEM_FIELDS.map((f) => `Redeem.${f}`)];

/** Every claim the screens make, with where it comes from. One list: the UI shows it and a test checks every field is in it. */
export const CLAIMS = [
  ...EXCHANGE_FIELDS.map((f) => ({ id: `Exchange.${f}`, text: `RFC 8693 exchange request: ${f}`, tag: TAG.reading })),
  ...REDEEM_FIELDS.map((f) => ({ id: `Redeem.${f}`, text: `RFC 7523 jwt-bearer redemption: ${f}`, tag: TAG.reading })),
  { id: 'idjag-typ', text: 'The exchange result is an ID-JAG: typ oauth-id-jag+jwt, aud = the target issuer, sub = the user, act.sub = the calling client', tag: TAG.reading },
  { id: 'idjag-ttl', text: 'The ID-JAG lives 300 s or less (draft-ietf-oauth-identity-assertion-authz-grant)', tag: TAG.reading },
  { id: 'single-use-jti', text: 'The target issuer accepts each ID-JAG jti once', tag: TAG.reading },
  { id: 'act-claim', text: 'The redeemed access token carries act.sub = the calling client: the runtime sees both the user and the agent', tag: TAG.reading },
  { id: 'wid-claim', text: 'The access token carries wid, the workload identity the runtime resolves for the redeeming client', tag: TAG.invented },
  { id: 'runtime-checks', text: 'The runtime accepts only its issuer\'s access tokens (typ at+jwt, right issuer and audience, tools:invoke) and refuses an ID-JAG outright', tag: TAG.reading },
  { id: 'runtime-tool', text: `The runtime runs one tool, ${RUNTIME_TOOL}, and names the workload identity in its answer`, tag: TAG.invented },
  { id: 'no-aws', text: 'The AWS side is a lab simulation: no AWS service is called, nothing here is a product test of AgentCore', tag: TAG.invented },
  { id: 'allow-list', text: 'The runner may call only the allow-listed mock issuer hosts, over https, and follows no redirect', tag: TAG.invented },
  { id: 'scenarios', text: 'The scenarios and the faults they inject', tag: TAG.invented },
  { id: 'cast', text: 'Alice, the agent app, the exchange issuer, the target issuer and the mock AgentCore runtime', tag: TAG.invented },
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
  SubjectTokenType: (v) => (text(v, 200) && v !== '' && /^[\x21-\x7e]+$/.test(v) ? null : 'must be a token type URN of at most 200 characters'),
  RequestedTokenType: (v) => (text(v, 200) && v !== '' && /^[\x21-\x7e]+$/.test(v) ? null : 'must be a token type URN of at most 200 characters'),
  ClientSecret: (v) => (text(v, 512) && v.length >= 8 && !/[\x00-\x1f]/.test(v) ? null : 'must be 8 to 512 characters without control characters'),
};

/**
 * Apply an edit to a spec. Returns { spec, errors } and never throws. An error names the field and the rule, never the
 * value. Write-only fields: a non-empty string replaces the stored one, null clears it, undefined or empty keeps it.
 */
export function applyPatch(current, patch) {
  const errors = [];
  const spec = structuredClone(current);
  const bad = (field, message) => errors.push({ field, message });
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(patch)) return { spec: current, errors: [{ field: '(body)', message: 'must be an object' }] };
  for (const k of Object.keys(patch)) if (k !== 'Exchange' && k !== 'Redeem') bad(k, 'is not a field of the spec');

  const apply = (target, src, fields, prefix) => {
    if (!isObj(src)) { bad(prefix, 'must be an object'); return; }
    for (const k of Object.keys(src)) if (!fields.includes(k)) bad(`${prefix}.${k}`, 'is not a field of the spec');
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
  apply(spec.Exchange, patch.Exchange ?? {}, EXCHANGE_FIELDS, 'Exchange');
  apply(spec.Redeem, patch.Redeem ?? {}, REDEEM_FIELDS, 'Redeem');
  return { spec: errors.length ? current : spec, errors };
}

/** The spec as a response shows it: write-only fields become { set } and never carry a value. */
export function maskSpec(spec) {
  const mask = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, WRITE_ONLY.includes(k) ? { set: typeof v === 'string' && v !== '', writeOnly: true } : v]));
  return { Exchange: mask(spec.Exchange), Redeem: mask(spec.Redeem) };
}

/** Every write-only value in a spec (and in an edit), as strings that must never appear in anything sent back. */
export function secretsIn(...objects) {
  const out = new Set();
  const take = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (WRITE_ONLY.includes(k) && typeof v === 'string' && v.length >= 4) {
        out.add(v);
        if (typeof o.ClientID === 'string' && o.ClientID) out.add(Buffer.from(`${o.ClientID}:${v}`).toString('base64'));
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
  const world = agentCoreWorld();
  if (store.world !== world) store = { world, byWorkspace: new Map() };
  return store.byWorkspace;
}
export const getSpec = (workspaceId = 'default') => {
  const m = specs();
  if (!m.has(workspaceId)) m.set(workspaceId, agentCoreWorld().defaults());
  return m.get(workspaceId);
};
export const setSpec = (workspaceId, spec) => { specs().set(workspaceId, spec); };
/** Reset: the current workspace's spec back to the defaults, and the mock servers forget their used assertions. */
export function resetAgentCore(workspaceId = 'default') {
  specs().delete(workspaceId);
  agentCoreWorld().reset();
}

// ---- The runner ---------------------------------------------------------------------------------------------------------

/** A refusal by the runner itself (not by an issuer): kind says which rule. */
class RunnerRefused extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

/** The one rule for where the runner may call: https, a host on the allow-list (exact origin), no credentials in the URL. */
export function assertAllowedUrl(url, allowed = agentCoreWorld().allowedOrigins) {
  let u;
  try { u = new URL(url); } catch { throw new RunnerRefused('ssrf', 'the URL is not a valid absolute URL'); }
  if (u.protocol !== 'https:') throw new RunnerRefused('ssrf', `only https is allowed, not ${u.protocol.replace(':', '')}`);
  if (u.username || u.password) throw new RunnerRefused('ssrf', 'a URL with credentials is not allowed');
  if (!allowed.includes(u.origin)) throw new RunnerRefused('ssrf', `${u.host} is not on the allow-list (${allowed.map((o) => new URL(o).host).join(', ')})`);
  return u;
}

const SHOW_FORM_REDACT = { client_secret: '[write-only]' };
const showForm = (form) => Object.fromEntries([...form.entries()].map(([k, v]) => [k, SHOW_FORM_REDACT[k] ?? v]));

/** Client authentication for one hop: the headers and form fields to send, and the redacted view to show. */
function clientAuth({ ClientID, ClientSecret, AuthMethod }, form) {
  const headers = {};
  const need = (cond, msg) => { if (!cond) throw new RunnerRefused('config', msg); };
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
  } else {
    throw new RunnerRefused('config', `AuthMethod ${String(AuthMethod).slice(0, 40)} is not supported`);
  }
  return { headers, shownAuth };
}

/** One POST of the runner to an issuer: allow-listed, no redirect followed, time and size capped, traced. */
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
    hop.blocked = { kind: 'redirect', reason: `the server answered ${res.status} with a redirect; the runner follows none` };
    throw new RunnerRefused('redirect', hop.blocked.reason);
  }
  const raw = await res.text();
  if (raw.length > 65536) throw new RunnerRefused('size', 'the response is larger than 64 KB');
  let data = {};
  try { data = JSON.parse(raw); } catch { /* not JSON: shown as an empty object */ }
  hop.response = data;
  return { status: res.status, data };
}

/** A POST with a bearer token to the runtime. */
async function invokeRuntime(ctx, { url, token }) {
  const hop = { n: ctx.hops.length + 1, label: 'Invoke the AgentCore runtime with the redeemed access token', from: 'runner', to: 'AgentCore runtime', method: 'POST', url, traceparent: childTraceparent(ctx.traceparent),
    request: { authentication: token ? 'Bearer (mock token, shown raw)' : 'none', headers: token ? { authorization: `Bearer ${token}` } : {}, body: { tool: RUNTIME_TOOL } } };
  ctx.hops.push(hop);
  const res = await outboundFetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), body: JSON.stringify({ tool: RUNTIME_TOOL }), headers: { 'content-type': 'application/json', accept: 'application/json', traceparent: hop.traceparent, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  hop.status = res.status;
  hop.response = await res.json().catch(() => ({}));
  return { status: res.status, body: hop.response };
}

const view = (token) => { const d = decodeJwt(token); return d ? { header: d.header, claims: d.claims } : null; };
const oauthRefusal = (stage, r, check) => ({ stage, kind: 'oauth', status: r.status, error: r.data?.error ?? `http_${r.status}`, description: String(r.data?.error_description ?? '').slice(0, 280), ...(check ? { check } : {}) });

/**
 * The runner handling one call: leg 1 (RFC 8693 exchange for an ID-JAG), leg 2 (RFC 7523 redemption at the target
 * issuer), then invoke the runtime with the redeemed access token. Returns what happened, stage by stage. It does not
 * throw for a refusal: the refusal is the result.
 */
export async function agentCoreCall(ctx, spec, callerToken) {
  const out = { stage: 'leg1', leg1: null, leg2: null, redeemed: false, refusal: null, runtime: null, backendToken: null };
  const e = spec.Exchange;

  // Leg 1: RFC 8693 token exchange at the exchange issuer.
  const f1 = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: callerToken, subject_token_type: e.SubjectTokenType, requested_token_type: e.RequestedTokenType });
  if (e.Resource) f1.set('resource', e.Resource);
  if (e.Scope) f1.set('scope', e.Scope);
  let r1;
  try {
    const auth = clientAuth(e, f1);
    r1 = await post(ctx, { label: 'Leg 1: exchange the caller token for an ID-JAG (RFC 8693)', from: 'runner', to: 'exchange issuer', url: e.TokenURL, form: f1, authHeaders: auth.headers, shownAuth: auth.shownAuth });
  } catch (err) {
    if (!(err instanceof RunnerRefused)) throw err;
    out.refusal = { stage: 'leg1', kind: err.kind, error: err.kind, description: err.message.slice(0, 280) };
    return out;
  }
  const evt1 = agentCoreWorld().company.events.list()[0];
  if (r1.status !== 200 || !r1.data.access_token) { out.refusal = oauthRefusal('leg1', r1, evt1?.check); return out; }
  const idJag = r1.data.access_token;
  out.leg1 = { issuedTokenType: r1.data.issued_token_type, token: idJag, decoded: view(idJag), isIdJag: r1.data.issued_token_type === TOKEN_TYPES.idJag && view(idJag)?.header?.typ === ID_JAG_TYP };
  out.backendToken = idJag;

  // Leg 2: RFC 7523 jwt-bearer redemption at the AgentCore leg's target issuer.
  out.stage = 'leg2';
  const rd = spec.Redeem;
  const f2 = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: idJag });
  if (rd.Scope) f2.set('scope', rd.Scope);
  let r2;
  try {
    const auth = clientAuth(rd, f2);
    r2 = await post(ctx, { label: "Leg 2: redeem the ID-JAG at the target issuer (RFC 7523)", from: 'runner', to: 'target issuer', url: rd.TokenURL, form: f2, authHeaders: auth.headers, shownAuth: auth.shownAuth });
  } catch (err) {
    if (!(err instanceof RunnerRefused)) throw err;
    out.refusal = { stage: 'leg2', kind: err.kind, error: err.kind, description: err.message.slice(0, 280) };
    return out;
  }
  if (r2.status !== 200 || !r2.data.access_token) {
    out.refusal = oauthRefusal('leg2', r2, agentCoreWorld().target.events.list()[0]?.check);
    return out;
  }
  out.redeemed = true;
  out.leg2 = { token: r2.data.access_token, decoded: view(r2.data.access_token), scope: r2.data.scope };
  out.backendToken = out.leg2.token;

  // Invoke the runtime with the redeemed access token.
  out.stage = 'runtime';
  const t = await invokeRuntime(ctx, { url: `${ORIGINS.acRuntime}/invoke`, token: out.backendToken });
  out.runtime = { status: t.status, body: t.body };
  if (t.status !== 200) {
    out.refusal = { stage: 'runtime', kind: 'oauth', status: t.status, error: t.body?.error ?? `http_${t.status}`, description: String(t.body?.error_description ?? '').slice(0, 280), check: (t.body?.verified ?? []).find((v) => !v.ok)?.check };
  }
  return out;
}

// ---- Scenarios ----------------------------------------------------------------------------------------------------------

/** The scenarios (lab-invented). patch edits a copy of the spec for one run; fault injects a flaw into the next ID-JAG. */
export const SCENARIOS = {
  happy: { label: 'All three hops, as configured', expect: { outcome: 'ok' },
    why: 'The exchange issues an ID-JAG (leg 1), the target issuer redeems it (leg 2), and the runtime runs the tool under the workload identity. The original caller token is refused by the runtime.' },
  'no-exchange': { label: 'Exchange issuer unreachable client', patch: (s) => { s.Exchange.ClientID = 'unknown-client'; }, expect: { outcome: 'refused', stage: 'leg1', error: 'invalid_client' },
    why: 'The exchange issuer only exchanges for clients it knows. An unknown client is refused before any token is issued.' },
  'wrong-resource': { label: 'ID-JAG addressed to another audience', patch: (s) => { s.Exchange.Resource = 'https://other-app.mock.invalid'; }, expect: { outcome: 'refused', stage: 'leg2', check: 'audience' },
    why: 'Exchange.Resource becomes the aud of the ID-JAG. The target issuer accepts only an assertion addressed to itself.' },
  expired: { label: 'Expired ID-JAG', fault: 'expired', expect: { outcome: 'refused', stage: 'leg2', check: 'expiry' },
    why: 'The exchange issuer signs an ID-JAG whose exp is already past. The target issuer checks exp.' },
  replay: { label: 'Replayed ID-JAG', replay: true, expect: { outcome: 'ok', replayRefused: 'replay' },
    why: 'A captured ID-JAG is presented a second time. The target issuer accepts each jti once.' },
  'bad-signature': { label: 'Tampered ID-JAG signature', fault: 'bad-signature', expect: { outcome: 'refused', stage: 'leg2', check: 'signature' },
    why: 'The ID-JAG signature is altered after signing. The target issuer verifies it against the trusted key.' },
  'wrong-client-binding': { label: 'Redeeming client is not the ID-JAG\'s client', patch: (s) => { s.Redeem.ClientID = 'nobody'; }, expect: { outcome: 'refused', stage: 'leg2', error: 'invalid_client' },
    why: 'The redeemer must be the client the ID-JAG names (agentcore-redeem). An unknown client is refused at authentication; a known one that the ID-JAG does not name is refused by client binding.' },
  'idjag-to-runtime': { label: 'ID-JAG presented straight to the runtime', patch: (s) => { s.Redeem.TokenURL = ''; }, expect: { outcome: 'refused', stage: 'leg2', kind: 'ssrf' },
    why: 'Without Redeem.TokenURL there is no leg 2: the runner refuses to call anywhere. An ID-JAG is a grant for an authorization server to redeem, never an access token for a runtime.' },
  'auth-method': { label: 'Wrong client authentication method', patch: (s) => { s.Redeem.AuthMethod = 'client_secret_basic'; s.Redeem.ClientSecret = ''; }, expect: { outcome: 'refused', stage: 'leg2', kind: 'config' },
    why: 'The redeemer is configured for client_secret_post; a client_secret_basic run has no secret set, and the runner refuses before calling.' },
  ssrf: { label: 'Redeem.TokenURL on a host that is not allow-listed', patch: (s) => { s.Redeem.TokenURL = 'https://elsewhere.mock.invalid/token'; }, expect: { outcome: 'refused', stage: 'leg2', kind: 'ssrf' },
    why: 'The runner calls only allow-listed https hosts. Any other host is refused before a request is made.' },
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
 * Run one scenario end to end: the agent's caller token goes through the two legs and the runtime invocation, and the
 * lab then tries the caller's original token and the raw ID-JAG at the runtime as controls.
 */
export async function runScenario(id, spec) {
  const scenario = SCENARIOS[id];
  if (!scenario) throw Object.assign(new Error('unknown scenario'), { code: 'unknown_scenario' });
  const world = agentCoreWorld();
  const run = spec ? structuredClone(spec) : getSpec();
  scenario.patch?.(run);
  const ctx = { hops: [], traceparent: newTraceparent(), allowed: world.allowedOrigins };
  const callerToken = await world.callerToken();
  ctx.hops.push({ n: 1, label: 'The agent hands its caller token to the runner', from: 'agent', to: 'runner', method: 'POST', url: '/api/id-jag-playground/aws-agentcore/run', traceparent: ctx.traceparent,
    request: { authentication: 'in-process', headers: {}, body: { scenario: id } }, status: null, note: 'in-process: the runner is part of this server' });
  const result = await runWith({ fault: scenario.fault ?? null }, () => agentCoreCall(ctx, run, callerToken));
  ctx.hops[0].status = 200;

  let replay = null;
  if (scenario.replay && result.leg1?.token) {
    const r = { refusal: null };
    const ctx2 = { hops: [], traceparent: ctx.traceparent, allowed: world.allowedOrigins };
    const again = await redeemOnly(ctx2, run, result.leg1.token, r);
    replay = { attempted: true, accepted: Boolean(again), refusal: r.refusal };
  }

  // Controls: what the runtime says to the caller's original token, and to the raw ID-JAG.
  const controls = [];
  const control = async (label, token) => {
    const r = await invokeRuntime(ctx, { url: `${ORIGINS.acRuntime}/invoke`, token });
    controls.push({ label, status: r.status, error: r.body?.error ?? null, failedCheck: (r.body?.verified ?? []).find((v) => !v.ok)?.check ?? null, detail: String(r.body?.error_description ?? '').slice(0, 280) });
  };
  await control("The caller's original token presented to the runtime", callerToken);
  if (result.leg1?.token && result.redeemed) await control('The raw ID-JAG presented to the runtime', result.leg1.token);

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

/** Leg 2 alone (the replay control): POST the assertion to Redeem.TokenURL as an assertion grant. Sets out.refusal on a refusal. */
export async function redeemOnly(ctx, spec, assertion, out = {}) {
  const rd = spec.Redeem;
  if (!rd.TokenURL) { out.refusal = { stage: 'leg2', kind: 'config', error: 'config', description: 'Redeem.TokenURL is not set' }; return null; }
  const f2 = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  if (rd.Scope) f2.set('scope', rd.Scope);
  let r2;
  try {
    const auth = clientAuth(rd, f2);
    r2 = await post(ctx, { label: "Leg 2: redeem at the target issuer (RFC 7523)", from: 'runner', to: 'target issuer', url: rd.TokenURL, form: f2, authHeaders: auth.headers, shownAuth: auth.shownAuth });
  } catch (err) {
    if (!(err instanceof RunnerRefused)) throw err;
    out.refusal = { stage: 'leg2', kind: err.kind, error: err.kind, description: err.message.slice(0, 280) };
    return null;
  }
  if (r2.status !== 200 || !r2.data.access_token) {
    out.refusal = oauthRefusal('leg2', r2, agentCoreWorld().target.events.list()[0]?.check);
    return null;
  }
  return r2.data.access_token;
}

export { CALLER_CLIENT_ID, CALLER_USER, API_AUDIENCE, SCOPES };
