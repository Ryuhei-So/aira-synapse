import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/** Coverage retains the full test scope; hosted runners need more time for native cold start. */
export default mergeConfig(
  baseConfig,
  defineConfig({ test: { testTimeout: 30_000 } }),
);
