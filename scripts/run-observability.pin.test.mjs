// The vendored run-observability files (rule 27) are byte-identical to the canonical pin in run-observability.sha256.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPin } from './run-observability-checkPin.mjs';

const labRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('run-observability vendored files match the canonical pin', () => {
  assert.deepEqual(checkPin(labRoot), []);
});
