// Rule 27 for the gateway-redeem run: the record and the stdout lines are built from the decisions the mock computed (synthetic
// decisions here: fakes only), the stdout vocabulary passes the shared classifier, and the /run route answers the record.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { assertRunObservability, classify } from '../runObservability.js';
import { buildRunRecord, decisionLine, newRunId } from '../runRecord.js';
import { API, post, useMockMode } from './mockHelpers.js';

useMockMode();

const AT = '2026-11-24T10:00:00.000Z';
const d = (id, outcome, label = `step ${id}`, evidence = `evidence for ${id}`) => ({ id, label, outcome, evidence });

// Fake decisions shaped like gatewayDecisions(): a caller pass, leg 1 with its outgoing rules blocked, leg 2 skipped, the target refused.
const DECISIONS = [
  d('caller', 'pass'), d('leg1-auth', 'pass'), d('leg1-rules', 'fail'), d('leg1-answer', 'skipped'),
  d('leg2', 'skipped'), d('target', 'fail', 'Target API', 'check: audience. HTTP 403'),
];

const SERVICE_WORDS = /\b(refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served)\b/i;

describe('the record for one gateway-redeem run', () => {
  it('passes the shared assertion, tags every row simulated, and counts only policy-point decisions', async () => {
    const record = await buildRunRecord({ runId: 'gr-test-1', decisions: DECISIONS, at: AT, write: () => {} });
    expect(assertRunObservability(record)).toEqual([]);
    expect(record.source).toBe('mock');
    // one simulated row per decision, plus one not-logged row for each of the three layers this mode never touches
    const simulated = record.rows.filter((r) => r.origin === 'simulated');
    expect(simulated).toHaveLength(DECISIONS.length);
    // each decision gets the run's stamp plus its index in milliseconds, so the panel's time sort keeps the mock's decision order
    expect(simulated.map((r) => r.at)).toEqual(DECISIONS.map((_, i) => new Date(Date.parse(AT) + i).toISOString()));
    expect(record.rows.filter((r) => r.origin === 'not-logged')).toHaveLength(3);
    // the caller check is credential verification (info), the target fail is refused, the blocked outgoing rules are a blocked row; the rest is info.
    expect(record.summary).toMatchObject({ allowed: 0, refused: 1, blocked: 1, info: 4 });
    expect(record.coverage).toMatchObject({ gateway: 'simulated', resource: 'simulated', agent: 'simulated', person: 'not-logged', authorize: 'not-logged', privilege: 'not-logged' });
    expect(record.reasons.person).toMatch(/no sign-in step/);
  });

  it('the panel rows come out in the order the mock decided them, and the caller check is info', async () => {
    const record = await buildRunRecord({ runId: 'gr-test-order', decisions: DECISIONS, at: AT, write: () => {} });
    const steps = record.rows.filter((r) => r.origin === 'simulated').map((r) => r.detail.step);
    expect(steps).toEqual(DECISIONS.map((x) => x.id));
    expect(record.rows.find((r) => r.detail?.step === 'caller')).toMatchObject({ outcome: 'info' });
  });

  it('writes one stdout line per decision, and every line passes the shared classifier with no matcher word', async () => {
    const lines = [];
    await buildRunRecord({ runId: 'gr-test-2', decisions: DECISIONS, at: AT, write: (l) => lines.push(l) });
    expect(lines).toHaveLength(DECISIONS.length);
    for (const line of lines) {
      expect(classify(line)).toBeNull();
      expect(line).not.toMatch(SERVICE_WORDS);
    }
    expect(lines[0]).toBe(`${AT} id-jag-standalone decision step=caller layer=gateway result=passed run=gr-test-2`);
    expect(lines[1]).toBe(`${new Date(Date.parse(AT) + 1).toISOString()} id-jag-standalone decision step=leg1-auth layer=agent result=passed run=gr-test-2`);
  });

  it('a throwing line writer drops only its own line and leaves the record identical to a healthy writer', async () => {
    const healthy = await buildRunRecord({ runId: 'gr-test-3', decisions: DECISIONS, at: AT, write: () => {} });
    let n = 0;
    const flaky = await buildRunRecord({ runId: 'gr-test-3', decisions: DECISIONS, at: AT, write: () => { n += 1; if (n === 3) { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } } });
    expect(flaky).toEqual(healthy);
  });

  it('a line never carries an id that could forge a second key=value pair', () => {
    const hostile = { id: 'caller x=1', outcome: 'pass' };
    const line = decisionLine(AT, hostile, 'run\nx=1');
    expect(line.split('\n')).toHaveLength(1);
    expect(line).not.toMatch(/ x=1/);
  });

  it('run ids are unique across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRunId()));
    expect(ids.size).toBe(50);
  });
});

describe('POST /api/gateway-redeem/run answers the record', () => {
  it('returns a mock record for a run and prints one stdout line per decision', async () => {
    const agent = request.agent(createApp());
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const res = await post(agent, `${API}/gateway-redeem/run`, { scenario: 'happy' }).expect(200);
      const obs = res.body.observability;
      expect(obs).toBeTruthy();
      expect(assertRunObservability(obs)).toEqual([]);
      expect(obs.source).toBe('mock');
      expect(obs.rows.filter((r) => r.origin === 'simulated').length).toBe(res.body.trace.decisions.length);
      const printed = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(' id-jag-standalone decision '));
      expect(printed).toHaveLength(res.body.trace.decisions.length);
    } finally {
      spy.mockRestore();
    }
  });

  it('an unknown scenario answers 404 and begins no run', async () => {
    const agent = request.agent(createApp());
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const res = await post(agent, `${API}/gateway-redeem/run`, { scenario: 'nope' }).expect(404);
      expect(res.body.observability).toBeUndefined();
      expect(spy.mock.calls.some((c) => String(c[0]).includes(' id-jag-standalone decision '))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
