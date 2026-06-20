/**
 * MemGraphRAG Configuration Schema and Validation.
 * DES-MG-050: YAML config schema with type-safe validation.
 */

/** Algorithm parameters */
export interface SchemaAlgorithmConfig {
  readonly stabilizationThreshold: number;
  readonly canonicalizationThreshold: number;
}

export interface ConflictAlgorithmConfig {
  readonly similarityThreshold: number;
  readonly scanCandidateLimit: number;
}

export interface BridgingAlgorithmConfig {
  readonly similarityThreshold: number;
  readonly candidateLimit: number;
}

export interface PPRConfig {
  readonly teleportProbability: number;
  readonly passageDamping: number;
  readonly convergenceEpsilon: number;
  readonly maxIterations: number;
}

export interface RetrievalAlgorithmConfig {
  readonly topK: number;
  readonly topM: number;
  readonly threshold: number;
  readonly ppr: PPRConfig;
}

export interface AlgorithmsConfig {
  readonly schema: SchemaAlgorithmConfig;
  readonly conflict: ConflictAlgorithmConfig;
  readonly bridging: BridgingAlgorithmConfig;
  readonly retrieval: RetrievalAlgorithmConfig;
}

/** Chunking */
export interface ChunkingConfig {
  readonly chunkSizeTokens: number;
  readonly chunkOverlapTokens: number;
  readonly contextTokenLimit: number;
}

/** Providers */
export interface LLMProviderConfig {
  readonly backend: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
}

export interface EmbeddingProviderConfig {
  readonly backend: string;
  readonly model: string;
  readonly cacheDir: string;
}

export interface NLPProviderConfig {
  readonly backend: 'python-sidecar' | 'llm' | 'regex';
  readonly pythonCommand?: string;
  readonly requestTimeoutMs: number;
  readonly healthcheckTimeoutMs: number;
}

export interface ProvidersConfig {
  readonly llm: LLMProviderConfig;
  readonly embedding: EmbeddingProviderConfig;
  readonly nlp: NLPProviderConfig;
  readonly apiKeyFile?: string;
}

/** Storage */
export interface Neo4jConfig {
  readonly uri: string;
  readonly username: string;
  readonly password: string;
  readonly database?: string;
}

export interface StorageConfig {
  readonly backend?: 'sqlite' | 'ladybug' | 'neo4j';
  readonly sqlitePath: string;
  readonly vectorIndexDir: string;
  readonly walMode: boolean;
  readonly autoMigrate: boolean;
  readonly neo4j?: Neo4jConfig;
}

/** Security */
export interface SecurityConfig {
  readonly redactStackTraces: boolean;
  readonly corpusIsolation: 'strict';
}

/** Limits */
export interface LimitsConfig {
  readonly documentMaxBytes: number;
  readonly batchMaxDocuments: number;
}

/** Logging */
export interface LoggingConfig {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly auditLogPath: string;
  readonly structuredLogPath: string;
}

/** Root configuration */
export interface MemGraphRagConfig {
  readonly version: number;
  readonly localOnly: boolean;
  readonly dataDir: string;
  readonly algorithms: AlgorithmsConfig;
  readonly chunking: ChunkingConfig;
  readonly providers: ProvidersConfig;
  readonly storage: StorageConfig;
  readonly security: SecurityConfig;
  readonly limits: LimitsConfig;
  readonly logging: LoggingConfig;
}

/** Validation error */
export interface ConfigValidationError {
  readonly path: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: unknown;
}

/** Validation result */
export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ConfigValidationError[];
}

function assertNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: ConfigValidationError[],
  opts?: { min?: number; max?: number },
): void {
  const val = obj[key];
  if (typeof val !== 'number' || Number.isNaN(val)) {
    errors.push({ path: `${path}.${key}`, message: 'must be a number', actual: val });
    return;
  }
  if (opts?.min !== undefined && val < opts.min) {
    errors.push({ path: `${path}.${key}`, message: `must be >= ${opts.min}`, actual: val });
  }
  if (opts?.max !== undefined && val > opts.max) {
    errors.push({ path: `${path}.${key}`, message: `must be <= ${opts.max}`, actual: val });
  }
}

function assertString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: ConfigValidationError[],
): void {
  if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
    errors.push({ path: `${path}.${key}`, message: 'must be a non-empty string', actual: obj[key] });
  }
}

function assertBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: ConfigValidationError[],
): void {
  if (typeof obj[key] !== 'boolean') {
    errors.push({ path: `${path}.${key}`, message: 'must be a boolean', actual: obj[key] });
  }
}

function assertEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  values: readonly T[],
  errors: ConfigValidationError[],
): void {
  if (!values.includes(obj[key] as T)) {
    errors.push({
      path: `${path}.${key}`,
      message: `must be one of: ${values.join(', ')}`,
      expected: values.join(' | '),
      actual: obj[key],
    });
  }
}

function assertObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: ConfigValidationError[],
): Record<string, unknown> | null {
  const val = obj[key];
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    errors.push({ path: `${path}.${key}`, message: 'must be an object', actual: val });
    return null;
  }
  return val as Record<string, unknown>;
}

