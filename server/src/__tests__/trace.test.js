import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseTraceparent, formatTraceparent, newTraceparent, childTraceparent,
  makeEvent, validateEvent, createSink, credentialProblem,
} from '../trace/index.js';

const T = '0af7651916cd43dd8448eb211c80319c';
const S = 'b7ad6b7169203331';
const VALID = `00-${T}-${S}-01`;

describe('traceparent', () => {
  it('parses the W3C example', () => {
    expect(parseTraceparent(VALID)).toEqual({ version: '00', traceId: T, parentId: S, flags: '01' });
    expect(parseTraceparent(`00-${T}-${S}-00`).flags).toBe('00');
  });
  it.each([
    ['non-string', undefined],
    ['empty', ''],
    ['version ff', `ff-${T}-${S}-01`],
    ['unknown version', `01-${T}-${S}-01`],
    ['zero trace id', `00-${'0'.repeat(32)}-${S}-01`],
    ['zero parent id', `00-${T}-${'0'.repeat(16)}-01`],
    ['uppercase trace id', `00-${T.toUpperCase()}-${S}-01`],
    ['uppercase parent id', `00-${T}-${S.toUpperCase()}-01`],
    ['short trace id', `00-${T.slice(1)}-${S}-01`],
    ['long parent id', `00-${T}-${S}0-01`],
    ['bad flags length', `00-${T}-${S}-1`],
    ['non-hex', `00-${'g'.repeat(32)}-${S}-01`],
    ['trailing field', `${VALID}-extra`],
    ['missing field', `00-${T}-${S}`],
    ['whitespace', ` ${VALID}`],
  ])('rejects %s', (_n, v) => {
    expect(parseTraceparent(v)).toBeNull();
  });
  it('format round-trips and rejects bad parts', () => {
    expect(formatTraceparent({ traceId: T, parentId: S })).toBe(VALID);
    expect(() => formatTraceparent({ traceId: 'x', parentId: S })).toThrow();
  });
  it('newTraceparent is valid, uses crypto not Math.random, and is unique', () => {
    const spy = vi.spyOn(Math, 'random');
    const a = newTraceparent();
    const b = newTraceparent();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(parseTraceparent(a)).not.toBeNull();
    expect(a).not.toBe(b);
  });
  it('child keeps trace_id and flags, changes parent', () => {
    const c = parseTraceparent(childTraceparent(`00-${T}-${S}-00`));
    expect(c.traceId).toBe(T);
    expect(c.flags).toBe('00');
    expect(c.parentId).not.toBe(S);
  });
  it('child throws on malformed input', () => {
    expect(() => childTraceparent('nope')).toThrow();
  });
});

const good = () => ({
  trace_id: T, span_id: S, parent_span_id: null, product: 'cedar-pdp', hop: 'authorize',
  subject: 'user-1', actor: null, spiffe_id: null,
  decision: { result: 'allow', rule: 'policy0', reason: 'owner may read' },
  latency_ms: 3, llm: null, ts: '2026-10-20T12:00:00.000Z',
});

