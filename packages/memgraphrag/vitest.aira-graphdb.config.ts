import { defineConfig } from 'vitest/config';

/** Shared timeout authority for CI tests that cold-start the Rust native backend. */
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup/vitest.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