function validateAlgorithms(
  algorithms: Record<string, unknown>,
  errors: ConfigValidationError[],
): void {
  const schema = assertObject(algorithms, 'schema', 'algorithms', errors);
  if (schema) {
    assertNumber(schema, 'stabilizationThreshold', 'algorithms.schema', errors, { min: 1 });
    assertNumber(schema, 'canonicalizationThreshold', 'algorithms.schema', errors, { min: 0, max: 1 });
  }

  const conflict = assertObject(algorithms, 'conflict', 'algorithms', errors);
  if (conflict) {
    assertNumber(conflict, 'similarityThreshold', 'algorithms.conflict', errors, { min: 0, max: 1 });
    assertNumber(conflict, 'scanCandidateLimit', 'algorithms.conflict', errors, { min: 1 });
  }

  const bridging = assertObject(algorithms, 'bridging', 'algorithms', errors);
  if (bridging) {
    assertNumber(bridging, 'similarityThreshold', 'algorithms.bridging', errors, { min: 0, max: 1 });
    assertNumber(bridging, 'candidateLimit', 'algorithms.bridging', errors, { min: 1 });
  }

  const retrieval = assertObject(algorithms, 'retrieval', 'algorithms', errors);
  if (retrieval) {
    assertNumber(retrieval, 'topK', 'algorithms.retrieval', errors, { min: 1 });
    assertNumber(retrieval, 'topM', 'algorithms.retrieval', errors, { min: 1 });
    assertNumber(retrieval, 'threshold', 'algorithms.retrieval', errors, { min: 0, max: 1 });

    const ppr = assertObject(retrieval, 'ppr', 'algorithms.retrieval', errors);
    if (ppr) {
      assertNumber(ppr, 'teleportProbability', 'algorithms.retrieval.ppr', errors, { min: 0, max: 1 });
      assertNumber(ppr, 'passageDamping', 'algorithms.retrieval.ppr', errors, { min: 0, max: 1 });
      assertNumber(ppr, 'convergenceEpsilon', 'algorithms.retrieval.ppr', errors, { min: 0 });
      assertNumber(ppr, 'maxIterations', 'algorithms.retrieval.ppr', errors, { min: 1 });
    }
  }
}

function validateProviders(
  providers: Record<string, unknown>,
  errors: ConfigValidationError[],
): void {
  const llm = assertObject(providers, 'llm', 'providers', errors);
  if (llm) {
    assertString(llm, 'backend', 'providers.llm', errors);
    assertString(llm, 'model', 'providers.llm', errors);
    assertNumber(llm, 'temperature', 'providers.llm', errors, { min: 0, max: 2 });
    assertNumber(llm, 'maxTokens', 'providers.llm', errors, { min: 1 });
  }

  const embedding = assertObject(providers, 'embedding', 'providers', errors);
  if (embedding) {
    assertString(embedding, 'backend', 'providers.embedding', errors);
    assertString(embedding, 'model', 'providers.embedding', errors);
    assertString(embedding, 'cacheDir', 'providers.embedding', errors);
  }

  const nlp = assertObject(providers, 'nlp', 'providers', errors);
  if (nlp) {
    assertEnum(nlp, 'backend', 'providers.nlp', ['python-sidecar', 'llm', 'regex'] as const, errors);
    assertNumber(nlp, 'requestTimeoutMs', 'providers.nlp', errors, { min: 1 });
    assertNumber(nlp, 'healthcheckTimeoutMs', 'providers.nlp', errors, { min: 1 });
  }
}

/**
 * Validates a raw config object against the MemGraphRagConfig schema.
 */
export function validateMemGraphRagConfig(
  raw: unknown,
): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: [{ path: '', message: 'config must be an object' }] };
  }

  const config = raw as Record<string, unknown>;

  // Top-level
  assertNumber(config, 'version', '', errors, { min: 1 });
  assertBoolean(config, 'localOnly', '', errors);
  assertString(config, 'dataDir', '', errors);

  // Algorithms
  const algorithms = assertObject(config, 'algorithms', '', errors);
  if (algorithms) validateAlgorithms(algorithms, errors);

  // Chunking
  const chunking = assertObject(config, 'chunking', '', errors);
  if (chunking) {
    assertNumber(chunking, 'chunkSizeTokens', 'chunking', errors, { min: 1 });
    assertNumber(chunking, 'chunkOverlapTokens', 'chunking', errors, { min: 0 });
    assertNumber(chunking, 'contextTokenLimit', 'chunking', errors, { min: 1 });
  }

  // Providers
  const providers = assertObject(config, 'providers', '', errors);
  if (providers) validateProviders(providers, errors);

  // Storage
  const storage = assertObject(config, 'storage', '', errors);
  if (storage) {
    assertString(storage, 'sqlitePath', 'storage', errors);
    assertString(storage, 'vectorIndexDir', 'storage', errors);
    assertBoolean(storage, 'walMode', 'storage', errors);
    assertBoolean(storage, 'autoMigrate', 'storage', errors);
  }

  // Security
  const security = assertObject(config, 'security', '', errors);
  if (security) {
    assertBoolean(security, 'redactStackTraces', 'security', errors);
    assertEnum(security, 'corpusIsolation', 'security', ['strict'] as const, errors);
  }

  // Limits
  const limits = assertObject(config, 'limits', '', errors);
  if (limits) {
    assertNumber(limits, 'documentMaxBytes', 'limits', errors, { min: 1 });
    assertNumber(limits, 'batchMaxDocuments', 'limits', errors, { min: 1 });
  }

  // Logging
  const logging = assertObject(config, 'logging', '', errors);
  if (logging) {
    assertEnum(logging, 'level', 'logging', ['debug', 'info', 'warn', 'error'] as const, errors);
    assertString(logging, 'auditLogPath', 'logging', errors);
    assertString(logging, 'structuredLogPath', 'logging', errors);
  }

  return { valid: errors.length === 0, errors };
}
