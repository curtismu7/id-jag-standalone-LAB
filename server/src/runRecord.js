// Rule 27: this lab's side of the shared run-observability panel for the gateway-redeem run. Pure functions around the vendored
// collector (runObservability.js, never edited here): the record builder and the one stdout line each decision leaves.
//
// Mock only: gateway-redeem answers 409 in Live mode, so every row here is `simulated`: a decision the mock computed for this run
// (gatewayDecisions in gatewayRedeemTrace.js), computed once and stamped once. Nothing is read from a log and nothing is invented;
// a layer this mode never touches says so. The stdout line carries only the step, its layer, the result and the run id.
import { randomBytes } from 'node:crypto';
import { createRunObservability, LAYERS } from './runObservability.js';

const SERVICE = 'id-jag-standalone';
const CLEAN = /[^A-Za-z0-9._:/@-]/g;
const clean = (v) => String(v ?? '-').replace(CLEAN, '_').slice(0, 64) || '-';

// The mock's decisions use the ids the gateway-redeem trace gives them: caller, leg1-*, leg2-*, target.
const layerOf = (id) => {
  if (id === 'caller' || /^leg\d-rules$/.test(id)) return 'gateway';
  if (id === 'target') return 'resource';
  return 'agent';
};

// Only a policy point is allowed or refused: the caller check and the target API's own checks. The gateway's outgoing rules are its own
// security stop when they fail (blocked). Client authentication, the issuer's answers and the skipped steps are information.
const outcomeOf = (d) => {
  if (d.id === 'caller' || d.id === 'target') return d.outcome === 'pass' ? 'allowed' : d.outcome === 'fail' ? 'refused' : 'info';
  if (/^leg\d-rules$/.test(d.id)) return d.outcome === 'fail' ? 'blocked' : 'info';
  return 'info';
};

const RESULT = { pass: 'passed', fail: 'stopped', skipped: 'unclear' };

const WHY = {
  person: 'Gateway redeem has no sign-in step: the mock minted the caller token, so the mock made no person decision.',
  authorize: 'This lab has no PingOne Authorize step in gateway redeem.',
  privilege: 'This lab has no Privilege policy, AI Guard or approval step in gateway redeem.',
  agent: 'No token exchange or redeem leg ran in this run.',
  gateway: 'The gateway made no decision in this run.',
  resource: 'The target API was not reached in this run.',
};

// One timestamped line per decision: the step, its layer, the result and the run. Never a token, a message or a reason.
export function decisionLine(at, d, runId) {
  return `${at} ${SERVICE} decision step=${clean(d.id)} layer=${clean(layerOf(d.id))} result=${RESULT[d.outcome] ?? 'unclear'} run=${clean(runId)}`;
}

export function newRunId(clock = Date.now) {
  return `gr-${clock().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/**
 * The run record for one gateway-redeem run. `decisions` is the trace's decision list (computed once by the mock); `write` receives
 * one stdout line per decision. Each line write has its own try, so one failed write drops only that line; the record is unaffected.
 */
export async function buildRunRecord({ runId, decisions, at, write = () => {}, clock = Date.now }) {
  const rows = decisions.map((d) => ({ d, layer: layerOf(d.id), outcome: outcomeOf(d) }));
  for (const { d } of rows) {
    try { write(decisionLine(at, d, runId)); } catch (e) { process.stderr.write(`run-record: a stdout line was dropped (${e?.code || 'write_failed'})\n`); }
  }
  const layers = LAYERS.map((layer) => ({
    layer,
    products: [],
    reason: WHY[layer],
    simulated: rows.filter((r) => r.layer === layer).map((r) => ({ at, outcome: r.outcome, message: `${r.d.label}: ${r.d.evidence}`, detail: { step: r.d.id, result: r.d.outcome } })),
  }));
  return createRunObservability({ clock }).collectRun({ runId, startedAt: at, endedAt: at, source: 'mock', layers });
}
