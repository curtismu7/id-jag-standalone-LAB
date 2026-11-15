// The "What Privilege did" files are vendored byte-for-byte from the family's shared/gateway-trace and pinned by sha256: a hand-edited or
// stale copy fails here. Re-vendor (cp, never edit), then re-pin: cd web/src/gateway-trace && shasum -a 256 GatewayTrace.jsx gateway-trace.css gateway-trace.test.jsx
// (the server copy server/src/gatewayTrace.js is pinned by the same file, listed there as plain gatewayTrace.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = 'web/src/gateway-trace';
const WHERE = { 'GatewayTrace.jsx': WEB, 'gateway-trace.css': WEB, 'gateway-trace.test.jsx': WEB, 'gatewayTrace.js': 'server/src' };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
const pins = fs.readFileSync(path.join(root, WEB, 'gateway-trace.sha256'), 'utf8').split('\n').filter((l) => /^[0-9a-f]{64}\s/.test(l)).map((l) => l.split(/\s+/));

test('every vendored gateway-trace file matches its pinned sha256, and all four are pinned', () => {
  assert.deepEqual(pins.map(([, f]) => f).sort(), Object.keys(WHERE).sort());
  for (const [hash, file] of pins) assert.equal(sha(`${WHERE[file]}/${file}`), hash, `${file} differs from gateway-trace.sha256 (hand-edited, or re-vendored without re-pinning)`);
});

test('the shared trace builder is vendored as gatewayTrace.js and leaves the W3C traceparent helper (trace/) alone', () => {
  assert.ok(fs.existsSync(path.join(root, 'server/src/gatewayTrace.js')));
  assert.ok(fs.existsSync(path.join(root, 'server/src/trace/traceparent.js')));
});
