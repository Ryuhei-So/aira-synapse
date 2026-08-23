import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const AIRA_GRAPHDB_REPO_PATH_ENV = 'AIRA_GRAPHDB_REPO_PATH';
export const AIRA_GRAPHDB_EXPECTED_SHA_ENV = 'AIRA_GRAPHDB_EXPECTED_SHA';

export const REQUIRED_GRAPHDB_CONTRACTS = Object.freeze([
  'aira-synapse-storage-ports.v1.0.0.json',
  'event-scope-map.v1.0.0.json',
  'branch-protection-policy.v1.0.0.json',
]);

function fail(reason) {
  throw new Error(`aira-graphdb repository authority rejected: ${reason}`);
}

function readHeadSha(repositoryPath) {
  try {
    return execFileSync(
      'git',
      ['-C', repositoryPath, 'rev-parse', '--verify', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    fail('repository is not a Git checkout with a readable HEAD');
  }
}

/**
 * Resolve the only supported aira-graphdb repository authority.
 *
 * The source-build fallback, CI contract tests, and branch audit all call this
 * function. There is intentionally no cwd-based discovery or fallback path.
 */
export function resolveAiraGraphDbRepository({
  expectedSha = process.env[AIRA_GRAPHDB_EXPECTED_SHA_ENV],
  requiredContracts = REQUIRED_GRAPHDB_CONTRACTS,
} = {}) {
  const configuredPath = process.env[AIRA_GRAPHDB_REPO_PATH_ENV]?.trim();
  if (!configuredPath) fail(`${AIRA_GRAPHDB_REPO_PATH_ENV} is required`);
  if (!isAbsolute(configuredPath)) fail(`${AIRA_GRAPHDB_REPO_PATH_ENV} must be absolute`);

  let repositoryPath;
  try {
    repositoryPath = realpathSync(configuredPath);
  } catch {
    fail(`${AIRA_GRAPHDB_REPO_PATH_ENV} does not resolve to a directory`);
  }

  if (!existsSync(join(repositoryPath, 'Cargo.toml'))) {
    fail('repository is missing Cargo.toml');
  }

  const contractsPath = join(repositoryPath, 'spec', 'contracts');
  if (!existsSync(contractsPath)) fail('repository is missing spec/contracts');
  for (const contract of requiredContracts) {
    if (!existsSync(join(contractsPath, contract))) {
      fail(`repository is missing required contract ${contract}`);
    }
  }

  let gitSha;
  if (expectedSha !== undefined) {
    gitSha = readHeadSha(repositoryPath);
    if (gitSha !== expectedSha) {
      fail('repository HEAD does not match the expected Git SHA');
    }
  }

  return Object.freeze({ repositoryPath, contractsPath, gitSha });
}
