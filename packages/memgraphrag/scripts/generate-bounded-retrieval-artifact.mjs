#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../dist/domain/contract/structural.js';
import {
  BOUNDED_RETRIEVAL_CONTRACT_VERSION,
  BOUNDED_RETRIEVAL_OPERATION_NAMES,
  BOUNDED_RETRIEVAL_STRUCTURAL_ARTIFACT,
  validateBoundedSemanticExchange,
} from '../dist/domain/retrieval/boundedContract.js';
import { V15_ENTITY_NORMALIZATION_DIGEST } from '../dist/domain/retrieval/v15Plan.js';

const FIXTURE_VERSION = 'aira-synapse-bounded-retrieval-fixture@1';
const MANIFEST_VERSION = 'aira-synapse-bounded-retrieval-manifest@1';
const DOMAIN_MANIFEST_VERSION = 'aira-synapse-bounded-domain-manifest@1';
const DOMAIN_FIXTURE_VERSION = 'aira-synapse-bounded-domain-fixture@1';
const UNICODE_MANIFEST_VERSION = 'V15UnicodeLowercaseManifest@1';
const UNICODE_VERSION = '16.0.0';
const UNICODE_CONFORMANCE_FORMAT = 'U16LOW1';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const artifactRelativeDir = 'packages/memgraphrag/tests/fixtures/bounded-retrieval';
const artifactDir = fileURLToPath(new URL('../tests/fixtures/bounded-retrieval/', import.meta.url));
const contractName = 'bounded-retrieval-contract.json';
const fixtureName = 'bounded-retrieval-fixture.json';
const manifestName = 'bounded-retrieval-fixture.manifest.json';
const contractPath = resolve(artifactDir, contractName);
const fixturePath = resolve(artifactDir, fixtureName);
const manifestPath = resolve(artifactDir, manifestName);
const EXPECTED_FILES = [contractName, fixtureName, manifestName];
const DEPENDENCY_PATHS = {
  domainContract: 'packages/memgraphrag/tests/fixtures/bounded-domain-contract.json',
  domainFixture: 'packages/memgraphrag/tests/fixtures/bounded-domain-fixture.json',
  domainManifest: 'packages/memgraphrag/tests/fixtures/bounded-domain-fixture.manifest.json',
  unicodeManifest: 'packages/memgraphrag/tests/fixtures/unicode16-lowercase.manifest.json',
  unicodeLookup: 'packages/memgraphrag/tests/fixtures/unicode16-lowercase.lookup.rs',
  unicodeConformance: 'packages/memgraphrag/tests/fixtures/unicode16-lowercase.conformance.bin',
};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const bytes = (value) => Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value, 'utf8');

function canonicalSegments(repoRelativePath) {
  if (typeof repoRelativePath !== 'string' || repoRelativePath.length === 0
    || repoRelativePath.startsWith('/') || repoRelativePath.includes('\\')) {
    throw new Error(`non-canonical repository path ${String(repoRelativePath)}`);
  }
  const segments = repoRelativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`non-canonical repository path ${repoRelativePath}`);
  }
  return segments;
}

async function assertRepositoryPath(repoRelativePath, finalKind) {
  const segments = canonicalSegments(repoRelativePath);
  let current = repoRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`repository path contains symlink: ${repoRelativePath}`);
    const expectedKind = index === segments.length - 1 ? finalKind : 'directory';
    if ((expectedKind === 'directory' && !stat.isDirectory())
      || (expectedKind === 'file' && !stat.isFile())) {
      throw new Error(`repository path has wrong entry kind: ${repoRelativePath}`);
    }
  }
  return current;
}

async function readPinnedDependency(repoRelativePath) {
  const path = await assertRepositoryPath(repoRelativePath, 'file');
  const content = await readFile(path);
  return { path: repoRelativePath, content, bytes: bytes(content), sha256: sha256(content) };
}

