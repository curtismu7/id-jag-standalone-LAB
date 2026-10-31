// App sign-in: OIDC authorization code + PKCE + state + nonce against OIDC_ISSUER (PingFederate,
// which federates to PingOne). The ID token is validated with jose, then the email rules run on its
// claims. The session is regenerated on login. When the sign-in happened at PF_URL with the pf-as
// exchange client (the defaults), its refresh token also fills the pf-as issuer session that
// issuerSession.js reads, so one sign-in serves both. Routes: /auth/callback, /auth/logout, /api/me.

import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import * as jose from 'jose';
import { config } from '../config.js';
import { isMock, runtimeEnv } from '../mode.js';
import { outboundFetch } from '../outbound.js';
import { allowedDomains, checkEmail } from './emailRules.js';

const BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access'];
const LOGIN_TTL_MS = 10 * 60 * 1000;
const env = (k) => String(runtimeEnv()[k] ?? '').trim();
const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

// Defaults to the pf-as issuer settings: one PingFederate client signs users in and runs the exchange.
export function oidcConfig() {
  const c = config();
  const ownClient = env('OIDC_CLIENT_ID');
  return {
    issuer: env('OIDC_ISSUER') || c.pfUrl,
    clientId: ownClient || c.pfExchangeClientId,
    clientSecret: env('OIDC_CLIENT_SECRET') || (ownClient ? '' : env('PF_EXCHANGE_CLIENT_SECRET')),
    privateKey: env('OIDC_PRIVATE_KEY_JWT'), // PEM (\n escapes allowed) or a path to a PEM file
    privateKeyKid: env('OIDC_PRIVATE_KEY_KID'),
    redirectUri: env('OIDC_REDIRECT_URI') || `${c.appOrigin}/auth/callback`,
    scope: [...new Set([...BASE_SCOPES, ...env('OIDC_EXTRA_SCOPES').split(/\s+/).filter(Boolean)])].join(' '),
    adminClaim: env('ADMIN_CLAIM') || 'groups',
    adminClaimValue: c.adminGroup,
    adminEmails: env('ADMIN_EMAILS').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
  };
}

export const missingConfig = (c) => [
  !c.issuer && 'OIDC_ISSUER (or PF_URL)', !c.clientId && 'OIDC_CLIENT_ID (or PF_EXCHANGE_CLIENT_ID)',
  !c.clientSecret && !c.privateKey && 'OIDC_CLIENT_SECRET (or OIDC_PRIVATE_KEY_JWT, or PF_EXCHANGE_CLIENT_SECRET)',
].filter(Boolean);

// Mock mode: the keys are read through the netguard (jose's own remote JWKS would open a socket), fresh on every check.
const mockJwks = (url) => async (header, token) => jose.createLocalJWKSet(await (await outboundFetch(url)).json())(header, token);

// Provider metadata + its JWKS, per issuer. A failed discovery is retried on the next login.
const discovered = new Map();
export function discover(issuer) {
  if (!discovered.has(issuer)) {
    const p = (async () => {
      const r = await outboundFetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`discovery answered HTTP ${r.status}`);
      const meta = await r.json();
      if (meta.issuer !== issuer) throw new Error(`discovery names issuer ${meta.issuer}, not ${issuer}`);
      return { ...meta, jwks: isMock() ? mockJwks(meta.jwks_uri) : jose.createRemoteJWKSet(new URL(meta.jwks_uri)) };
    })();
    p.catch(() => discovered.delete(issuer));
    discovered.set(issuer, p);
  }
  return discovered.get(issuer);
}

async function clientAssertion(c, audience) {
  const pem = c.privateKey.startsWith('-----BEGIN') ? c.privateKey.replace(/\\n/g, '\n') : fs.readFileSync(c.privateKey, 'utf8');
  const key = crypto.createPrivateKey(pem);
  return new jose.SignJWT({})
    .setProtectedHeader({ alg: key.asymmetricKeyType === 'ec' ? 'ES256' : 'RS256', ...(c.privateKeyKid ? { kid: c.privateKeyKid } : {}) })
    .setIssuer(c.clientId).setSubject(c.clientId).setAudience(audience)
    .setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime('60s')
    .sign(key);
}

async function redeemCode(c, meta, code, verifier) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: c.redirectUri, code_verifier: verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (c.privateKey) {
    form.set('client_id', c.clientId);
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    form.set('client_assertion', await clientAssertion(c, meta.token_endpoint));
  } else {
    headers.Authorization = `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`;
  }
  const r = await outboundFetch(meta.token_endpoint, { method: 'POST', headers, body: form.toString(), signal: AbortSignal.timeout(10000) });
  const data = await r.json().catch(() => ({}));
  if (r.status !== 200 || typeof data.id_token !== 'string') throw new Error(`token endpoint answered HTTP ${r.status} ${data.error || ''}`.trim());
  return data;
}

async function validateIdToken(c, meta, idToken, nonce) {
  const { payload } = await jose.jwtVerify(idToken, meta.jwks, { issuer: c.issuer, audience: c.clientId, clockTolerance: 5 });
  if (payload.nonce !== nonce) throw new Error('nonce mismatch');
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== c.clientId) throw new Error('azp mismatch');
  if (!payload.sub) throw new Error('no sub');
  return payload;
}

