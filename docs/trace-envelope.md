# Trace envelope

One small event that every hop in a demo emits, so a request that crosses
several products (and several demo repos) can be read as one story. The module
is `server/src/trace/`: dependency-free ESM (only `node:` imports) so it can be
copied as-is into demo-kit-base and every demo. It is not wired into any route
yet.

| File | Purpose |
| --- | --- |
| `traceparent.js` | W3C `traceparent` parse, format, new, child |
| `envelope.js` | `makeEvent()`, `validateEvent()`, `RESULTS` |
| `redaction.js` | credential guard used by `validateEvent()` |
| `sink.js` | `createSink({ size, onError })` in-memory ring buffer, newest first |
| `trace-envelope.schema.json` | JSON Schema for the structure (a test keeps it in agreement with `validateEvent()`) |

## Fields

All fields are required. Use `null` where a value is allowed and absent.

| Field | Type | Meaning |
| --- | --- | --- |
| `trace_id` | string, 32 lowercase hex, not all zeros | Shared by every hop of one request. The join key. |
| `span_id` | string, 16 lowercase hex, not all zeros | This hop. |
| `parent_span_id` | string (16 hex) or `null` | The span id the caller sent in `traceparent`; `null` when this hop started the trace. |
| `product` | non-empty string | Which product emitted it, e.g. `cedar-pdp`, `pingfederate`. |
| `hop` | non-empty string | What the hop did, e.g. `authorize`, `token-exchange`. |
| `subject` | non-empty string or `null` | The `sub` of the end user. |
| `actor` | object or `null` | The `act` party: `{ sub, client_id? }` (`client_id` optional, no other keys). |
| `spiffe_id` | `spiffe://...` URI or `null` | Workload identity of the hop, when it has one. |
| `decision.result` | `allow`, `deny`, `hold` or `error` | Outcome. |
| `decision.rule` | string | Policy or rule that decided (may be empty). |
| `decision.reason` | string | Short human reason (may be empty). |
| `latency_ms` | number >= 0 | Time spent in this hop. |
| `llm` | object or `null` | `{ tokens_in (int >= 0), tokens_out (int >= 0), cost_usd (number >= 0) }` for hops that called a model. |
| `ts` | ISO-8601 UTC string, e.g. `2026-10-20T12:00:00.000Z` | When the hop finished. |

Unknown fields are rejected, at the top level and inside `actor`, `decision`
and `llm`.

### Redaction guard

`validateEvent()` fails if any string value in the event looks like a raw
credential, so tokens cannot ride in a trace:

- a JWT (`eyJ...` header and payload, then a signature part),
- `Bearer <value>`,
- a PEM block (`-----BEGIN ...-----`),
- in free-text fields (`product`, `hop`, `subject`, `actor.sub`,
  `actor.client_id`, `spiffe_id`, `decision.rule`, `decision.reason`) only:
  - a run of 32 or more hex characters (hex-only secrets such as API keys or
    SHA digests; hex entropy is at most 4.0 bits, so the entropy check cannot
    see them), and
  - a run of 32 or more base64/url characters that mixes letters and digits
    and has entropy of at least 4.2 bits per character.

Not flagged: `trace_id` (32 hex), `span_id` and `parent_span_id` (16 hex) in
their own fields, which are checked by shape; UUIDs with dashes; policy ids;
SPIFFE ids; emails; a hex run of 31 or fewer. Because the hex rule covers any
free-text field, do not put a trace id in `decision.reason` (use `trace_id`).

What the guard does not catch: short secrets, low-entropy passwords, secrets
split by separators, base64 secrets that are mostly letters or digits, and
secrets in non-free-text fields. It is a tripwire, not a scanner; do not
rely on it as the only control.

The JSON Schema describes structure only; the guard lives in `validateEvent()`.

## Propagation

- Hops pass the W3C `traceparent` header (`00-<trace_id>-<parent-id>-<flags>`)
  on every call to the next hop.
- A hop that receives a valid `traceparent` continues that trace: same
  `trace_id`, a new `span_id`, and `parent_span_id` set to the incoming
  parent-id. It sends the new span id downstream. `makeEvent()` does this and
  returns the header to forward.
