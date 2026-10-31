/**
 * Interop panel: mint an ID-JAG at the kit's PingFederate addressed to OTHER people's resource authorization servers
 * and redeem it there, so the recorded results in docs/interop-lab.md can be re-checked from the playground.
 *
 * Needs, per target, the SP connection made by pingfederate/configure-interop-targets.js (a missing one shows up as
 * the PingFederate error). Client credentials come from env by name and are never sent to the browser. Nothing is
 * registered at a public sandbox from here: xaa.dev's client is registered by hand (docs/interop-lab.md).
 */
import { secret } from './config.js';

const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
// The kid workaround's client (pingfederate/configure-kid-workaround.js writes both to .env).
const KID_CLIENT = ['INTEROP_KID_CLIENT_ID', 'INTEROP_KID_CLIENT_SECRET'];

/** `recorded` is what docs/interop-lab.md says (2026-10-19); the Run button shows what happens now. */
export const TARGETS = [
  {
    id: 'authplane', name: 'Authplane (local container)', audience: () => process.env.INTEROP_AUTHPLANE_ISSUER || 'http://localhost:9100',
    resource: 'https://rs.example.com/mcp', scope: 'read',
    tokenEndpoint: () => process.env.INTEROP_AUTHPLANE_TOKEN_ENDPOINT || 'http://localhost:9100/oauth/token', auth: 'basic',
    redeemCred: ['INTEROP_AUTHPLANE_CLIENT_ID', 'INTEROP_AUTHPLANE_CLIENT_SECRET'], env: ['INTEROP_AUTHPLANE_CLIENT_ID', 'INTEROP_AUTHPLANE_CLIENT_SECRET'],
    recorded: { result: 'accepts', note: 'Verifies the PingFederate ID-JAG against its JWKS and issues an access token.' },
  },
  {
    id: 'xaa-dev', name: 'xaa.dev hosted resource AS', audience: () => 'https://auth.resource.xaa.dev', resource: 'https://api.resource.xaa.dev', scope: 'todos.read',
    tokenEndpoint: () => 'https://auth.resource.xaa.dev/token', auth: 'basic',
    redeemCred: ['INTEROP_XAA_CLIENT_ID', 'INTEROP_XAA_CLIENT_SECRET'], env: ['INTEROP_XAA_CLIENT_ID', 'INTEROP_XAA_CLIENT_SECRET'],
    recorded: { result: 'refuses', note: 'invalid_grant: JWT signature is invalid. Proven cause: the ID-JAG header has no kid (docs/interop-lab.md).' },
  },
  {
    id: 'motd', name: 'motd.xaa.rocks', audience: () => 'https://motd.xaa.rocks/', resource: 'https://motd.xaa.rocks/mcp', scope: 'mcp',
    tokenEndpoint: () => 'https://motd.xaa.rocks/token', auth: 'none', env: [],
    recorded: { result: 'refuses', note: "invalid_grant: the JWT header is missing the 'kid' property." },
  },
  // The same two targets through the workaround: a token exchange answered by a JWT access token manager that adds kid.
  // Not a native ID-JAG (the issued token type is an access token); see docs/interop-lab.md.
  {
    id: 'xaa-dev-kid', method: 'kid', name: 'xaa.dev hosted resource AS', audience: () => 'https://auth.resource.xaa.dev', resource: 'https://api.resource.xaa.dev', scope: 'todos.read',
    tokenEndpoint: () => 'https://auth.resource.xaa.dev/token', auth: 'basic',
    redeemCred: ['INTEROP_XAA_CLIENT_ID', 'INTEROP_XAA_CLIENT_SECRET'], env: ['INTEROP_XAA_CLIENT_ID', 'INTEROP_XAA_CLIENT_SECRET', ...KID_CLIENT],
    recorded: { result: 'accepts', note: 'HTTP 200 with kid in the header (2026-10-19).' },
  },
  {
    id: 'motd-kid', method: 'kid', name: 'motd.xaa.rocks', audience: () => 'https://motd.xaa.rocks/', resource: 'https://motd.xaa.rocks/mcp', scope: 'mcp',
    tokenEndpoint: () => 'https://motd.xaa.rocks/token', auth: 'none', env: [...KID_CLIENT],
    recorded: { result: 'accepts', note: 'HTTP 200 with kid in the header (2026-10-19).' },
  },
];

