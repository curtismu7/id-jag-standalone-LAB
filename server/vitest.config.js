import { defineConfig } from 'vitest/config';

// The default 5 s is too short for the 61-request rate-limit test when the machine is busy running suites in parallel.
// MODE=live: these suites test the live code paths against fakes. The mock mode has its own tests (mock*.test.js), which choose it themselves.
// STANDALONE_ENV=/dev/null: tests must never read a developer's own shared settings file.
export default defineConfig({ test: { testTimeout: 20000, env: { MODE: 'live', STANDALONE_ENV: '/dev/null' } } });