describe('validateEvent', () => {
  it('accepts a good event, with all optional blocks too', () => {
    expect(validateEvent(good())).toEqual([]);
    const full = {
      ...good(), parent_span_id: 'a1b2c3d4e5f60718', actor: { sub: 'agent-7', client_id: 'cl-1' },
      spiffe_id: 'spiffe://demo.example/agent/ops', llm: { tokens_in: 10, tokens_out: 5, cost_usd: 0.002 },
    };
    expect(validateEvent(full)).toEqual([]);
  });
  const bad = (name, mut, frag) => it(`flags ${name}`, () => {
    const e = good();
    mut(e);
    expect(validateEvent(e).join('\n')).toContain(frag);
  });
  it('rejects non-objects', () => {
    expect(validateEvent(null)).not.toEqual([]);
    expect(validateEvent([])).not.toEqual([]);
  });
  bad('zero trace_id', (e) => { e.trace_id = '0'.repeat(32); }, 'trace_id');
  bad('uppercase trace_id', (e) => { e.trace_id = T.toUpperCase(); }, 'trace_id');
  bad('short span_id', (e) => { e.span_id = 'abc'; }, 'span_id');
  bad('bad parent_span_id', (e) => { e.parent_span_id = 'zz'; }, 'parent_span_id');
  bad('missing parent_span_id', (e) => { delete e.parent_span_id; }, 'parent_span_id');
  bad('empty product', (e) => { e.product = ''; }, 'product');
  bad('missing hop', (e) => { delete e.hop; }, 'hop');
  bad('numeric subject', (e) => { e.subject = 5; }, 'subject');
  bad('string actor', (e) => { e.actor = 'x'; }, 'actor');
  bad('actor without sub', (e) => { e.actor = {}; }, 'actor.sub');
  bad('bad spiffe_id', (e) => { e.spiffe_id = 'https://x'; }, 'spiffe_id');
  bad('bad result', (e) => { e.decision.result = 'maybe'; }, 'decision.result');
  bad('missing rule', (e) => { delete e.decision.rule; }, 'decision.rule');
  bad('missing decision', (e) => { delete e.decision; }, 'decision');
  bad('negative latency', (e) => { e.latency_ms = -1; }, 'latency_ms');
  bad('NaN latency', (e) => { e.latency_ms = NaN; }, 'latency_ms');
  bad('fractional tokens', (e) => { e.llm = { tokens_in: 1.5, tokens_out: 1, cost_usd: 0 }; }, 'llm.tokens_in');
  bad('negative cost', (e) => { e.llm = { tokens_in: 1, tokens_out: 1, cost_usd: -1 }; }, 'llm.cost_usd');
  bad('bad ts', (e) => { e.ts = 'yesterday'; }, 'ts');
  bad('non-UTC ts', (e) => { e.ts = '2026-10-20T12:00:00+02:00'; }, 'ts');
  bad('unknown field', (e) => { e.extra = 1; }, 'extra');
});

describe('redaction guard', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = [b64({ alg: 'RS256' }), b64({ sub: 'user-1' }), b64('sig-bytes')].join('.');
  const withReason = (reason) => ({ ...good(), decision: { result: 'deny', rule: 'r', reason } });
  it('catches a JWT in any field', () => {
    expect(validateEvent(withReason(`token ${jwt} rejected`)).join()).toContain('JWT');
    expect(validateEvent({ ...good(), subject: jwt }).join()).toContain('JWT');
    expect(validateEvent({ ...good(), actor: { sub: jwt } }).join()).toContain('actor.sub');
  });
  it('catches Bearer values', () => {
    expect(validateEvent(withReason(`sent ${'Bear'}er abcdef123456`)).join()).toContain('Bearer');
  });
  it('catches PEM blocks', () => {
    expect(validateEvent(withReason(`${'-'.repeat(5)}BEGIN PRIVATE KEY${'-'.repeat(5)}\nMIIE`)).join()).toContain('PEM');
  });
  it('catches long high-entropy strings in free-text fields', () => {
    expect(validateEvent(withReason(['q8Zr2LxP9vK3', 'mT7wB1nC5dF0', 'gH4jS6aY8uE2iO'].join(''))).join()).toContain('high-entropy');
  });
  it('does not flag ordinary ids', () => {
    for (const s of [
      '3f2b8c1e-9d4a-4e6b-8a1c-5d7e9f0a1b2c',
      'policy::cedar::allow-read-own-documents-by-owner',
      'spiffe://demo.example/agent/ops-assistant',
      'permit(principal, action == Action::"read", resource);',
      'user.name@example.com',
      '0123456789abcdef0123456789abcde', // 31 hex
      'Bearer', 'bearer token missing',
    ]) {
      expect(validateEvent(withReason(s))).toEqual([]);
    }
    expect(validateEvent({ ...good(), subject: '3f2b8c1e-9d4a-4e6b-8a1c-5d7e9f0a1b2c' })).toEqual([]);
  });
  const HEXES = { 32: '9f86d081884c7d659a2feaa0c55ad015', 40: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
    64: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' };
  it.each(Object.entries(HEXES))('flags %s hex chars in every free-text field', (_n, hex) => {
    const cases = {
      'decision.rule': { ...good(), decision: { result: 'deny', rule: `r-${hex}`, reason: 'x' } },
      'decision.reason': withReason(`key ${hex} leaked`),
      subject: { ...good(), subject: hex },
      'actor.sub': { ...good(), actor: { sub: hex } },
      'actor.client_id': { ...good(), actor: { sub: 'a', client_id: hex } },
      spiffe_id: { ...good(), spiffe_id: `spiffe://demo.example/agent/${hex}` },
      product: { ...good(), product: hex },
      hop: { ...good(), hop: hex },
    };
    for (const [field, ev] of Object.entries(cases)) {
      const out = validateEvent(ev).join('\n');
      expect(out, field).toContain(`${field}:`);
      expect(out, field).toContain('hex secret');
    }
  });
  it('does not flag hex in trace_id / span_id / parent_span_id, uuids, policy ids, or 31 hex', () => {
    expect(validateEvent({ ...good(), trace_id: HEXES[32], span_id: HEXES[40].slice(0, 16), parent_span_id: HEXES[64].slice(0, 16) })).toEqual([]);
    for (const s of ['3f2b8c1e-9d4a-4e6b-8a1c-5d7e9f0a1b2c', 'policy3', 'policy::cedar::allow-read-own-documents', 'a'.repeat(31)]) {
      expect(validateEvent(withReason(s))).toEqual([]);
    }
    expect(validateEvent({ ...good(), spiffe_id: 'spiffe://demo.example/agent/orders' })).toEqual([]);
  });
  it('credentialProblem ignores non-strings', () => {
    expect(credentialProblem(42)).toBeNull();
  });
});

