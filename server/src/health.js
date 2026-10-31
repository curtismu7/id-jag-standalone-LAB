// GET /api/health, contract demo-health/1: the one public, coarse answer a launcher (the SE demo shelf) polls.
//   { schema:'demo-health/1', at, state:'ready'|'needs-setup'|'broken'|'unknown', runtime:'offline'|'live', demo:{id,name,version} }
// No counts, no message text, no secrets, no per-check detail: that stays on the admin-only /api/doctor.
// State comes from the doctor, run once at boot and refreshed in the background at most every 60 s with a hard
// timeout. A request never runs the doctor; before the first run finishes the answer is 'unknown'.
//   any doctor fail -> 'needs-setup'; doctor throws or times out -> 'unknown'; otherwise 'ready'.
//   'broken' is reserved for "the process itself cannot serve" and is not produced yet (a process that answers is not broken).
// PF admin: health makes no PF admin call of its own. The only path is runDoctor -> the active IdP adapter's doctor, which
// checks the PF admin failure latch (idp/pfAdmin.js) before any call: latched, it answers 'needs-setup' with no attempt.
// Otherwise the load is the doctor's one attempt per run, at most one run in flight (a run that outlives the timeout still
// counts as in flight), one per 60 s.
// Workspace: health describes the process, so the refresh always runs in the default workspace, whichever request
// (or none) is current; every workspace gets the same cached answer.

import fs from 'node:fs';
import express from 'express';
import { runDoctor } from './doctor.js';
import { DEFAULT_WORKSPACE, runInWorkspace } from './workspace.js';

const REFRESH_MS = 60_000;
const TIMEOUT_MS = 15_000;
const RATE_PER_MIN = 60;
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const DEMO = { id: 'id-jag', name: 'ID-JAG Standalone', version: pkg.version || '0.0.0' };

const val = (k) => String(process.env[k] ?? '').trim();
const pfAdminSet = () => Boolean(val('PF_ADMIN_URL') || val('PF_ADMIN_PASSWORD'));
/** Mock unless the environment points at a real PingFederate (HEALTH_MODE overrides: mock|pf-as|pf-pf|byo). */
export const healthMode = () => val('HEALTH_MODE') || (val('PF_EXCHANGE_CLIENT_ID') || pfAdminSet() ? 'pf-as' : 'mock');
export const runtimeOf = (mode = healthMode()) => (mode === 'mock' && !pfAdminSet() ? 'offline' : 'live');

let last = { state: 'unknown', at: null };
let inflight = null;
let running = false; // the underlying doctor run, which can outlive the timeout

/** One doctor run with a hard timeout; updates the cached state. Never rejects. */
export function refresh({ run = runDoctor, timeoutMs = TIMEOUT_MS } = {}) {
  if (inflight) return inflight;
  if (running) return Promise.resolve(); // a timed-out run is still going: do not stack another on top of it
  let timer;
  running = true;
  const work = Promise.resolve().then(() => runInWorkspace(DEFAULT_WORKSPACE, () => run({ mode: healthMode(), skip: ['port'] })));
  work.then(() => { running = false; }, () => { running = false; });
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); });
  inflight = Promise.race([work, timeout])
    .then((rep) => (rep?.checks?.some((c) => c.status === 'fail') ? 'needs-setup' : 'ready'), () => 'unknown')
    .then((state) => { last = { state, at: new Date().toISOString() }; })
    .finally(() => { clearTimeout(timer); inflight = null; });
  return inflight;
}

/** Run once now, then every 60 s. The timer is unref'd so it never keeps the process alive. */
export function startHealth(opts) {
  refresh(opts);
  setInterval(() => refresh(opts), REFRESH_MS).unref();
}
export const _resetHealth = () => { last = { state: 'unknown', at: null }; inflight = null; running = false; hits.clear(); };

const hits = new Map(); // ponytail: in-process, per instance
function limited(ip) {
  const now = Date.now();
  const t = (hits.get(ip) || []).filter((x) => now - x < 60_000);
  if (t.length >= RATE_PER_MIN) { hits.set(ip, t); return true; }
  hits.set(ip, [...t, now]);
  return false;
}

const router = express.Router();
router.all('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.set('Allow', 'GET').status(405).json({ error: 'method_not_allowed' });
  if (limited(req.ip)) return res.status(429).json({ error: 'rate_limited' });
  res.json({ schema: 'demo-health/1', at: last.at || new Date().toISOString(), state: last.state, runtime: runtimeOf(), demo: DEMO });
});
export default router;