function buildFixture(domain) {
  const hits = domain.candidateHits;
  const boundedHits = (namespace) => hits
    .filter((hit) => hit.namespace === namespace)
    .map(({ id, score, item }) => ({ id, score, item }));
  const candidateRequest = {
    corpusId: 'fixture-corpus',
    slots: [
      { slotId: 'passage', namespace: 'passage', queryVector: [0], threshold: -1, limit: 10 },
      { slotId: 'fact', namespace: 'fact', queryVector: [0], threshold: -1, limit: 10 },
      { slotId: 'schema', namespace: 'schema', queryVector: [0], threshold: -1, limit: 10 },
    ],
  };
  const candidateResult = {
    slots: [
      { slotId: 'passage', namespace: 'passage', hits: boundedHits('passage') },
      { slotId: 'fact', namespace: 'fact', hits: boundedHits('fact') },
      { slotId: 'schema', namespace: 'schema', hits: boundedHits('schema') },
    ],
  };
  const factRequest = {
    corpusId: 'fixture-corpus',
    plan: {
      seedEntities: [{ key: 'alpha', score: 1 }, { key: 'beta', score: 0.5 }],
      excludedSeedFactIds: [],
      attenuation: 0.3,
      limit: 20,
      normalizationContractDigest: V15_ENTITY_NORMALIZATION_DIGEST,
    },
  };
  const factResult = {
    facts: [{
      factId: 'fixture-fact-inactive',
      score: 0.3,
      fact: hits.find((hit) => hit.id === 'fact:fixture-fact-inactive').item,
    }],
  };
  const pprRequest = {
    corpusId: 'fixture-corpus',
    plan: {
      seeds: [{ nodeId: 'fact:fixture-fact-inactive', score: 1 }],
      teleportProbability: 0.15,
      convergenceEpsilon: 0.01,
      maxIterations: 20,
      hubDegreeThreshold: 100,
      passageLimit: 10,
      entityLimit: 10,
    },
  };
  const pprResult = {
    ...domain.pprMaterialization,
    iterations: 1,
    converged: true,
    l1Delta: 0.001,
  };
  const exchanges = {
    [BOUNDED_RETRIEVAL_OPERATION_NAMES[0]]: { request: candidateRequest, result: candidateResult },
    [BOUNDED_RETRIEVAL_OPERATION_NAMES[1]]: { request: factRequest, result: factResult },
    [BOUNDED_RETRIEVAL_OPERATION_NAMES[2]]: { request: pprRequest, result: pprResult },
  };
  if (Object.keys(exchanges).join('\0') !== BOUNDED_RETRIEVAL_OPERATION_NAMES.join('\0')) {
    throw new Error('fixture operation set does not match the canonical declaration');
  }
  for (const operation of BOUNDED_RETRIEVAL_OPERATION_NAMES) {
    const exchange = exchanges[operation];
    const validation = validateBoundedSemanticExchange(operation, exchange.request, exchange.result);
    if (!validation.valid) throw new Error(`${operation} fixture is invalid: ${validation.errors.join('; ')}`);
  }
  return { fixtureVersion: FIXTURE_VERSION, exchanges };
}

