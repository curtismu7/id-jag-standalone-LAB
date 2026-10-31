// Trace envelope: the one event every hop emits. Dependency-free (node: only).
import { newSpanId, newTraceId, parseTraceparent } from './traceparent.js';
import { credentialProblem } from './redaction.js';

export const RESULTS = ['allow', 'deny', 'hold', 'error'];

const TRACE_ID = /^(?!0+$)[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0+$)[0-9a-f]{16}$/;
const SPIFFE = /^spiffe:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~-]+)*$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isInt = (v) => Number.isInteger(v) && v >= 0;

function extra(obj, allowed, path, problems) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) problems.push(`${path}.${k}: unknown field`);
}

// Returns a list of problem strings; empty means valid.
export function validateEvent(ev) {
  const p = [];
  if (!isObj(ev)) return ['event: must be an object'];
  extra(ev, ['trace_id', 'span_id', 'parent_span_id', 'product', 'hop', 'subject', 'actor',
    'spiffe_id', 'decision', 'latency_ms', 'llm', 'ts'], 'event', p);

  if (!TRACE_ID.test(ev.trace_id ?? '')) p.push('trace_id: must be 32 lowercase hex, not all zeros');
  if (!SPAN_ID.test(ev.span_id ?? '')) p.push('span_id: must be 16 lowercase hex, not all zeros');
  if (ev.parent_span_id !== null && !SPAN_ID.test(ev.parent_span_id ?? '')) {
    p.push('parent_span_id: must be 16 lowercase hex or null');
  }
  if (!isStr(ev.product)) p.push('product: required non-empty string');
  if (!isStr(ev.hop)) p.push('hop: required non-empty string');
  if (ev.subject !== null && !isStr(ev.subject)) p.push('subject: must be a non-empty string or null');

  if (ev.actor !== null) {
    if (!isObj(ev.actor)) p.push('actor: must be an object or null');
    else {
      extra(ev.actor, ['sub', 'client_id'], 'actor', p);
      if (!isStr(ev.actor.sub)) p.push('actor.sub: required non-empty string');
      if (ev.actor.client_id !== undefined && !isStr(ev.actor.client_id)) {
        p.push('actor.client_id: must be a non-empty string');
      }
    }
  }

  if (ev.spiffe_id !== null && !(typeof ev.spiffe_id === 'string' && SPIFFE.test(ev.spiffe_id))) {
    p.push('spiffe_id: must be a spiffe:// URI or null');
  }

  const d = ev.decision;
  if (!isObj(d)) p.push('decision: required object');
  else {
    extra(d, ['result', 'rule', 'reason'], 'decision', p);
    if (!RESULTS.includes(d.result)) p.push(`decision.result: must be one of ${RESULTS.join('|')}`);
    if (typeof d.rule !== 'string') p.push('decision.rule: required string');
    if (typeof d.reason !== 'string') p.push('decision.reason: required string');
  }

  if (!isNum(ev.latency_ms)) p.push('latency_ms: must be a number >= 0');

  if (ev.llm !== null) {
    if (!isObj(ev.llm)) p.push('llm: must be an object or null');
    else {
      extra(ev.llm, ['tokens_in', 'tokens_out', 'cost_usd'], 'llm', p);
      if (!isInt(ev.llm.tokens_in)) p.push('llm.tokens_in: must be an integer >= 0');
      if (!isInt(ev.llm.tokens_out)) p.push('llm.tokens_out: must be an integer >= 0');
      if (!isNum(ev.llm.cost_usd)) p.push('llm.cost_usd: must be a number >= 0');
    }
  }

  if (!(typeof ev.ts === 'string' && TS.test(ev.ts) && !Number.isNaN(Date.parse(ev.ts)))) {
    p.push('ts: must be an ISO-8601 UTC timestamp');
  }

  // Redaction guard: no field may carry a raw credential.
  const FREE = new Set(['product', 'hop', 'subject', 'actor.sub', 'actor.client_id', 'spiffe_id', 'decision.rule', 'decision.reason']);
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const why = credentialProblem(v, FREE.has(path));
      if (why) p.push(`${path}: ${why} (credentials must never ride in a trace)`);
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  };
  walk(ev, '');
  return p;
}

// Builds a hop event. `traceparent` is the incoming header (or undefined: this
// hop starts the trace). The new span's parent is the incoming parent-id.
// Returns the event plus the `traceparent` header to send downstream.
export function makeEvent({ traceparent, product, hop, subject = null, actor = null, spiffe_id = null,
  decision, llm = null, latency_ms, startedAt, now = Date.now() }) {
  const incoming = parseTraceparent(traceparent);
  const span_id = newSpanId();
  const trace_id = incoming ? incoming.traceId : newTraceId();
  const flags = incoming ? incoming.flags : '01';
  const event = {
    trace_id,
    span_id,
    parent_span_id: incoming ? incoming.parentId : null,
    product,
    hop,
    subject,
    actor,
    spiffe_id,
    decision,
    latency_ms: latency_ms ?? (startedAt !== undefined ? Math.max(0, now - startedAt) : 0),
    llm,
    ts: new Date(now).toISOString(),
  };
  return { event, traceparent: `00-${trace_id}-${span_id}-${flags}` };
}
