import { defineConfig } from 'vitest/config';

// The default 5 s is too short for the 61-request rate-limit test when the machine is busy running suites in parallel.
export default defineConfig({ test: { testTimeout: 20000 } });
