// No imports on purpose: scripts/setup-pf-local.mjs runs this check before the app's settings exist.

/**
 * The issuer PingFederate's /pf/JWKS must be fit for ID-JAG verification: PingFederate signs ID-JAGs with an x5t header and
 * no kid, so a verifier picks the key by x5t. No RSA key with x5t = nothing can verify (fail); more than one distinct RSA key
 * = PingFederate's own JWT-bearer consumer may pick the wrong one (warn). A key listed under several kids counts once.
 * `pickedByX5t`: the verifier is the resource AS (pf-as), which picks the key by the ID-JAG's x5t (a thumbprint, unique per key),
 * so extra keys are harmless and only "no key with x5t" is a problem.
 */
export function issuerKeyCheck(keys, { pickedByX5t = false } = {}) {
  const rsa = [...new Map((Array.isArray(keys) ? keys : []).filter((k) => k?.kty === 'RSA').map((k) => [`${k.n}.${k.e}`, k])).values()];
  const withX5t = rsa.filter((k) => k.x5t).length;
  const status = withX5t === 0 ? 'fail' : rsa.length > 1 && !pickedByX5t ? 'warn' : 'pass';
  return { status, rsa: rsa.length, withX5t };
}
