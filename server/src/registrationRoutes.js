// Registration API.
//   POST /api/register                       anyone: ask for an account { email, password } -> 201 { id, status }
//   GET  /api/registrations                  admin: every request (never a password)
//   POST /api/registrations/:id/approve|reject   admin: approve creates the user in PingFederate

import express from 'express';
import { config } from './config.js';
import { requireAdmin, sameOrigin } from './auth/oidc.js';
import * as store from './registrations.js';
import { requireDefaultWorkspace } from './workspace.js';

const router = express.Router();
// Mounted at /api, so the middleware is scoped to this router's own paths and leaves every other /api route alone.
router.use(['/register', '/registrations'], express.json({ limit: '4kb' }));
router.use(['/register', '/registrations'], sameOrigin); // every write is same-origin only (CSRF)

const ERRORS = { 400: 'invalid_request', 404: 'not_found', 409: 'conflict', 429: 'rate_limited', 502: 'pingfederate_error', 503: 'not_configured' };
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!err.status) console.error(`[${config().slug}] registration error: ${err.message}`);
    res.status(err.status || 500).json({ error: ERRORS[err.status] || 'server_error', message: err.status ? err.message : 'Registration error' });
  }
};

// Requests per client address per hour. ponytail: in-process, per instance.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  for (const [k, t] of hits) if (now - t[0] > WINDOW_MS) hits.delete(k);
  const t = (hits.get(ip) || []).filter((x) => now - x < WINDOW_MS);
  if (t.length >= MAX_PER_WINDOW) return true;
  hits.set(ip, [...t, now]);
  return false;
}
export const resetRateLimit = () => hits.clear();

router.post('/register', requireDefaultWorkspace, handle(async (req, res) => {
  if (limited(req.ip)) throw Object.assign(new Error('Too many requests. Try again later.'), { status: 429 });
  const r = store.create(req.body || {});
  res.status(201).json({ id: r.id, status: r.status });
}));
router.get('/registrations', requireAdmin, (_req, res) => res.json({ registrations: store.list() }));
router.post('/registrations/:id/approve', requireDefaultWorkspace, requireAdmin, handle(async (req, res) => res.json(await store.approve(req.params.id, req.session.user.email))));
router.post('/registrations/:id/reject', requireDefaultWorkspace, requireAdmin, handle(async (req, res) => res.json(store.reject(req.params.id, req.session.user.email, req.body?.reason))));

export default router;