function isAdmin(c, claims) {
  const v = claims[c.adminClaim];
  const values = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return values.includes(c.adminClaimValue) || c.adminEmails.includes(claims.email.toLowerCase());
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Branded, self-contained HTML page for refusals and errors. Never shows token contents. */
function page(res, status, title, message) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'",
  }).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - ID-JAG Kit</title><style>
body{margin:0;font-family:Montserrat,"Helvetica Neue",Helvetica,Arial,sans-serif;background:#f4f5f7;color:#051727;line-height:1.5}
header{display:flex;align-items:center;gap:.6rem;padding:.65rem 1.25rem;background:#051727;color:#fff;font-weight:700;border-bottom:3px solid #d20e0f}
header img{width:1.9rem;height:1.9rem}main{max-width:640px;margin:3rem auto;padding:1.5rem;background:#fff;border:1px solid #d9dde3;border-top:4px solid #d20e0f;border-radius:10px}
h1{margin-top:0;font-size:1.4rem}a{color:#aa0005;font-weight:600}
</style></head><body><header><img src="/branding/ping-logo.png" alt="Ping Identity"><span>ID-JAG Kit</span></header>
<main><h1>${esc(title)}</h1><p>${esc(message)}</p>
<p><a href="/">Back to the playground</a></p></main></body></html>`);
}

/** Only a same-origin relative path: no //host, no /\host, no scheme, printable ASCII. */
const safeReturnTo = (p) => (typeof p === 'string' && /^\/(?![/\\])[!-~]*$/.test(p) ? p : '/');

export const sameOrigin = (req, res, next) => (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== config().appOrigin
  ? res.status(403).json({ error: 'invalid_origin' }) : next());
export const requireUser = (req, res, next) => (req.session?.user?.email ? next() : res.status(401).json({ error: 'sign_in_required' }));
export const requireAdmin = (req, res, next) => {
  if (!req.session?.user?.email) return res.status(401).json({ error: 'sign_in_required' });
  return req.session.user.isAdmin === true ? next() : res.status(403).json({ error: 'admin_required' });
};

/** The pending login state (kept in the session) and the authorize URL for it. Shared with the pi.flow driver. */
export function authorizeRequest(c, meta, returnTo) {
  const login = { state: rand(), nonce: rand(), verifier: rand(32), returnTo: safeReturnTo(returnTo), at: Date.now() };
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, scope: c.scope,
    state: login.state, nonce: login.nonce,
    code_challenge: crypto.createHash('sha256').update(login.verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  return { login, url };
}

const router = express.Router();

router.get('/auth/callback', async (req, res) => {
  const pending = req.session?.oidcLogin;
  if (req.session) { delete req.session.oidcLogin; delete req.session.user; }
  const failed = (why) => {
    console.warn(`[${config().slug}] sign-in failed: ${why}`);
    return page(res, 400, 'Sign-in failed', 'The sign-in could not be completed. Start again from the Sign in button.');
  };
  if (typeof req.query.error === 'string') {
    return page(res, 400, 'Sign-in failed', `The sign-in server refused the request (${req.query.error.slice(0, 64)}).`);
  }
  if (!pending || typeof req.query.code !== 'string' || req.query.state !== pending.state || Date.now() - pending.at > LOGIN_TTL_MS) {
    return failed('invalid or expired state');
  }
  const c = oidcConfig();
  let tokens;
  let claims;
  try {
    const meta = await discover(c.issuer);
    tokens = await redeemCode(c, meta, req.query.code, pending.verifier);
    claims = await validateIdToken(c, meta, tokens.id_token, pending.nonce);
  } catch (err) {
    return failed(err.code || err.message); // jose messages name the failed check, never the token
  }
  const refusal = checkEmail(claims, allowedDomains());
  if (refusal) {
    console.warn(`[${config().slug}] sign-in refused: ${refusal.rule}`);
    return page(res, 403, 'You cannot sign in to this app', refusal.message);
  }
  const user = { sub: claims.sub, email: claims.email.toLowerCase(), name: String(claims.name || claims.email), isAdmin: isAdmin(c, claims) };
  return req.session.regenerate((err) => {
    if (err) return failed('session regenerate failed');
    req.session.user = user;
    // The pf-as issuer session (issuerSession.js), when this sign-in was at PF_URL with the pf-as exchange
    // client: a refresh token is bound to the client it was issued to, so no other sign-in qualifies.
    const pc = config();
    if (typeof tokens.refresh_token === 'string' && c.issuer.replace(/\/$/, '') === pc.pfUrl && c.clientId === pc.pfExchangeClientId) {
      req.session.idJagIssuer = { mode: 'pf-as', refreshToken: tokens.refresh_token, sub: claims.sub };
    }
    return req.session.save(() => res.redirect(pending.returnTo));
  });
});

router.post('/auth/logout', sameOrigin, (req, res) => {
  const done = () => { res.clearCookie(`${config().slug}.sid`); res.redirect(303, '/'); };
  return req.session ? req.session.destroy(done) : done();
});

router.get('/api/me', (req, res) => {
  const u = req.session?.user;
  return u ? res.json({ email: u.email, name: u.name, isAdmin: u.isAdmin === true }) : res.status(401).json({ error: 'not_signed_in' });
});

export default router;
