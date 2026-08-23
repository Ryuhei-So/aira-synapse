import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveAiraGraphDbRepository } from '../../../../../scripts/graphdb-repository-authority.mjs';
import { AiraGraphDbNativeClient } from '../../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';

const REQUIRED_CONTRACTS = [
  'aira-synapse-storage-ports.v1.0.0.json',
  'event-scope-map.v1.0.0.json',
  'branch-protection-policy.v1.0.0.json',
];

const temporaryDirectories: string[] = [];

function createRepository(contractNames = REQUIRED_CONTRACTS): string {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'aira-graphdb-authority-'));
  temporaryDirectories.push(repositoryPath);
  const contractsPath = join(repositoryPath, 'spec', 'contracts');
  mkdirSync(contractsPath, { recursive: true });
  writeFileSync(join(repositoryPath, 'Cargo.toml'), '[package]\nname = "fixture"\n');
  for (const contractName of contractNames) {
    writeFileSync(join(contractsPath, contractName), '{}\n');
  }

  execFileSync('git', ['-C', repositoryPath, 'init', '--quiet']);
  execFileSync('git', ['-C', repositoryPath, 'add', '.']);
  execFileSync(
    'git',
    [
      '-C',
      repositoryPath,
      '-c',
      'user.email=authority-test@example.invalid',
      '-c',
      'user.name=authority-test',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
  );
  return repositoryPath;
}

function createSourceDirectory(): string {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'aira-graphdb-authority-source-'));
  temporaryDirectories.push(repositoryPath);
  const contractsPath = join(repositoryPath, 'spec', 'contracts');
  mkdirSync(contractsPath, { recursive: true });
  writeFileSync(join(repositoryPath, 'Cargo.toml'), '[package]\nname = "source"\n');
  for (const contractName of REQUIRED_CONTRACTS) {
    writeFileSync(join(contractsPath, contractName), '{}\n');
  }
  return repositoryPath;
}

function headSha(repositoryPath: string): string {
  return execFileSync(
    'git',
    ['-C', repositoryPath, 'rev-parse', '--verify', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('aira-graphdb repository authority', () => {
  it('returns the canonical explicitly configured repository and verifies its SHA', () => {
    const repositoryPath = createRepository();
    const sha = headSha(repositoryPath);
    vi.stubEnv('AIRA_GRAPHDB_REPO_PATH', repositoryPath);
    vi.stubEnv('AIRA_GRAPHDB_EXPECTED_SHA', sha);

    const authority = resolveAiraGraphDbRepository();

    expect(authority).toEqual({
      repositoryPath: resolve(repositoryPath),
      contractsPath: resolve(repositoryPath, 'spec', 'contracts'),
      gitSha: sha,
    });
  });

  it('allows an explicit non-Git source directory when CI SHA verification is not requested', () => {
    const repositoryPath = createSourceDirectory();
    vi.stubEnv('AIRA_GRAPHDB_REPO_PATH', repositoryPath);

    const authority = resolveAiraGraphDbRepository();

    expect(authority.repositoryPath).toBe(resolve(repositoryPath));
    expect(authority.gitSha).toBeUndefined();
  });

  it('fails closed when the explicit path is missing or not absolute', () => {
    vi.stubEnv('AIRA_GRAPHDB_REPO_PATH', '');
    expect(() => resolveAiraGraphDbRepository()).toThrow('AIRA_GRAPHDB_REPO_PATH is required');

    vi.stubEnv('AIRA_GRAPHDB_REPO_PATH', 'aira-graphdb');
    expect(() => resolveAiraGraphDbRepository()).toThrow('AIRA_GRAPHDB_REPO_PATH must be absolute');
  });

  it('does not discover a repository from the current working directory', () => {
    vi.stubEnv('AIRA_GRAPHDB_REPO_PATH', undefined);

    expect(() => resolveAiraGraphDbRepository()).toThrow('AIRA_GRAPHDB_REPO_PATH is required');
  });

  it('makes NativeClient source-build fallback fail before spawning without authority', () => {
    vi.stubEnv('AIRA_GRAPHDB_REPO_PATH', undefined);
    vi.stubEnv('AIRA_GRAPHDB_NATIVE_CMD', undefined);

    expect(() => new AiraGraphDbNativeClient('/tmp/authority-negative-test.agdb'))
      .toThrow('AIRA_GRAPHDB_REPO_PATH is required');
  });

  it('rejects a path without the Cargo manifest or required contracts', () => {
    const missingManifestPath = mkdtempSync(join(tmpdir(), 'aira-graphdb-authority-'));
    temporaryDirectories.push(missingManifestPath);
    vi.stubEnv('AIRA_GRAPHDB_REPO_PATH', missingManifestPath);
    expect(() => resolveAiraGraphDbRepository()).toThrow('repository is missing Cargo.toml');

    const missingContractPath = createRepository(REQUIRED_CONTRACTS.slice(0, 2));
    vi.stubEnv('AIRA_GRAPHDB_REPO_PATH', missingContractPath);
    expect(() => resolveAiraGraphDbRepository()).toThrow('repository is missing required contract');
  });

  it('rejects a checkout at the wrong Git SHA', () => {
    const repositoryPath = createRepository();
    vi.stubEnv('AIRA_GRAPHDB_REPO_PATH', repositoryPath);
    vi.stubEnv('AIRA_GRAPHDB_EXPECTED_SHA', '0'.repeat(40));

    expect(() => resolveAiraGraphDbRepository()).toThrow('repository HEAD does not match the expected Git SHA');
  });
});