describe('makeEvent', () => {
  const decision = { result: 'hold', rule: 'hitl', reason: 'needs approval' };
  it('starts a trace when no traceparent arrives', () => {
    const { event, traceparent } = makeEvent({ product: 'p', hop: 'h', decision, now: Date.parse('2026-10-20T12:00:00Z') });
    expect(validateEvent(event)).toEqual([]);
    expect(event.parent_span_id).toBeNull();
    expect(event.ts).toBe('2026-10-20T12:00:00.000Z');
    expect(parseTraceparent(traceparent)).toMatchObject({ traceId: event.trace_id, parentId: event.span_id });
  });
  it('continues an incoming trace and computes latency', () => {
    const { event } = makeEvent({ traceparent: VALID, product: 'p', hop: 'h', decision, startedAt: 1000, now: 1250 });
    expect(event.trace_id).toBe(T);
    expect(event.parent_span_id).toBe(S);
    expect(event.span_id).not.toBe(S);
    expect(event.latency_ms).toBe(250);
  });
  it('treats a malformed header as no trace', () => {
    const { event } = makeEvent({ traceparent: 'garbage', product: 'p', hop: 'h', decision });
    expect(event.parent_span_id).toBeNull();
  });
});

describe('sink', () => {
  const ev = (n) => ({ ...good(), hop: `h${n}` });
  it('lists newest first and evicts the oldest', () => {
    const s = createSink({ size: 3 });
    [1, 2, 3, 4].forEach((n) => s.push(ev(n)));
    expect(s.list().map((e) => e.hop)).toEqual(['h4', 'h3', 'h2']);
  });
  it('filters by trace_id and clears', () => {
    const s = createSink();
    s.push(ev(1));
    s.push({ ...ev(2), trace_id: 'f'.repeat(32) });
    expect(s.list({ trace_id: 'f'.repeat(32) }).map((e) => e.hop)).toEqual(['h2']);
    s.clear();
    expect(s.list()).toEqual([]);
  });
  it('subscribe delivers pushes until unsubscribed', () => {
    const s = createSink();
    const got = [];
    const off = s.subscribe((e) => got.push(e.hop));
    s.push(ev(1));
    off();
    s.push(ev(2));
    expect(got).toEqual(['h1']);
  });
  it('a throwing subscriber does not break push or starve later subscribers', () => {
    const errors = [];
    const s = createSink({ onError: (err, e) => errors.push([err.message, e.hop]) });
    const got = [];
    s.subscribe(() => { throw new Error('boom'); });
    s.subscribe((e) => got.push(e.hop));
    expect(() => s.push(ev(1))).not.toThrow();
    expect(s.list().map((e) => e.hop)).toEqual(['h1']);
    expect(got).toEqual(['h1']);
    expect(errors).toEqual([['boom', 'h1']]);
  });
  it('works without onError, and survives a throwing onError', () => {
    const a = createSink();
    a.subscribe(() => { throw new Error('x'); });
    expect(() => a.push(ev(1))).not.toThrow();
    const got = [];
    const b = createSink({ onError: () => { throw new Error('y'); } });
    b.subscribe(() => { throw new Error('x'); });
    b.subscribe((e) => got.push(e.hop));
    expect(() => b.push(ev(1))).not.toThrow();
    expect(got).toEqual(['h1']);
  });
  it('rejects a bad size', () => {
    expect(() => createSink({ size: 0 })).toThrow();
  });
});