const missingEnv = (t) => t.env.filter((k) => !secret(k));

export const listTargets = () => TARGETS.map((t) => ({
  id: t.id, name: t.name, method: t.method || 'native', audience: t.audience(), resource: t.resource, scope: t.scope,
  recorded: t.recorded, missing: missingEnv(t),
}));

/** What a person needs to see about a header without the token: is kid / x5t there, and which typ. */
const headerFacts = (h) => ({ typ: h?.typ, alg: h?.alg, kid: Boolean(h?.kid), x5t: Boolean(h?.x5t) });

/**
 * `h` carries the playground's own helpers, so the exchange is the same one the playground does (same client,
 * same signed-in session) with only audience / resource / scope swapped.
 */
export function mountInterop(router, h) {
  router.get('/interop', (_req, res) => res.json({ targets: listTargets() }));

  router.post('/interop/:id/run', h.requireReal, async (req, res) => {
    const t = TARGETS.find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'unknown_target' });
    if (h.modeOf(req) !== 'pf-as') {
      return res.status(409).json({ error: 'pf_as_only', message: 'Interop runs use the PingFederate sign-in: switch to "PingFederate to resource AS".' });
    }
    const missing = missingEnv(t);
    if (missing.length) return res.status(501).json({ error: 'not_configured', missing });

    const kid = t.method === 'kid';
    let { s, auth, body } = h.exchangeRequest(req, t.scope);
    if (kid) {
      // Same signed-in session (subject token), answered by the lab client's JWT access token manager; no scope sent.
      body = new URLSearchParams({ grant_type: body.get('grant_type'), subject_token: body.get('subject_token'), subject_token_type: body.get('subject_token_type'), requested_token_type: ACCESS_TOKEN });
      auth = { Authorization: h.basic(secret(KID_CLIENT[0]), secret(KID_CLIENT[1])) };
    }
    body.set('audience', t.audience());
    body.set('resource', t.resource);
    const mint = await h.postForm(s.idp.tokenEndpoint, body, auth).catch((e) => ({ status: 0, data: { error: 'unreachable', error_description: e.message } }));
    if (mint.status !== 200 || !mint.data?.access_token) {
      return res.json({ target: t.id, mint: { status: mint.status, error: mint.data?.error, error_description: mint.data?.error_description,
        hint: kid ? 'Is the workaround set up? node pingfederate/configure-kid-workaround.js' : 'Is the target\'s SP connection there? node pingfederate/configure-interop-targets.js' } });
    }
    const d = h.decodeJwt(mint.data.access_token);
    const form = new URLSearchParams({ grant_type: JWT_BEARER, assertion: mint.data.access_token, resource: t.resource, scope: t.scope });
    let headers = {};
    if (t.auth === 'basic') headers = { Authorization: h.basic(secret(t.redeemCred[0]), secret(t.redeemCred[1])) };
    else form.set('client_id', kid ? secret(KID_CLIENT[0]) : s.idp.exchangeClientId);
    const redeem = await h.postForm(t.tokenEndpoint(), form, headers).catch((e) => ({ status: 0, data: { error: 'unreachable', error_description: e.message } }));
    return res.json({
      target: t.id, method: t.method || 'native',
      mint: { status: 200, header: headerFacts(d?.header), claims: { iss: d?.claims?.iss, aud: d?.claims?.aud, client_id: d?.claims?.client_id } },
      redeem: { status: redeem.status, accepted: redeem.status === 200 && Boolean(redeem.data?.access_token), error: redeem.data?.error, error_description: redeem.data?.error_description },
    });
  });
}
