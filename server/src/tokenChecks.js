// Token decoding and the draft-04 spec checks, shared by the playground (/api/id-jag-playground) and the
// Inspector (/api/inspect). Pure except the signature check, which a caller can inject.

export const SPEC = 'draft-ietf-oauth-identity-assertion-authz-grant';
export const OIDC_ONLY = new Set(['openid', 'profile', 'email', 'offline_access', 'phone', 'address']);
export const scopeList = (s) => String(s || '').split(/\s+/).filter(Boolean);
export const trimSlash = (u) => String(u).replace(/\/$/, ''); // resource-as treats <resource>/ as <resource>

/** Decode a compact JWT without verifying it, or null. */
export function decodeJwt(token) {
  try {
    const [h, p] = String(token).split('.');
    const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return { header: part(h), claims: part(p) };
  } catch {
    return null;
  }
}

/** Verify the ID-JAG signature against the IdP's JWKS. Returns { ok, note }. */
export async function verifySignature(idJag, h, s) {
  try {
    const { jwtVerify, createLocalJWKSet, importJWK } = await import('jose');
    const r = await fetch(s.idp.jwksUrl, { signal: AbortSignal.timeout(10000) });
    const data = await r.json();
    let key;
    if (h.x5t) {
      // PingFederate signs ID-JAGs with x5t and no kid: pick the key by x5t ourselves.
      const match = (data.keys || []).filter((k) => k.x5t === h.x5t && (!k.alg || k.alg === h.alg));
      // A static JWKS can list one cert under several kids: count distinct keys, not entries.
      const distinct = [...new Map(match.map((k) => [`${k.kty}.${k.n}.${k.e}.${k.x}.${k.y}`, k])).values()];
      if (distinct.length !== 1) throw new Error(`expected one JWKS key for x5t ${h.x5t}, found ${distinct.length}`);
      key = await importJWK(distinct[0], h.alg || 'RS256');
    } else {
      key = createLocalJWKSet(data);
    }
    await jwtVerify(idJag, key, { algorithms: [h.alg || 'RS256'], clockTolerance: 5 });
    return { ok: true, note: 'valid' };
  } catch (err) {
    return { ok: false, note: err.message };
  }
}

/** Spec checks on an ID-JAG. Pure except the injected signature check. */
export async function inspect(idJag, s, verify = verifySignature) {
  const d = decodeJwt(idJag) || { header: {}, claims: {} };
  const h = d.header || {};
  const c = d.claims || {};
  const now = Math.floor(Date.now() / 1000);
  const checks = [];
  const add = (id, label, ok, expected, actual, cite, warn = false) =>
    checks.push({ id, label, status: ok ? 'pass' : (warn ? 'warn' : 'fail'), expected, actual, cite });

  add('typ', 'Header typ', h.typ === 'oauth-id-jag+jwt', 'oauth-id-jag+jwt', h.typ, `${SPEC} §3.1 (MUST)`);
  add('alg', 'Signed, not alg:none', !!h.alg && h.alg !== 'none', 'RS256 (or another asymmetric alg)', h.alg, 'RFC 8725 §3.1');
  for (const k of ['iss', 'sub', 'aud', 'client_id', 'jti', 'exp', 'iat']) {
    add(`claim-${k}`, `Required claim ${k}`, c[k] !== undefined && c[k] !== '', 'present', c[k] === undefined ? '(missing)' : c[k], `${SPEC} §3.1 (REQUIRED)`);
  }
  add('iss', `Issuer is ${s.idp.name}`, c.iss === s.idp.issuer, s.idp.issuer, c.iss, 'RFC 7523 §3');
  const audOk = Array.isArray(c.aud) ? (c.aud.length === 1 && c.aud[0] === s.resourceAs.issuer) : c.aud === s.resourceAs.issuer;
  add('aud', 'Audience is the resource AS issuer (single value)', audOk, s.resourceAs.issuer, c.aud, `${SPEC} §4.4.1 (MUST)`);
  add('client_id', 'client_id is the client at the resource AS', c.client_id === s.resourceAs.clientId, s.resourceAs.clientId, c.client_id,
    `${SPEC} §4.4.1: client_id MUST identify the client authenticating at the resource AS (the IdP maps it)`);
  if (s.request.resource) {
    add('resource', 'Resource is the requested MCP resource', c.resource === undefined || trimSlash(c.resource) === trimSlash(s.request.resource), s.request.resource,
      c.resource === undefined ? '(not set)' : c.resource, 'RFC 8707 / MCP profile', c.resource === undefined);
  }
  add('exp', 'Not expired', typeof c.exp === 'number' && c.exp > now, `> ${now}`, c.exp, 'RFC 7519 §4.1.4');
  const life = typeof c.exp === 'number' && typeof c.iat === 'number' ? c.exp - c.iat : null;
  add('lifetime', 'Short-lived (5 minutes or less)', life !== null && life <= 300, '<= 300 s', life === null ? '?' : `${life} s`,
    'Okta / Auth0 / WorkOS issue 300 s ID-JAGs', true);
  const mcpScopes = scopeList(c.scope).filter((x) => !OIDC_ONLY.has(x));
  add('scope', 'Scope names MCP permissions, not just login scopes', mcpScopes.length > 0, 'the MCP scopes the IdP grants for this server',
    c.scope || '(none)', `${SPEC} §4.3: the IdP reflects the granted scope; OIDC-only scope grants nothing at the MCP server`);

  const sig = await verify(idJag, h, s);
  add('signature', `Signature verifies against ${s.idp.name} JWKS`, sig.ok, `valid against ${s.idp.jwksUrl}`, sig.note, 'RFC 7523 §3 item 9');
  return { header: h, claims: c, checks };
}
