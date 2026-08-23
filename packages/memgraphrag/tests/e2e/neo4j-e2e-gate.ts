export interface Neo4jE2EConfig {
  readonly uri?: string;
  readonly username?: string;
  readonly password?: string;
}

export type Neo4jE2EGateDecision =
  | { readonly state: 'skip'; readonly reason: 'opt_in_not_requested' }
  | { readonly state: 'fail'; readonly reason: string }
  | { readonly state: 'run' };

function isNonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export function assessNeo4jE2E(
  runOptIn: string | undefined,
  apiKey: string | undefined,
  config: Neo4jE2EConfig,
): Neo4jE2EGateDecision {
  if (runOptIn === undefined) {
    return { state: 'skip', reason: 'opt_in_not_requested' };
  }
  if (runOptIn !== '1') {
    return { state: 'fail', reason: 'RUN_NEO4J_E2E must equal 1 when set' };
  }
  if (!isNonEmpty(apiKey)) {
    return { state: 'fail', reason: 'OPENAI_API_KEY or api_key_file is required' };
  }
  if (!isNonEmpty(config.uri) || !isNonEmpty(config.username) || !isNonEmpty(config.password)) {
    return { state: 'fail', reason: 'Neo4j uri, username, and password are required' };
  }
  return { state: 'run' };
}

export function enforceNeo4jE2E(
  runOptIn: string | undefined,
  apiKey: string | undefined,
  config: Neo4jE2EConfig,
): Exclude<Neo4jE2EGateDecision, { readonly state: 'fail' }> {
  const decision = assessNeo4jE2E(runOptIn, apiKey, config);
  if (decision.state === 'fail') {
    throw new Error(`Neo4j E2E prerequisites failed: ${decision.reason}`);
  }
  return decision;
}
