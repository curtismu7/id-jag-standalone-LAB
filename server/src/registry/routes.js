// Trusted-IdP registry API, mounted at /api/id-jag-playground/trusted-idps (the paths the resource AS
// and the PingFederate sync script already read).
//
//   GET  /registry, /pingfederate   server-to-server, Bearer ID_JAG_REGISTRY_TOKEN; approved entries only
//   GET  /                          anyone: approved entries (public view)
//   GET  /mine                      signed in: my entries, any status
//   POST /, PUT /:id, DELETE /:id   signed in: register (pending), edit, withdraw (owner or admin)
//   POST /discover, /test           signed in: issuer discovery, "Test this IdP"
//   POST /:id/secret                owner: a fresh resource AS client secret, shown once
//   GET  /all, /audit               admin
//   POST /:id/approve|reject|disable admin

import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { runtimeEnv } from '../mode.js';
import { requireAdmin, requireUser, sameOrigin } from '../auth/oidc.js';
import { withPfAsIssuer } from '../idJagPlayground.js';
import * as store from '../trustedIdps.js';
import * as audit from './audit.js';
import { discover, testIdp } from './net.js';

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(sameOrigin); // every write is same-origin only (CSRF)

/** Server-to-server reads carry no session: they need the shared ID_JAG_REGISTRY_TOKEN. Unset = refuse (503). */
function registryAuth(req, res, next) {
  const expected = runtimeEnv().ID_JAG_REGISTRY_TOKEN;
  if (!expected) {
    console.error(`[${config().slug}] ID_JAG_REGISTRY_TOKEN is not set; refusing trusted-IdP registry reads`);
    return res.status(503).json({ error: 'registry_auth_unconfigured' });
  }
  const got = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')?.[1] || '';
  const digest = (v) => crypto.createHash('sha256').update(v).digest(); // equal lengths for timingSafeEqual
  return crypto.timingSafeEqual(digest(got), digest(expected)) ? next() : res.status(401).json({ error: 'unauthorized' });
}

const ERRORS = { 400: 'invalid_request', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'discovery_failed', 502: 'fetch_failed' };
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res, req.session.user);
  } catch (err) {
    if (!err.status) console.error(`[${config().slug}] registry error: ${err.message}`);
    res.status(err.status || 500).json({ error: ERRORS[err.status] || 'server_error', message: err.status ? err.message : 'Registry error' });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });

/** The entry, if the user owns it (or, unless ownerOnly, is an admin). */
function ownEntry(id, user, { ownerOnly = false } = {}) {
  const e = store.get(id);
  if (!e) throw fail(404, `no trusted IdP "${id}"`);
  if (e.owner !== user.email && (ownerOnly || !user.isAdmin)) throw fail(403, ownerOnly ? 'only the owner may do this' : 'only the owner or an admin may change this IdP');
  return e;
}

router.get('/registry', registryAuth, (_req, res) => res.json(withPfAsIssuer(store.resourceAsRegistry())));
router.get('/pingfederate', registryAuth, (_req, res) => res.json(store.pingfederateRegistry()));
// canManage stays false: the playground panel is read-only; registration lives on the Trusted IdPs page.
router.get('/', (_req, res) => res.json({ idps: store.trusted().map(store.publicView), canManage: false }));
router.get('/mine', requireUser, (req, res) => res.json({ idps: store.list().filter((e) => e.owner === req.session.user.email) }));
router.get('/all', requireAdmin, (_req, res) => res.json({ idps: store.list() }));
router.get('/audit', requireAdmin, (req, res) => res.json(audit.page(req.query)));

router.post('/discover', requireUser, handle(async (req, res) => res.json(await discover(req.body?.issuer))));
router.post('/test', requireUser, handle(async (req, res) => res.json(await testIdp(req.body || {}))));

router.post('/', requireUser, handle(async (req, res, user) => res.status(201).json(await store.create(req.body, user.email))));
router.put('/:id', requireUser, handle(async (req, res, user) => {
  ownEntry(req.params.id, user);
  res.json(await store.update(req.params.id, req.body, user.email));
}));
router.delete('/:id', requireUser, handle(async (req, res, user) => {
  const e = ownEntry(req.params.id, user);
  await store.remove(e.id, user.email, e.owner === user.email ? 'withdraw' : 'delete');
  res.status(204).end();
}));
router.post('/:id/secret', requireUser, handle(async (req, res, user) => {
  ownEntry(req.params.id, user, { ownerOnly: true });
  res.set('Cache-Control', 'no-store').json(await store.rotateSecret(req.params.id, user.email));
}));
for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected'], ['disable', 'disabled']]) {
  router.post(`/:id/${action}`, requireAdmin, handle(async (req, res, user) => res.json(await store.setStatus(req.params.id, status, user.email, req.body?.reason, req.body?.updatedAt))));
}

router.use((_req, res) => res.status(404).json({ error: 'not_found' }));

export default router;
