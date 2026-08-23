import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadMemGraphRagConfig } from '../../../../src/infrastructure/config/loadMemGraphRagConfig.js';
import {
  resolveConfigFromEnv,
  checkApiKeyAvailability,
  redactConfigForLogging,
} from '../../../../src/infrastructure/config/resolveConfigFromEnv.js';

const DEFAULT_CONFIG = resolve(
  import.meta.dirname,
  '..', '..', '..', '..',
  'config', 'default.memgraphrag.yml',
);

describe('TASK-MG-027: Config env overlay', () => {
  it('requires an explicit RUN_NEO4J_E2E opt-in in addition to an API key', () => {
    expect(process.env.RUN_NEO4J_E2E).not.toBe('1');
  });
  const baseConfig = loadMemGraphRagConfig(DEFAULT_CONFIG);

  describe('resolveConfigFromEnv', () => {
    it('should override dataDir from env', () => {
      const resolved = resolveConfigFromEnv(baseConfig, {
        MEMGRAPHRAG_DATA_DIR: '/custom/data',
      });
      expect(resolved.dataDir).toBe('/custom/data');
    });

    it('should set localOnly=true from env', () => {
      const resolved = resolveConfigFromEnv(baseConfig, {
        MEMGRAPHRAG_LOCAL_ONLY: 'true',
      });
      expect(resolved.localOnly).toBe(true);
    });

    it('should set localOnly=true from "1"', () => {
      const resolved = resolveConfigFromEnv(baseConfig, {
        MEMGRAPHRAG_LOCAL_ONLY: '1',
      });
      expect(resolved.localOnly).toBe(true);
    });

    it('should set localOnly=false from "false"', () => {
      const resolved = resolveConfigFromEnv(baseConfig, {
        MEMGRAPHRAG_LOCAL_ONLY: 'false',
      });
      expect(resolved.localOnly).toBe(false);
    });

    it('should override NLP backend', () => {
      const resolved = resolveConfigFromEnv(baseConfig, {
        MEMGRAPHRAG_NLP_BACKEND: 'regex',
      });
      expect(resolved.providers.nlp.backend).toBe('regex');
    });

    it('should ignore invalid NLP backend', () => {
      const resolved = resolveConfigFromEnv(baseConfig, {
        MEMGRAPHRAG_NLP_BACKEND: 'invalid',
      });
      expect(resolved.providers.nlp.backend).toBe('python-sidecar');
    });

    it('should override log level', () => {
      const resolved = resolveConfigFromEnv(baseConfig, {
        MEMGRAPHRAG_LOG_LEVEL: 'debug',
      });
      expect(resolved.logging.level).toBe('debug');
    });

    it('should ignore invalid log level', () => {
      const resolved = resolveConfigFromEnv(baseConfig, {
        MEMGRAPHRAG_LOG_LEVEL: 'verbose',
      });
      expect(resolved.logging.level).toBe('info');
    });

    it('should override SQLite path', () => {
      const resolved = resolveConfigFromEnv(baseConfig, {
        MEMGRAPHRAG_SQLITE_PATH: '/tmp/test.db',
      });
      expect(resolved.storage.sqlitePath).toBe('/tmp/test.db');
    });

    it('should not modify original config', () => {
      resolveConfigFromEnv(baseConfig, {
        MEMGRAPHRAG_DATA_DIR: '/changed',
      });
      expect(baseConfig.dataDir).toBe('./data/memgraphrag');
    });
  });

  describe('checkApiKeyAvailability', () => {
    it('should return unavailable when localOnly is true', () => {
      const localConfig = { ...baseConfig, localOnly: true };
      const result = checkApiKeyAvailability(localConfig, {});
      expect(result.available).toBe(false);
      expect(result.reason).toContain('FEATURE_REQUIRES_API');
    });

    it('should return unavailable when OPENAI_API_KEY is not set', () => {
      const noFileConfig = {
        ...baseConfig,
        providers: { ...baseConfig.providers, apiKeyFile: undefined },
      };
      const result = checkApiKeyAvailability(noFileConfig, {});
      expect(result.available).toBe(false);
      expect(result.reason).toContain('api_key_file');
    });

    it('should return unavailable when OPENAI_API_KEY is empty', () => {
      const noFileConfig = {
        ...baseConfig,
        providers: { ...baseConfig.providers, apiKeyFile: undefined },
      };
      const result = checkApiKeyAvailability(noFileConfig, {
        OPENAI_API_KEY: '  ',
      });
      expect(result.available).toBe(false);
    });

    it('should return available when API key is present', () => {
      const noFileConfig = {
        ...baseConfig,
        providers: { ...baseConfig.providers, apiKeyFile: undefined },
      };
      const result = checkApiKeyAvailability(noFileConfig, {
        OPENAI_API_KEY: 'sk-test-key',
      });
      expect(result.available).toBe(true);
    });

    it('should return available when api_key_file exists', () => {
      const result = checkApiKeyAvailability(baseConfig, {});
      expect(result.available).toBe(true);
    });
  });

  describe('redactConfigForLogging', () => {
    it('should not include sensitive fields', () => {
      const redacted = redactConfigForLogging(baseConfig);
      const json = JSON.stringify(redacted);
      expect(json).not.toContain('cacheDir');
      expect(json).not.toContain('auditLogPath');
    });

    it('should include non-sensitive fields', () => {
      const redacted = redactConfigForLogging(baseConfig);
      expect(redacted).toHaveProperty('version');
      expect(redacted).toHaveProperty('localOnly');
      expect(redacted).toHaveProperty('algorithms');
    });
  });
});
