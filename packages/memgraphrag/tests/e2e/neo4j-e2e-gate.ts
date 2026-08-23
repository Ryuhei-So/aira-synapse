export interface Neo4jE2EConfig {
  readonly uri?: string;
  readonly username?: string;
  readonly password?: string;
}

function isNonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export function shouldRunNeo4jE2E(
  runOptIn: string | undefined,
  apiKey: string | undefined,
  config: Neo4jE2EConfig,
): boolean {
  return runOptIn === '1'
    && isNonEmpty(apiKey)
    && isNonEmpty(config.uri)
    && isNonEmpty(config.username)
    && isNonEmpty(config.password);
}