- A hop that receives none (or a malformed one) starts a trace: new
  `trace_id`, `parent_span_id: null`.
- Malformed means: not version `00`, wrong lengths, uppercase hex, or an
  all-zero trace-id or parent-id. Flags are carried through unchanged.

```js
import { makeEvent, validateEvent, createSink } from './trace/index.js';

const sink = createSink({ size: 500 });
const t0 = Date.now();
// ... do the work ...
const { event, traceparent } = makeEvent({
  traceparent: req.headers.traceparent,
  product: 'cedar-pdp', hop: 'authorize', subject: 'alice',
  decision: { result: 'deny', rule: 'policy3', reason: 'not the owner' },
  startedAt: t0,
});
if (validateEvent(event).length === 0) sink.push(event);
// forward `traceparent` on the next outbound call
```

`sink.list()` is newest first, `sink.list({ trace_id })` filters one trace,
and `sink.subscribe(fn)` returns an unsubscribe function.

A subscriber that throws never breaks the emitting hop: `push()` stores the
event, calls every subscriber (each in its own try/catch) and returns
normally. Errors go to the optional `createSink({ onError })` callback, called
as `onError(err, event)`; the default is a no-op, and an `onError` that throws
is also contained. The sink never logs event contents.

## Joining across demo repos

Each demo keeps its own sink. A caller in one repo forwards `traceparent` to a
service in another; both emit events with the same `trace_id`. To see the whole
story, collect events from each repo's sink and group by `trace_id`; order by
`ts`, or build the tree from `span_id` / `parent_span_id`. No shared storage or
shared code version is needed, only the envelope shape.

## Worked examples

One trace, three hops. The agent calls PingFederate for a token exchange, then
the Cedar PDP decides, and a sensitive action is held for approval. (Example
ids are made up and contain no credentials.)

### 1. Token-exchange hop with `act`

PingFederate exchanges the user's token for one that names the agent as actor.
It is the first hop, so it starts the trace.

```json
{
  "trace_id": "0af7651916cd43dd8448eb211c80319c",
  "span_id": "b7ad6b7169203331",
  "parent_span_id": null,
  "product": "pingfederate",
  "hop": "token-exchange",
  "subject": "alice",
  "actor": { "sub": "agent-orders", "client_id": "orders-agent" },
  "spiffe_id": "spiffe://demo.example/agent/orders",
  "decision": { "result": "allow", "rule": "jwt-atm-exchange", "reason": "actor allowed to act for subject" },
  "latency_ms": 41,
  "llm": null,
  "ts": "2026-10-20T12:00:00.000Z"
}
```

### 2. Cedar deny

The PDP receives the `traceparent` from the agent, so it continues the trace.

```json
{
  "trace_id": "0af7651916cd43dd8448eb211c80319c",
  "span_id": "00f067aa0ba902b7",
  "parent_span_id": "b7ad6b7169203331",
  "product": "cedar-pdp",
  "hop": "authorize",
  "subject": "alice",
  "actor": { "sub": "agent-orders" },
  "spiffe_id": null,
  "decision": { "result": "deny", "rule": "policy3", "reason": "refund over limit for non-manager" },
  "latency_ms": 2,
  "llm": null,
  "ts": "2026-10-20T12:00:00.120Z"
}
```

### 3. HITL hold

The gateway holds a high-value call until a human approves. The hop also
records the model call that drafted the request.

```json
{
  "trace_id": "0af7651916cd43dd8448eb211c80319c",
  "span_id": "5b8f1d3c7e2a9046",
  "parent_span_id": "00f067aa0ba902b7",
  "product": "mcp-gateway",
  "hop": "hitl-approval",
  "subject": "alice",
  "actor": { "sub": "agent-orders" },
  "spiffe_id": "spiffe://demo.example/gateway",
  "decision": { "result": "hold", "rule": "hitl-high-value", "reason": "waiting for approver" },
  "latency_ms": 5,
  "llm": { "tokens_in": 812, "tokens_out": 96, "cost_usd": 0.0041 },
  "ts": "2026-10-20T12:00:00.300Z"
}
```
