import { defineConfig } from 'vitest/config';

/** Shared timeout authority for CI tests that cold-start the Rust native backend. */
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup/vitest.setup.ts'],
    include: [
      'tests/integration/storage-port-compat/aira_graphdb.storage-port-compat.test.ts',
      'tests/integration/backend-compat/vector_lexical_compat.integration.test.ts',
      'tests/integration/interface/runtime/MemGraphRagRuntime.test.ts',
    ],
    testTimeout: 30_000,
  },
});