// Minimal checker for the schema subset used in trace-envelope.schema.json.
function schemaErrors(schema, v, path = 'event') {
  const errs = [];
  const types = [].concat(schema.type ?? []);
  const typeOf = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array'
    : Number.isInteger(x) ? 'integer' : typeof x);
  if (types.length && !types.some((t) => t === typeOf(v) || (t === 'number' && typeof v === 'number'))) {
    return [`${path}: type`];
  }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: enum`);
  if (typeof v === 'string') {
    if (schema.minLength && v.length < schema.minLength) errs.push(`${path}: minLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${path}: pattern`);
  }
  if (typeof v === 'number' && schema.minimum !== undefined && v < schema.minimum) errs.push(`${path}: minimum`);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) errs.push(`${path}.${k}: required`);
    for (const [k, x] of Object.entries(v)) {
      if (schema.properties?.[k]) errs.push(...schemaErrors(schema.properties[k], x, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: additional`);
    }
  }
  return errs;
}

describe('schema agrees with validateEvent', () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../trace/trace-envelope.schema.json', import.meta.url)), 'utf8'));
  const mut = (f) => { const e = good(); f(e); return e; };
  const fixtures = [
    good(),
    mut((e) => { e.actor = { sub: 'a', client_id: 'c' }; e.spiffe_id = 'spiffe://d.example/x'; e.llm = { tokens_in: 1, tokens_out: 2, cost_usd: 0.5 }; e.parent_span_id = S; }),
    mut((e) => { e.subject = null; }),
    mut((e) => { e.trace_id = '0'.repeat(32); }),
    mut((e) => { e.trace_id = 'ABC'; }),
    mut((e) => { e.span_id = '0'.repeat(16); }),
    mut((e) => { e.parent_span_id = 'x'; }),
    mut((e) => { delete e.parent_span_id; }),
    mut((e) => { e.product = ''; }),
    mut((e) => { e.hop = 3; }),
    mut((e) => { e.subject = ''; }),
    mut((e) => { e.actor = {}; }),
    mut((e) => { e.actor = { sub: 'a', extra: 1 }; }),
    mut((e) => { e.spiffe_id = 'http://x'; }),
    mut((e) => { e.decision.result = 'nope'; }),
    mut((e) => { delete e.decision.reason; }),
    mut((e) => { e.decision.extra = 1; }),
    mut((e) => { e.latency_ms = -5; }),
    mut((e) => { e.latency_ms = '5'; }),
    mut((e) => { e.llm = { tokens_in: 1.5, tokens_out: 1, cost_usd: 0 }; }),
    mut((e) => { e.llm = { tokens_in: 1, tokens_out: 1 }; }),
    mut((e) => { e.ts = 'today'; }),
    mut((e) => { e.extra = true; }),
    mut((e) => { delete e.llm; }),
  ];
  it.each(fixtures.map((f, i) => [i, f]))('fixture %i', (_i, f) => {
    expect(schemaErrors(schema, f).length === 0).toBe(validateEvent(f).length === 0);
  });
  it('matches the RESULTS list', async () => {
    const { RESULTS } = await import('../trace/envelope.js');
    expect(schema.properties.decision.properties.result.enum).toEqual(RESULTS);
  });
});

describe('docs/trace-envelope.md', () => {
  const md = readFileSync(fileURLToPath(new URL('../../../docs/trace-envelope.md', import.meta.url)), 'utf8');
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  it('has JSON examples and every one passes validateEvent', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const b of blocks) expect(validateEvent(b)).toEqual([]);
  });
  it('describes the hex rule and onError', () => {
    expect(md).toContain('32 or more hex characters');
    expect(md).toContain('onError');
  });
});

describe('module hygiene', () => {
  it('imports only node: builtins and siblings', () => {
    for (const f of ['traceparent', 'envelope', 'sink', 'redaction', 'index']) {
      const src = readFileSync(fileURLToPath(new URL(`../trace/${f}.js`, import.meta.url)), 'utf8');
      for (const m of src.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
        expect(m[1].startsWith('node:') || m[1].startsWith('./')).toBe(true);
      }
    }
  });
});
