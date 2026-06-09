/**
 * Infrastructure Layer — Runtime config loader with env overlay.
 * DES-MG-050: Environment variable overrides for config values.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MemGraphRagConfig } from './memGraphRagConfigSchema.js';

export interface EnvOverrides {
  readonly OPENAI_API_KEY?: string;
  readonly MEMGRAPHRAG_DATA_DIR?: string;
  readonly MEMGRAPHRAG_NLP_BACKEND?: string;
  readonly MEMGRAPHRAG_LOCAL_ONLY?: string;
  readonly MEMGRAPHRAG_LOG_LEVEL?: string;
  readonly MEMGRAPHRAG_SQLITE_PATH?: string;
}

/**
 * Resolves a config with environment variable overrides applied.
 * Env vars take precedence over YAML config values.
 */
export function resolveConfigFromEnv(
  config: MemGraphRagConfig,
  env: Record<string, string | undefined> = process.env,
): MemGraphRagConfig {
  const overrides: Partial<Record<string, unknown>> = {};

  // Data directory
  const dataDir = env['MEMGRAPHRAG_DATA_DIR'];
  if (dataDir) {
    overrides['dataDir'] = dataDir;
  }

  // Local only mode
  const localOnly = env['MEMGRAPHRAG_LOCAL_ONLY'];
  if (localOnly !== undefined) {
    overrides['localOnly'] = localOnly === 'true' || localOnly === '1';
  }

  // NLP backend
  const nlpBackend = env['MEMGRAPHRAG_NLP_BACKEND'];
  const validBackends = ['python-sidecar', 'llm', 'regex'] as const;
  let providers = config.providers;
  if (nlpBackend && validBackends.includes(nlpBackend as typeof validBackends[number])) {
    providers = {
      ...config.providers,
      nlp: {
        ...config.providers.nlp,
        backend: nlpBackend as typeof validBackends[number],
      },
    };
  }

  // Log level
  const logLevel = env['MEMGRAPHRAG_LOG_LEVEL'];
  const validLevels = ['debug', 'info', 'warn', 'error'] as const;
  let logging = config.logging;
  if (logLevel && validLevels.includes(logLevel as typeof validLevels[number])) {
    logging = {
      ...config.logging,
      level: logLevel as typeof validLevels[number],
    };
  }

  // SQLite path
  const sqlitePath = env['MEMGRAPHRAG_SQLITE_PATH'];
  let storage = config.storage;
  if (sqlitePath) {
    storage = {
      ...config.storage,
      sqlitePath,
    };
  }

  return {
    ...config,
    ...overrides,
    providers,
    logging,
    storage,
  } as MemGraphRagConfig;
}

/**
 * Checks whether an API key is available.
 * Checks: api_key_file (config) → OPENAI_API_KEY (env).
 * Returns the reason if not available.
 */
export function checkApiKeyAvailability(
  config: MemGraphRagConfig,
  env: Record<string, string | undefined> = process.env,
): { available: boolean; reason?: string } {
  if (config.localOnly) {
    return { available: false, reason: 'FEATURE_REQUIRES_API: local_only mode is enabled' };
  }

  // Check api_key_file first
  if (config.providers.apiKeyFile) {
    const filePath = resolve(process.cwd(), config.providers.apiKeyFile);
    if (existsSync(filePath)) {
      const key = readFileSync(filePath, 'utf-8').trim();
      if (key.length > 0) {
        return { available: true };
      }
    }
  }

  // Then check environment variable
  const apiKey = env['OPENAI_API_KEY'];
  if (!apiKey || apiKey.trim().length === 0) {
    return { available: false, reason: 'API key not found: neither api_key_file nor OPENAI_API_KEY is set' };
  }

  return { available: true };
}

/**
 * Redacts sensitive values from config for logging.
 */
export function redactConfigForLogging(
  config: MemGraphRagConfig,
): Record<string, unknown> {
  return {
    version: config.version,
    localOnly: config.localOnly,
    dataDir: config.dataDir,
    algorithms: config.algorithms,
    chunking: config.chunking,
    providers: {
      llm: { backend: config.providers.llm.backend, model: config.providers.llm.model },
      embedding: { backend: config.providers.embedding.backend, model: config.providers.embedding.model },
      nlp: { backend: config.providers.nlp.backend },
    },
    storage: { sqlitePath: config.storage.sqlitePath, walMode: config.storage.walMode },
    security: config.security,
    logging: { level: config.logging.level },
  };
}
