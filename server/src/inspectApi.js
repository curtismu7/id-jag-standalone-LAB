// The Inspector API (/api/inspect): decode any pasted token and run the spec checks, fetch each backend's
// discovery metadata, and relay the resource AS's own decision record (resource-as/src/events.js). Stateless:
// a pasted token is decoded and dropped, never stored or echoed back whole.

import express from 'express';
import { config } from './config.js';
import * as trustedIdps from './trustedIdps.js';
import { describeAssertion } from './saml.js';
import { SPEC, decodeJwt, inspect, verifySignature } from './tokenChecks.js';
import { probe } from './idJagPlayground.js';
import { requestOrigin } from './requestOrigin.js';
import { outboundFetch } from './outbound.js';

const router = express.Router();
router.use(express.json());

const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };

/** Plain XML text from a pasted SAML assertion (raw, base64 or base64url), or null. */
function samlXml(token) {
  const t = String(token).trim();
  if (t.startsWith('<')) return t;
  if (/^[A-Za-z0-9+/_=-]+$/.test(t)) {
    const x = Buffer.from(t, 'base64').toString('utf8').trim();
    if (x.startsWith('<')) return x;
  }
  return null;
}

/** 'id-jag' | 'id-token' | 'access-token' | 'saml' | 'unknown'. */
export function classify(token) {
  if (samlXml(token)) return 'saml';
  const d = decodeJwt(String(token).trim());
  if (!d) return 'unknown';
  const { header: h, claims: c } = d;
  if (h.typ === 'oauth-id-jag+jwt') return 'id-jag';
  if (String(h.typ).toLowerCase() === 'at+jwt') return 'access-token';
  if (c.nonce !== undefined || c.at_hash !== undefined || c.auth_time !== undefined) return 'id-token';
  return c.scope !== undefined || c.scp !== undefined || c.client_id !== undefined ? 'access-token' : 'id-token';
}

const checker = () => {
  const checks = [];
  return { checks, add: (id, label, ok, expected, actual, cite, warn = false) =>
    checks.push({ id, label, status: ok ? 'pass' : (warn ? 'warn' : 'fail'), expected, actual, cite }) };
};

/** Did the resource AS already accept an ID-JAG with this jti? true / false / null (record unreadable). */
async function redeemedAtResourceAs(jti) {
  try {
    const r = await outboundFetch(`${originOf(config().resourceAsTokenEndpoint)}/events`, { signal: AbortSignal.timeout(4000) });
    if (r.status !== 200) return null;
    const prefix = String(jti).slice(0, 8);
    return (await r.json()).events.some((e) => e.decision === 'accepted' && typeof e.jti === 'string' && e.jti.startsWith(prefix));
  } catch {
    return null;
  }
}

async function checkIdJag(token, { verify, redeemed }) {
  const c = config();
  const d = decodeJwt(token);
  const entry = trustedIdps.findByIssuer(d.claims.iss);
  const pfTarget = d.claims.aud === c.pfUrl;
  const target = { issuer: pfTarget ? c.pfUrl : c.resourceAsIssuer, name: pfTarget ? 'PingFederate (redeemer)' : 'Resource AS' };
  const s = {
    idp: { name: entry?.name || 'unknown issuer', issuer: d.claims.iss, jwksUrl: entry?.jwksUrl || '' },
    resourceAs: { name: target.name, issuer: target.issuer, clientId: entry?.idJagClientId || c.resourceAsClientId },
    request: { resource: '' },
  };
  const result = await inspect(token, s, entry ? verify : async () => ({ ok: false, note: 'not checked: the issuer is not a trusted IdP' }));
  const { checks, add } = checker();
  add('trusted-idp', 'Issuer is an approved trusted IdP', !!entry, 'an approved Trusted IdP entry', entry ? entry.name : (d.claims.iss || '(missing)'),
    'RFC 7523 §3: the AS MUST trust the issuer');
  if (entry && !entry.targets.includes(pfTarget ? 'pingfederate' : 'resource-as')) {
    add('idp-target', 'IdP is trusted for this target', false, pfTarget ? 'pingfederate' : 'resource-as', entry.targets.join(', '), 'Trusted IdPs registry');
  }
  const seen = d.claims.jti ? await redeemed(d.claims.jti) : null;
  add('replay', 'jti not redeemed before', seen === false, 'not seen at the resource AS',
    seen === null ? 'resource AS record unreadable' : (seen ? 'already accepted (a replay would be refused)' : 'not seen'),
    `${SPEC} §4.4.1 / RFC 7523 §3`, seen === null);
  return { ...result, checks: [...checks, ...result.checks], idp: entry ? { id: entry.id, name: entry.name } : null };
}

