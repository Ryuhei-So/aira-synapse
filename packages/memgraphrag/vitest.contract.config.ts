import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/contracts/aira_synapse_storage_ports_contract.spec.ts'],
    setupFiles: ['tests/setup/vitest.setup.ts'],
    testTimeout: 10_000,
  },
});
