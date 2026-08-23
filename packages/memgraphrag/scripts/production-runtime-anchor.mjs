import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ANCHOR_PATH = '.github/anchors/production-runtime-8414946.json';

/**
 * Reviewed authority for the first production-runtime measurement.
 *
 * This is deliberately not read from the anchor artifact. The artifact is
 * evidence about this exact base, so a candidate cannot select a different
 * base, fallback report, or coverage result by rewriting the artifact.
 */
export const TRUSTED_BASE = Object.freeze({
  schemaVersion: 1,
  anchorId: 'aira-synapse-production-runtime-8414946',
  status: 'inconclusive',
  decision: 'no-improvement',
  source: {
    repository: 'nahisaho/aira-synapse',
    branch: 'production-runtime',
    headSha: '8414946fb77319e8c431c38e32ddddf20cf08c8e',
    graphDb: {
      repository: 'Ryuhei-So/aira-graphdb',
      ref: '164092aa47f39330c0c771495d9d42e4e935e41b',
      laterRuntimeRefNotForBaseline: 'c2413c1d9dd7903caad19c0b3007f8d6c0b76655',
    },
  },
  commands: {
    lint: 'npm run lint --workspace=packages/memgraphrag',
    lintCapture: 'npx eslint src tests --format json',
    strictCoverage: 'npm run test:coverage --workspace=packages/memgraphrag',
  },
  workflowRuns: [
    {
      workflow: 'MemGraphRAG CI',
      runId: 32625415502,
      url: 'https://github.com/Ryuhei-So/aira-synapse/actions/runs/32625415502',
      headSha: '8414946fb77319e8c431c38e32ddddf20cf08c8e',
      conclusion: 'failure',
      jobs: {
        lint: { id: 97159905838, conclusion: 'failure' },
        test: { id: 97159905928, conclusion: 'failure' },
        coverage: { id: 97159991540, conclusion: 'skipped' },
        build: { id: 97159947031, conclusion: 'skipped' },
      },
    },
    {
      workflow: 'aira-synapse-backend-compat',
      runId: 32625416547,
      url: 'https://github.com/Ryuhei-So/aira-synapse/actions/runs/32625416547',
      headSha: '8414946fb77319e8c431c38e32ddddf20cf08c8e',
      conclusion: 'failure',
      jobs: {
        storagePortContract: { id: 97159908320, conclusion: 'failure' },
        storagePortCompat: { id: 97159938897, conclusion: 'skipped' },
        backendCompat: { id: 97159938941, conclusion: 'skipped' },
        branchProtectionAudit: { id: 97159939042, conclusion: 'skipped' },
      },
    },
  ],
  toolVersions: {
    node: '22.23.2',
    npm: '10.9.8',
    eslint: '9.39.4',
    vitest: '3.2.6',
    typescript: '5.9.3',
    rustHostedStable: '1.98.0 (88d9e12ae 2026-08-18)',
  },
  hashes: {
    packageLockSha256: '60cc13fd6df219b902045a7acaf392f8947b42c812c2ead44f393de337456a89',
    files: {
      'packages/memgraphrag/eslint.config.js': '7bff623be0081bb011329cd7412326d8ed9cb8be46c5dfe9b161b31a2d41737e',
      'packages/memgraphrag/vitest.config.ts': '8873fba0d66bea9fb2bdbdd15a5e132259c92b5c5f0211ac5a7e8dad920b1329',
      '.github/workflows/memgraphrag-ci.yml': '64c5609e84c539c54807e2dbddcf7409b48a1b0256e9e186ec51971d938dafd0',
    },
    coverageSourceFileSetSha256: '0d06489961a96cfb5b395a0a193cca6cc3cea12ce9c4ed8a70c84b9fc6c056df',
  },
  lint: {
    exitCode: 1,
    diagnostics: 59,
    errors: 43,
    warnings: 16,
    normalizedDigest: '5c07b782d1da000402bc265be73e72d8eae9bb4241c3a0e5ef2f25d227d164a5',
    normalization: 'JSON.stringify diagnostics sorted by JSON string using ESLint JSON fields',
    gateResult: 'failed; raw exit code preserved',
  },
  strictCoverage: {
    exitCode: 1,
    status: 'inconclusive',
    metrics: null,
    comparability: 'not-comparable',
    summary: {
      testFiles: { failed: 2, passed: 100, total: 102 },
      tests: { failed: 1, passed: 645, skipped: 3, total: 649 },
    },
    failures: [
      {
        testFile: 'tests/unit/application/indexing/AsyncJobRunner.test.ts',
        testName: 'TASK-MG-035: AsyncJobRunner and DefaultIndexingService > records failures into the jobs table when processing throws',
        expected: 'failed',
        received: 'completed',
      },
      {
        testFile: 'tests/e2e/federation-neo4j.e2e.test.ts',
        error: 'Neo4jError: Failed to connect to server; ECONNREFUSED 127.0.0.1:7687',
      },
    ],
    inconclusiveReason: 'Strict full-scope coverage did not finish green: no coverage metrics were produced. The stale AsyncJobRunner expectation and unavailable base Neo4j endpoint are recorded, not converted into a pass.',
  },
});

