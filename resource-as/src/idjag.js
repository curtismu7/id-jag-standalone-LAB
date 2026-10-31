// ID-JAG verification (draft-ietf-oauth-identity-assertion-authz-grant).
//
// The assertion IS the authorization: anything unverified here is
// attacker-authored. Every check fails closed, and RS256 is pinned so an
// unsigned (alg:none) or symmetric assertion cannot be negotiated.
import fs from 'node:fs';
import * as jose from 'jose';

export const ID_JAG_TYP = 'oauth-id-jag+jwt';
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
export const ID_JAG_GRANT_PROFILE = 'urn:ietf:params:oauth:grant-profile:id-jag';
const CLOCK_TOLERANCE_S = 5;

export class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

/**
 * Verify an ID-JAG from `idp` for redemption by `clientId` and return its
 * claims. Throws OAuthError. Does NOT consume the jti: the caller does that
 * last, so a refused request never burns a still-valid assertion.
 */
export async function verifyIdJag(assertion, { idp, ownIssuer, acceptedResources, clientId, getKey }) {
  let payload;
  try {
    ({ payload } = await jose.jwtVerify(assertion, getKey, {
      algorithms: ['RS256'],
      typ: ID_JAG_TYP,
      issuer: idp.issuer,
      audience: ownIssuer,
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ['iss', 'sub', 'aud', 'client_id', 'jti', 'exp', 'iat'],
    }));
  } catch (err) {
    throw new OAuthError('invalid_grant', `ID-JAG verification failed: ${err.message}`);
  }

  if (Array.isArray(payload.aud) && payload.aud.length !== 1) {
    throw new OAuthError('invalid_grant', 'ID-JAG aud must name exactly one authorization server');
  }
  // The configured spelling wins (it becomes the access token aud); a trailing slash is ignored (xaa.dev adds one).
  const resource = acceptedResources.find((r) => typeof payload.resource === 'string' && trimSlash(r) === trimSlash(payload.resource));
  if (!resource) {
    throw new OAuthError('invalid_target', `ID-JAG resource "${payload.resource}" is not served by this authorization server`);
  }
  // Strict binding: client_id must be one of this IdP's clientAliases keys and map to the redeeming
  // client. The IdP may write its own id for us (PingFederate uses the client the user's refresh
  // token belongs to); an id that is not listed is refused even if it equals the redeeming client.
  // Alias values are strings, so an inherited key (e.g. "constructor") never equals clientId.
  if (typeof payload.client_id !== 'string' || idp.clientAliases[payload.client_id] !== clientId) {
    throw new OAuthError('invalid_grant', 'ID-JAG client_id is not assigned to this IdP');
  }
  return { ...payload, resource };
}

/** `https://x/mcp/` and `https://x/mcp` name the same resource. */
export const trimSlash = (u) => String(u).replace(/\/$/, '');

/**
 * Single-use jti cache, keyed by issuer + jti, entries kept until the
 * assertion's exp (+ clock tolerance). With `file`, it survives a restart.
 */
// ponytail: one process only; several replicas need a shared store.
export function createReplayStore(file) {
  const seen = new Map(file && fs.existsSync(file) ? Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))) : []);
  return {
    /** True on first use; false if this jti was already redeemed. */
    consume(iss, jti, exp) {
      const now = Date.now() / 1000;
      for (const [key, until] of seen) if (until < now) seen.delete(key);
      const key = `${iss} ${jti}`;
      if (seen.has(key)) return false;
      seen.set(key, exp + CLOCK_TOLERANCE_S);
      if (file) fs.writeFileSync(file, JSON.stringify(Object.fromEntries(seen)), { mode: 0o600 });
      return true;
    },
  };
}
