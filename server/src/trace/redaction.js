// Credential guard: returns a problem string when a value looks like a raw credential.
//
// What it catches: a JWT, a "Bearer <value>", a PEM header (every field); and, in
// free-text fields only, (a) a run of 32+ hex characters (hex-only secrets such as
// API keys or SHA digests; hex entropy is at most 4.0 bits so the entropy check below
// cannot see them) and (b) a run of 32+ base64/url characters that mixes letters and
// digits with entropy >= 4.2.
// What it does NOT catch: short secrets, low-entropy passwords, secrets split by
// separators, hex runs shorter than 32, secrets in non-free-text fields (trace_id,
// span_id, parent_span_id, ts and similar are validated by shape instead), and
// base64 secrets that are mostly letters or digits. It is a tripwire, not a scanner.
const JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const PEM = /-----BEGIN [A-Z0-9 ]+-----/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /[0-9a-f]{32,}/i;
const RUN = /[A-Za-z0-9+/_=-]{32,}/g;

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksRandom(run) {
  if (UUID.test(run)) return false;
  if (!/\d/.test(run) || !/[A-Za-z]/.test(run)) return false;
  return entropy(run) >= 4.2;
}

// freeText: also apply the hex-run and high-entropy checks (ids elsewhere are validated by shape).
export function credentialProblem(value, freeText = false) {
  if (typeof value !== 'string') return null;
  if (JWT.test(value)) return 'looks like a JWT';
  if (BEARER.test(value)) return 'looks like a Bearer credential';
  if (PEM.test(value)) return 'looks like a PEM block';
  if (freeText) {
    if (HEX.test(value)) return 'looks like a hex secret (32+ hex characters)';
    for (const run of value.match(RUN) || []) {
      if (looksRandom(run)) return 'looks like a high-entropy secret';
    }
  }
  return null;
}