// Filled from the canonical JSON body after review. A changed body is a new
// evidence artifact and must not silently replace this anchor.
export const EXPECTED_ARTIFACT_SHA256 = '8be473252883c77f4ea50ce1073082eb6dff2de0189b23880bc87fa1171494d9';

function canonicalBody(artifact) {
  const body = { ...artifact };
  delete body.integrity;
  return body;
}

export function artifactSha256(artifact) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalBody(artifact)))
    .digest('hex');
}

function gitShow(repoRoot, revision, relativePath) {
  return execFileSync('git', ['-C', repoRoot, 'show', `${revision}:${relativePath}`]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceFileSetSha256(repoRoot, revision) {
  const output = execFileSync(
    'git',
    ['-C', repoRoot, 'ls-tree', '-r', '--name-only', revision, '--', 'packages/memgraphrag/src'],
    { encoding: 'utf8' },
  );
  const files = output.trim().split('\n')
    .filter((file) => file.endsWith('.ts') && !file.endsWith('/index.ts'))
    .map((file) => file.slice('packages/memgraphrag/'.length))
    .sort();
  return sha256(`${files.join('\n')}\n`);
}

function verifyBaseObject(repoRoot) {
  const revision = TRUSTED_BASE.source.headSha;
  execFileSync('git', ['-C', repoRoot, 'cat-file', '-e', `${revision}^{commit}`]);

  const expectedFiles = {
    'package-lock.json': TRUSTED_BASE.hashes.packageLockSha256,
    ...TRUSTED_BASE.hashes.files,
  };
  for (const [relativePath, expectedHash] of Object.entries(expectedFiles)) {
    const actualHash = sha256(gitShow(repoRoot, revision, relativePath));
    assert.equal(actualHash, expectedHash, `base hash mismatch: ${relativePath}`);
  }
  assert.equal(
    sourceFileSetSha256(repoRoot, revision),
    TRUSTED_BASE.hashes.coverageSourceFileSetSha256,
    'base coverage source-file set hash mismatch',
  );
}

function readAnchor(repoRoot) {
  const path = resolve(repoRoot, ANCHOR_PATH);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function verifyProductionRuntimeAnchor(repoRoot, artifact = readAnchor(repoRoot)) {
  assert.deepEqual(
    artifact.integrity,
    {
      algorithm: 'sha256',
      canonicalization: 'JSON.stringify(anchor without integrity)',
      canonicalSha256: EXPECTED_ARTIFACT_SHA256,
    },
    'anchor integrity metadata is not the reviewed seal',
  );
  assert.equal(artifactSha256(artifact), EXPECTED_ARTIFACT_SHA256, 'anchor body digest mismatch');
  const body = canonicalBody(artifact);
  assert.deepEqual(body, TRUSTED_BASE, 'anchor body differs from reviewed evidence');
  verifyBaseObject(repoRoot);
  return body;
}

function main() {
  const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../..');
  verifyProductionRuntimeAnchor(repoRoot);
  console.log(`production-runtime anchor verified: ${TRUSTED_BASE.anchorId}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