async function expectedArtifacts() {
  const [domainContract, domainFixture, domainManifest, unicodeManifest, unicodeLookup, unicodeConformance] = await Promise.all([
    readPinnedDependency(DEPENDENCY_PATHS.domainContract),
    readPinnedDependency(DEPENDENCY_PATHS.domainFixture),
    readPinnedDependency(DEPENDENCY_PATHS.domainManifest),
    readPinnedDependency(DEPENDENCY_PATHS.unicodeManifest),
    readPinnedDependency(DEPENDENCY_PATHS.unicodeLookup),
    readPinnedDependency(DEPENDENCY_PATHS.unicodeConformance),
  ]);
  const domainAuthority = JSON.parse(domainManifest.content.toString('utf8'));
  if (domainAuthority.contractFile !== 'bounded-domain-contract.json'
    || domainAuthority.contractSha256 !== domainContract.sha256
    || domainAuthority.fixtureFile !== 'bounded-domain-fixture.json'
    || domainAuthority.fixtureSha256 !== domainFixture.sha256
    || domainAuthority.contractVersion !== 'aira-synapse-domain-contract@1'
    || domainAuthority.manifestVersion !== DOMAIN_MANIFEST_VERSION
    || domainAuthority.fixtureVersion !== DOMAIN_FIXTURE_VERSION) {
    throw new Error('bounded domain manifest does not authorize the pinned domain contract and fixture bytes');
  }
  const unicodeAuthority = JSON.parse(unicodeManifest.content.toString('utf8'));
  if (unicodeAuthority.normalizationDigest !== V15_ENTITY_NORMALIZATION_DIGEST
    || unicodeAuthority.manifestVersion !== UNICODE_MANIFEST_VERSION
    || unicodeAuthority.unicodeVersion !== UNICODE_VERSION
    || unicodeAuthority.outputs?.nativeRustLookup?.file !== 'tests/fixtures/unicode16-lowercase.lookup.rs'
    || unicodeAuthority.outputs?.nativeRustLookup?.bytes !== unicodeLookup.bytes
    || unicodeAuthority.outputs?.nativeRustLookup?.sha256 !== unicodeLookup.sha256
    || unicodeAuthority.outputs?.conformanceFixture?.file !== 'tests/fixtures/unicode16-lowercase.conformance.bin'
    || unicodeAuthority.outputs?.conformanceFixture?.bytes !== unicodeConformance.bytes
    || unicodeAuthority.outputs?.conformanceFixture?.sha256 !== unicodeConformance.sha256
    || unicodeAuthority.outputs?.conformanceFixture?.format !== UNICODE_CONFORMANCE_FORMAT) {
    throw new Error('Unicode manifest does not authorize the pinned normalization bytes');
  }
  const contractText = canonicalJson(BOUNDED_RETRIEVAL_STRUCTURAL_ARTIFACT);
  const fixtureText = canonicalJson(buildFixture(JSON.parse(domainFixture.content.toString('utf8'))));
  const operationSemanticDigests = Object.fromEntries(
    BOUNDED_RETRIEVAL_OPERATION_NAMES.map((operation) => {
      const semanticBytes = canonicalJson(BOUNDED_RETRIEVAL_STRUCTURAL_ARTIFACT.operations[operation]);
      return [operation, { bytes: bytes(semanticBytes), sha256: sha256(semanticBytes) }];
    }),
  );
  const manifestText = canonicalJson({
    manifestVersion: MANIFEST_VERSION,
    contractVersion: BOUNDED_RETRIEVAL_CONTRACT_VERSION,
    contractFile: contractName,
    contractBytes: bytes(contractText),
    contractSha256: sha256(contractText),
    fixtureVersion: FIXTURE_VERSION,
    fixtureFile: fixtureName,
    fixtureBytes: bytes(fixtureText),
    fixtureSha256: sha256(fixtureText),
    operationSemanticDigests,
    dependencies: [
      {
        id: domainAuthority.contractVersion,
        path: domainContract.path,
        bytes: domainContract.bytes,
        sha256: domainContract.sha256,
        contractVersion: domainAuthority.contractVersion,
      },
      {
        id: domainAuthority.manifestVersion,
        path: domainManifest.path,
        bytes: domainManifest.bytes,
        sha256: domainManifest.sha256,
        manifestVersion: domainAuthority.manifestVersion,
        contractVersion: domainAuthority.contractVersion,
      },
      {
        id: unicodeAuthority.manifestVersion,
        path: unicodeManifest.path,
        bytes: unicodeManifest.bytes,
        sha256: unicodeManifest.sha256,
        manifestVersion: unicodeAuthority.manifestVersion,
        normalizationDigest: unicodeAuthority.normalizationDigest,
        unicodeVersion: unicodeAuthority.unicodeVersion,
      },
      {
        id: `${V15_ENTITY_NORMALIZATION_DIGEST}:native-rust-lookup`,
        path: unicodeLookup.path,
        bytes: unicodeLookup.bytes,
        sha256: unicodeLookup.sha256,
        normalizationDigest: V15_ENTITY_NORMALIZATION_DIGEST,
        unicodeVersion: unicodeAuthority.unicodeVersion,
      },
      {
        id: `${V15_ENTITY_NORMALIZATION_DIGEST}:conformance`,
        path: unicodeConformance.path,
        bytes: unicodeConformance.bytes,
        sha256: unicodeConformance.sha256,
        normalizationDigest: V15_ENTITY_NORMALIZATION_DIGEST,
        unicodeVersion: unicodeAuthority.unicodeVersion,
        formatVersion: unicodeAuthority.outputs.conformanceFixture.format,
      },
    ],
  });
  return { contractText, fixtureText, manifestText };
}