function checkJwt(type, token) {
  const { header: h, claims: c } = decodeJwt(token);
  const { checks, add } = checker();
  const now = Math.floor(Date.now() / 1000);
  add('alg', 'Signed, not alg:none', !!h.alg && h.alg !== 'none', 'RS256 (or another asymmetric alg)', h.alg, 'RFC 8725 §3.1');
  const required = type === 'id-token' ? ['iss', 'sub', 'aud', 'exp', 'iat'] : ['iss', 'sub', 'aud', 'exp'];
  for (const k of required) {
    add(`claim-${k}`, `Required claim ${k}`, c[k] !== undefined && c[k] !== '', 'present', c[k] === undefined ? '(missing)' : c[k],
      type === 'id-token' ? 'OpenID Connect Core §2' : 'RFC 9068 §2.2');
  }
  add('exp', 'Not expired', typeof c.exp === 'number' && c.exp > now, `> ${now}`, c.exp, 'RFC 7519 §4.1.4');
  add('signature', 'Signature', false, 'checked against the issuer JWKS', 'not checked here: only ID-JAGs from trusted IdPs are verified', 'RFC 7515', true);
  return { header: h, claims: c, checks };
}

function checkSaml(xml) {
  const a = describeAssertion(xml);
  const { checks, add } = checker();
  add('saml-issuer', 'Issuer present', !!a.issuer, 'present', a.issuer || '(missing)', 'SAML 2.0 Core §2.3.3');
  add('saml-subject', 'Subject NameID present', !!a.nameId, 'present', a.nameId || '(missing)', 'SAML 2.0 Core §2.3.3');
  add('saml-audience', 'Audience restriction present', !!a.audience, 'present', a.audience || '(missing)', 'SAML 2.0 Core §2.5.1.4');
  add('saml-expiry', 'Not expired', Date.parse(a.notOnOrAfter) > Date.now(), 'NotOnOrAfter in the future', a.notOnOrAfter || '(missing)', 'SAML 2.0 Core §2.5.1');
  add('saml-signature', 'Signed', !!a.signature.algorithm, 'a ds:Signature', a.signature.algorithm || '(none)', 'SAML 2.0 Core §5');
  return { assertion: a, checks };
}

/** Detect the token kind and run its checks. verify / redeemed are injectable for tests. */
export async function checkToken(token, { verify = verifySignature, redeemed = redeemedAtResourceAs } = {}) {
  const t = String(token).trim();
  const type = classify(t);
  if (type === 'unknown') return { type, checks: [] };
  if (type === 'saml') return { type, ...checkSaml(samlXml(t)) };
  return { type, ...(type === 'id-jag' ? await checkIdJag(t, { verify, redeemed }) : checkJwt(type, t)) };
}

router.post('/decode', async (req, res) => {
  if (req.body?.fromSession === true) {
    // The ID-JAG the playground's issue route minted into THIS session (never one taken from the request). Same-origin only
    // (CSRF, as the playground's writes). It stays server-side unless the user asks to reveal it; never cached, never logged.
    res.set('Cache-Control', 'no-store');
    if (req.get('origin') !== requestOrigin(req)) return res.status(403).json({ error: 'invalid_origin' });
    const held = req.session?.idJagPlayground?.idJag;
    if (typeof held !== 'string') return res.status(409).json({ error: 'no_session_id_jag', message: 'No ID-JAG has been issued in this session yet.' });
    return res.json(req.body.reveal === true ? { token: held } : await checkToken(held));
  }
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token || token.length > 65536) return res.status(400).json({ error: 'invalid_token', message: 'Paste a token (a JWT or a SAML assertion).' });
  return res.json(await checkToken(token));
});

const PROFILE_FIELDS = ['authorization_grant_profiles_supported', 'scopes_supported'];

router.get('/discovery', async (_req, res) => {
  const c = config();
  // The issuer, not just its origin: a hosted resource AS can live under a path. In Docker the issuer is the browser's URL
  // (http://localhost:4721), which this server cannot reach, so read the metadata over the token endpoint's origin
  // (http://resource-as:9080) and keep the issuer's path.
  const tokenOrigin = originOf(c.resourceAsTokenEndpoint);
  const issuerPath = (() => { try { return new URL(c.resourceAsIssuer).pathname.replace(/\/$/, ''); } catch { return ''; } })();
  const as = tokenOrigin ? tokenOrigin + issuerPath : c.resourceAsIssuer;
  const targets = [
    { id: 'resource-as', label: 'Resource AS', url: as && `${as}/.well-known/oauth-authorization-server` },
    { id: 'pingfederate', label: 'PingFederate', url: c.pfUrl && `${c.pfUrl}/.well-known/openid-configuration` },
    { id: 'mcp', label: 'MCP server', url: c.mcpUrl && `${originOf(c.mcpUrl)}/.well-known/oauth-protected-resource` },
  ].filter((t) => t.url);
  const backends = await Promise.all(targets.map(async (t) => {
    const r = await probe(t.url, true);
    if (r.error || r.status !== 200 || !r.data) return { ...t, error: r.error || `HTTP ${r.status}` };
    return { ...t, data: r.data, profileFields: Object.fromEntries(PROFILE_FIELDS.map((f) => [f, Array.isArray(r.data[f]) && r.data[f].length > 0])) };
  }));
  res.json({ backends });
});

router.get('/events', async (_req, res) => {
  try {
    const base = originOf(config().resourceAsTokenEndpoint);
    if (!base) throw new Error('no resource AS configured');
    const r = await outboundFetch(`${base}/events`, { signal: AbortSignal.timeout(4000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    res.json({ available: true, events: (await r.json()).events });
  } catch (err) {
    res.json({ available: false, reason: `Could not read the resource AS's record (${err.message}).`, events: [] });
  }
});

export default router;
