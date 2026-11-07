// Sign-in without a redirect: the server drives PingFederate's pi.flow Authentication API (username +
// password only) so the web can show the form in a modal. One driver serves the app sign-in (below) and
// the playground's issuer sign-in (idJagPlayground.js); each passes a descriptor:
//   { kind, key, redirectUri(), prepare(req) -> { fail: [status, body] } | { login, url } }
// `login` is the pending state /auth/callback or /issuer/callback checks, stored under session[key].
// On COMPLETED the browser is sent to redirectUri?code&state and that existing callback finishes the
// sign-in unchanged. Anything the driver cannot finish answers an error the web modal shows; there is no redirect login.
// Routes: /auth/pi-flow/start, /auth/pi-flow/credentials.

import express from 'express';
import { config } from '../config.js';
import { mockSigninProblem } from '../mockSignin.js';
import { outboundFetch } from '../outbound.js';
import { requestBase } from '../requestOrigin.js';
import { authorizeRequest, discover, missingConfig, oidcConfig, sameOrigin } from './oidc.js';

const FLOW_ID = /^[A-Za-z0-9_-]{6,64}$/;
const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const MAX_FIELD = 256;

// Attempts per flow id, checked and bumped synchronously: parallel requests each hold their own copy of the
// session, so the session's count alone cannot cap them. ponytail: in-process, so per instance; share it if the server scales out.
const tries = new Map(); // flowId -> { n, at }
const tried = (id) => tries.get(id)?.n || 0;

const saveThen = (req, res, status, body) => req.session.save(() => res.status(status).json(body));

// ponytail: cookie jar keeps name=value only (no Path/Expires handling); the flow needs just PF's session cookies.
function mergeCookies(jar, r) {
  for (const line of r.headers?.getSetCookie?.() || []) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

export function piFlowHandlers({ kind, key, redirectUri, prepare }) {
  async function start(req, res) {
    const p = await prepare(req);
    if (p.fail) return res.status(p.fail[0]).json(p.fail[1]);
    p.url.searchParams.set('response_mode', 'pi.flow');
    req.session[key] = p.login;
    // The cap is per session per TTL window: a restart inside the window keeps the count.
    const prev = req.session.piFlow;
    const attempts = prev?.kind === kind && Date.now() - prev.startedAt <= FLOW_TTL_MS ? Math.max(prev.attempts, tried(prev.flowId)) : 0;
    if (prev) tries.delete(prev.flowId);
    for (const [id, t] of tries) if (Date.now() - t.at > FLOW_TTL_MS) tries.delete(id);
    delete req.session.piFlow;
    let body;
    const jar = {};
    try {
      const r = await outboundFetch(p.url.toString(), { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      mergeCookies(jar, r);
      const data = r.status === 200 ? await r.json().catch(() => null) : null;
      if (typeof data?.id === 'string' && FLOW_ID.test(data.id) && data.status === 'USERNAME_PASSWORD_REQUIRED') body = data;
    } catch { /* unreachable: same answer as a refused flow */ }
    if (!body) {
      delete req.session[key];
      return saveThen(req, res, 502, { error: 'pi_flow_unavailable' });
    }
    tries.set(body.id, { n: attempts, at: Date.now() });
    req.session.piFlow = { kind, flowId: body.id, cookies: jar, startedAt: Date.now(), origin: p.url.origin, attempts };
    return saveThen(req, res, 200, { flowId: body.id, status: body.status });
  }

  async function credentials(req, res) {
    const { username, password } = req.body || {};
    const ok = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD;
    if (!ok(username) || !ok(password)) return res.status(400).json({ error: 'invalid_request' });
    const f = req.session?.piFlow;
    const login = req.session?.[key];
    if (!f || f.kind !== kind || !login || Date.now() - f.startedAt > FLOW_TTL_MS) return res.status(409).json({ error: 'pi_flow_not_started' });
    const n = Math.max(f.attempts, tried(f.flowId));
    if (n >= MAX_ATTEMPTS) return saveThen(req, res, 429, { error: 'too_many_attempts' });
    f.attempts = n + 1;
    tries.set(f.flowId, { n: n + 1, at: f.startedAt });
    // Persist the count before the slow PingFederate call so a later request in this session sees it.
    await new Promise((resolve) => req.session.save(resolve));
    const end = (status, body) => { tries.delete(f.flowId); delete req.session.piFlow; delete req.session[key]; return saveThen(req, res, status, body); };
    let r;
    let data;
    try {
      r = await outboundFetch(`${f.origin}/pf-ws/authn/flows/${f.flowId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.pingidentity.checkUsernamePassword+json', Accept: 'application/json',
          'X-XSRF-Header': 'PingFederate', Cookie: cookieHeader(f.cookies),
        },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(10000),
      });
      mergeCookies(f.cookies, r);
      data = await r.json().catch(() => ({}));
    } catch (err) {
      console.warn(`[${config().slug}] pi.flow credentials failed: ${err.name}`);
      return end(502, { error: 'pi_flow_failed' });
    }
    if (r.status === 400 && Array.isArray(data?.details) && data.details.some((d) => d?.code === 'CREDENTIAL_VALIDATION_FAILED')) {
      return saveThen(req, res, 401, { error: 'invalid_credentials', message: 'Username or password is incorrect.' });
    }
    if (!r.ok) {
      console.warn(`[${config().slug}] pi.flow credentials answered HTTP ${r.status}`);
      return end(502, { error: 'pi_flow_failed' });
    }
    if (data?.status === 'COMPLETED') {
      const a = data.authorizeResponse;
      if (typeof a?.code !== 'string' || a.state !== login.state) {
        console.warn(`[${config().slug}] pi.flow completed with a missing code or a state mismatch`);
        return end(502, { error: 'pi_flow_failed' });
      }
      const to = new URL(redirectUri(req));
      to.searchParams.set('code', a.code);
      to.searchParams.set('state', a.state);
      tries.delete(f.flowId);
      delete req.session.piFlow;
      return saveThen(req, res, 200, { redirectTo: to.toString() });
    }
    return end(200, { fallback: true, status: String(data?.status || '').slice(0, 64) });
  }

  return { start, credentials };
}

export const appHandlers = piFlowHandlers({
  kind: 'app',
  key: 'oidcLogin',
  redirectUri: (req) => oidcConfig().redirectUri || `${requestBase(req)}/auth/callback`,
  async prepare(req) {
    const blocked = mockSigninProblem(req);
    if (blocked) return { fail: [blocked.status, { error: blocked.error, message: blocked.message }] };
    const c = oidcConfig();
    if (missingConfig(c).length) return { fail: [503, { error: 'not_configured' }] };
    if (c.issuer.replace(/\/$/, '') !== config().pfUrl) return { fail: [409, { error: 'pi_flow_unavailable' }] };
    let meta;
    try {
      meta = await discover(c.issuer);
    } catch (err) {
      console.warn(`[${config().slug}] OIDC discovery failed: ${err.message}`);
      return { fail: [502, { error: 'pi_flow_unavailable' }] };
    }
    return authorizeRequest(c, meta, req.query.return_to, req);
  },
});

const router = express.Router();
router.get('/auth/pi-flow/start', appHandlers.start);
router.post('/auth/pi-flow/credentials', sameOrigin, express.json(), appHandlers.credentials);

export default router;
