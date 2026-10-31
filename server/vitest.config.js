import { defineConfig } from 'vitest/config';

// Tests must never read a developer's own settings. Point the shared settings file at an empty one.
// The default 5 s timeout is too short for the 61-request rate-limit test when the machine is busy running suites in parallel.
export default defineConfig({ test: { testTimeout: 20000, env: { STANDALONE_ENV: '/dev/null' } } });
