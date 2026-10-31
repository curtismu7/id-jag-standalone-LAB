// W3C Trace Context `traceparent` (version 00). Dependency-free.
import { randomBytes } from 'node:crypto';

const RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO32 = '0'.repeat(32);
const ZERO16 = '0'.repeat(16);

function hex(bytes) {
  return randomBytes(bytes).toString('hex');
}

export function newTraceId() {
  let id;
  do id = hex(16); while (id === ZERO32);
  return id;
}

export function newSpanId() {
  let id;
  do id = hex(8); while (id === ZERO16);
  return id;
}

// Returns { version, traceId, parentId, flags } or null when malformed.
export function parseTraceparent(value) {
  if (typeof value !== 'string') return null;
  const m = RE.exec(value);
  if (!m) return null;
  const [, version, traceId, parentId, flags] = m;
  if (version !== '00') return null; // ff is forbidden; other versions are not understood here
  if (traceId === ZERO32 || parentId === ZERO16) return null;
  return { version, traceId, parentId, flags };
}

export function formatTraceparent({ traceId, parentId, flags = '01' }) {
  const out = `00-${traceId}-${parentId}-${flags}`;
  if (!parseTraceparent(out)) throw new Error('invalid traceparent parts');
  return out;
}

// A fresh trace: new trace-id, new span id, sampled.
export function newTraceparent() {
  return formatTraceparent({ traceId: newTraceId(), parentId: newSpanId(), flags: '01' });
}

// Same trace-id and flags, new span id. The incoming parent-id becomes the
// parent of the new span; returns the header to send downstream.
export function childTraceparent(value) {
  const p = parseTraceparent(value);
  if (!p) throw new Error('invalid traceparent');
  return formatTraceparent({ traceId: p.traceId, parentId: newSpanId(), flags: p.flags });
}
