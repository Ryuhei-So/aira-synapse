export interface GraphDbRepositoryAuthorityOptions {
  readonly expectedSha?: string;
  readonly requiredContracts?: readonly string[];
}

export interface GraphDbRepositoryAuthority {
  readonly repositoryPath: string;
  readonly contractsPath: string;
  readonly gitSha?: string;
}

export const AIRA_GRAPHDB_REPO_PATH_ENV: 'AIRA_GRAPHDB_REPO_PATH';
export const AIRA_GRAPHDB_EXPECTED_SHA_ENV: 'AIRA_GRAPHDB_EXPECTED_SHA';
export const REQUIRED_GRAPHDB_CONTRACTS: readonly string[];

export function resolveAiraGraphDbRepository(
  options?: GraphDbRepositoryAuthorityOptions,
): GraphDbRepositoryAuthority;
