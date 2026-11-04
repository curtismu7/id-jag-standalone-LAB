// /api/id-jag-playground/aws-agentcore: the spec of the runner, its scenarios, and a run. Mock only: in Live mode every
// route but GET /state answers 409 live_unavailable.
//   GET  /state          the spec (write-only fields masked), the scenarios, the cast, where each claim comes from
//   PUT  /spec           edit the spec ({ Exchange: {...}, Redeem: {...} }); a secret field is replaced, kept (omitted or empty) or cleared (null)
//   POST /spec/reset     the spec back to the defaults
//   POST /run            { scenario } run one scenario through the mock chain and return the legs, the controls and the trace
//   POST /reset          spec, used assertions and the mock servers' logs back to the start (this workspace)
// Writes are same-origin only (the playground router checks Origin). Nothing leaves this process: the mock hosts are .invalid.
// ClientSecret is write-only: every answer goes through scrub(), which removes any stored or just-typed value.

import express from 'express';
import { CALLER_CLIENT_ID, CALLER_USER, CLAIMS, FIELD_PATHS, LIVE_UNAVAILABLE, SCENARIOS, WRITE_ONLY, AUTH_METHODS, TOKEN_TYPES, API_AUDIENCE, SCOPES,
  applyPatch, getSpec, maskSpec, resetAgentCore, runScenario, scenarioList, scrub, secretsIn, setSpec } from './agentcoreRedeem.js';
import { isMock } from './mode.js';
import { agentCoreWorld } from './mock/index.js';
import { ORIGINS } from './mock/env.js';
import { currentWorkspace } from './workspace.js';

const router = express.Router();

/** Send a JSON answer with every write-only value (stored, or typed in this request) removed. */
const reply = (req, res, status, body) => res.status(status).json(scrub(body, secretsIn(getSpec(currentWorkspace()), req.body)));

router.get('/state', (req, res) => {
  const world = agentCoreWorld();
  return reply(req, res, 200, {
    available: isMock(),
    simulated: true,
    reason: isMock() ? null : LIVE_UNAVAILABLE,
    spec: maskSpec(getSpec(currentWorkspace())),
    writeOnly: WRITE_ONLY,
    authMethods: AUTH_METHODS,
    tokenTypes: TOKEN_TYPES,
    allowList: world.allowedOrigins,
    cast: { user: CALLER_USER, callerClient: CALLER_CLIENT_ID, exchangeIssuer: ORIGINS.acExchange, targetIssuer: ORIGINS.acTarget, runtime: ORIGINS.acRuntime },
    audience: API_AUDIENCE,
    scopes: SCOPES,
    scenarios: scenarioList(),
    claims: CLAIMS,
  });
});

// Everything below runs only against the mock.
router.use((req, res, next) => (isMock() ? next() : res.status(409).json({ error: 'live_unavailable', message: LIVE_UNAVAILABLE })));

router.put('/spec', (req, res) => {
  const ws = currentWorkspace();
  const { spec, errors } = applyPatch(getSpec(ws), req.body);
  if (errors.length) return reply(req, res, 422, { error: 'invalid_spec', message: 'The spec was not changed.', errors });
  setSpec(ws, spec);
  return reply(req, res, 200, { spec: maskSpec(spec) });
});

router.post('/spec/reset', (req, res) => {
  const ws = currentWorkspace();
  resetAgentCore(ws);
  return reply(req, res, 200, { spec: maskSpec(getSpec(ws)) });
});

router.post('/run', async (req, res) => {
  const id = typeof req.body?.scenario === 'string' ? req.body.scenario : 'happy';
  if (!Object.hasOwn(SCENARIOS, id)) return reply(req, res, 404, { error: 'unknown_scenario', message: 'No such scenario.', scenarios: Object.keys(SCENARIOS) });
  try {
    return reply(req, res, 200, await runScenario(id, getSpec(currentWorkspace())));
  } catch {
    return reply(req, res, 500, { error: 'run_failed', message: 'The run failed inside the mock.' });
  }
});

router.post('/reset', (req, res) => {
  resetAgentCore(currentWorkspace());
  return reply(req, res, 200, { ok: true });
});

export default router;