async function assertExactDirectory() {
  await assertRepositoryPath(artifactRelativeDir, 'directory');
  const entries = await readdir(artifactDir, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.join('\0') !== [...EXPECTED_FILES].sort().join('\0')) {
    throw new Error(`bounded retrieval artifact directory must contain exactly ${EXPECTED_FILES.join(', ')}`);
  }
  for (const entry of entries) {
    if (!entry.isFile()) throw new Error(`bounded retrieval artifact ${entry.name} must be a regular file`);
    await assertRepositoryPath(`${artifactRelativeDir}/${entry.name}`, 'file');
  }
}

async function writeSyncedTemp(targetPath, text) {
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    return tempPath;
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publishArtifacts(artifacts) {
  await assertRepositoryPath(dirname(artifactRelativeDir), 'directory');
  try {
    await mkdir(artifactDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await assertRepositoryPath(artifactRelativeDir, 'directory');
  const existing = await readdir(artifactDir);
  const extras = existing.filter((name) => !EXPECTED_FILES.includes(name));
  if (extras.length > 0) throw new Error(`refusing to publish over unknown artifacts: ${extras.join(', ')}`);
  const temps = [];
  let primaryError;
  try {
    temps.push(await writeSyncedTemp(contractPath, artifacts.contractText));
    temps.push(await writeSyncedTemp(fixturePath, artifacts.fixtureText));
    temps.push(await writeSyncedTemp(manifestPath, artifacts.manifestText));
    await rename(temps[0], contractPath);
    await rename(temps[1], fixturePath);
    await syncDirectory(dirname(contractPath));
    // Manifest rename is the publication token; interrupted publication fails SHA checks.
    await rename(temps[2], manifestPath);
    await syncDirectory(dirname(contractPath));
  } catch (error) {
    primaryError = error;
  }
  const cleanup = await Promise.allSettled(temps.map((path) => unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  })));
  const cleanupErrors = cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], 'retrieval artifact publication and cleanup failed');
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'retrieval artifact cleanup failed');
  await assertExactDirectory();
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('usage: generate-bounded-retrieval-artifact.mjs [--check]');
}
const check = args.length === 1;
const artifacts = await expectedArtifacts();
if (check) {
  await assertExactDirectory();
  const actual = await Promise.all([contractPath, fixturePath, manifestPath].map((path) => readFile(path, 'utf8')));
  const expected = [artifacts.contractText, artifacts.fixtureText, artifacts.manifestText];
  if (actual.some((text, index) => text !== expected[index])) {
    throw new Error('bounded retrieval artifacts drift detected; run the generator and review the diff');
  }
  console.log(`bounded retrieval artifacts are current (${sha256(artifacts.manifestText)})`);
} else {
  await publishArtifacts(artifacts);
  console.log(`wrote bounded retrieval artifacts (${sha256(artifacts.manifestText)})`);
}
