import { defineConfig } from 'vitest/config';

// Tests must never read a developer's own settings. Point the shared settings file at an empty one.
export default defineConfig({ test: { env: { STANDALONE_ENV: '/dev/null' } } });
