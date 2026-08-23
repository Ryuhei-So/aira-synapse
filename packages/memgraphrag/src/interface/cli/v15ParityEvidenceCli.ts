import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  checkV15ParityArtifact,
  checkV15ParityAttestation,
  projectV15ParityAttestation,
  serializeV15ParityJson,
  sha256V15ParityBytes,
  type V15ParityArtifact,
  type V15ParityAttestation,
} from '../../domain/retrieval/v15ParityEvidence.js';

const LIMITS = {
  artifact: 64 * 1024 * 1024,
  copyManifest: 1024 * 1024,
  fixture: 128 * 1024 * 1024,
  attestation: 16 * 1024 * 1024,
} as const;

const PUBLIC_MANIFEST_PATHS = {
  domain: 'packages/memgraphrag/tests/fixtures/bounded-domain-fixture.manifest.json',
  normalization: 'packages/memgraphrag/tests/fixtures/unicode16-lowercase.manifest.json',
} as const;

async function runGit(repository: string, args: readonly string[], allowExitOne = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repository, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        child.kill('SIGKILL');
        reject(new Error('SOURCE_AUTHORITY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', () => reject(new Error('SOURCE_AUTHORITY_UNAVAILABLE')));
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else if (allowExitOne && code === 1) resolve(Buffer.from('EXIT_ONE'));
      else reject(new Error('SOURCE_AUTHORITY_REJECTED'));
    });
  });
}

async function exactCommit(repository: string, commit: string): Promise<string> {
  return (await runGit(repository, ['rev-parse', '--verify', `${commit}^{commit}`])).toString('utf8').trim();
}

export async function computeV15ParityTreeDigest(repository: string, commit: string): Promise<string> {
  if (await exactCommit(repository, commit) !== commit) throw new Error('SOURCE_COMMIT_MISMATCH');
  return sha256V15ParityBytes(await runGit(repository, ['ls-tree', '-r', '-z', '--full-tree', commit]));
}

async function assertStrictAncestor(repository: string, base: string, candidate: string): Promise<void> {
  if (base === candidate) throw new Error('SOURCE_ANCESTRY_MISMATCH');
  const result = await runGit(repository, ['merge-base', '--is-ancestor', base, candidate], true);
  if (result.toString('utf8') === 'EXIT_ONE') throw new Error('SOURCE_ANCESTRY_MISMATCH');
}

async function assertHead(
  repository: string,
  evaluated: string,
  mode: 'exact' | 'descendant',
): Promise<void> {
  const head = (await runGit(repository, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (mode === 'exact') {
    if (head !== evaluated) throw new Error('SOURCE_HEAD_MISMATCH');
  } else {
    await assertStrictAncestor(repository, evaluated, head);
  }
}

async function assertTrackedClean(repository: string): Promise<void> {
  if ((await runGit(repository, ['status', '--porcelain=v1', '--untracked-files=no'])).length !== 0) {
    throw new Error('SOURCE_WORKTREE_DIRTY');
  }
}

async function assertDetached(repository: string): Promise<void> {
  const result = await runGit(repository, ['symbolic-ref', '-q', 'HEAD'], true);
  if (result.toString('utf8') !== 'EXIT_ONE') throw new Error('SOURCE_NOT_DETACHED');
}

async function assertPrivateCheckerPreflight(repository: string, expectedCommit: string): Promise<void> {
  if (await exactCommit(repository, 'HEAD') !== expectedCommit) throw new Error('SOURCE_HEAD_MISMATCH');
  await assertDetached(repository);
  await assertTrackedClean(repository);
}

async function assertPublicManifestAuthority(
  repository: string,
  commit: string,
  declared: V15ParityArtifact['publicManifests'],
): Promise<void> {
  const [domain, normalization] = await Promise.all([
    runGit(repository, ['show', `${commit}:${PUBLIC_MANIFEST_PATHS.domain}`]),
    runGit(repository, ['show', `${commit}:${PUBLIC_MANIFEST_PATHS.normalization}`]),
  ]);
  if (sha256V15ParityBytes(domain) !== declared.domainSha256
    || sha256V15ParityBytes(normalization) !== declared.normalizationSha256) {
    throw new Error('PUBLIC_MANIFEST_AUTHORITY_MISMATCH');
  }
}

async function assertEvaluatedSource(
  repository: string,
  commit: string,
  expectedTreeDigest: string,
  headMode: 'exact' | 'descendant',
): Promise<void> {
  if (await computeV15ParityTreeDigest(repository, commit) !== expectedTreeDigest) {
    throw new Error('SOURCE_TREE_MISMATCH');
  }
  await assertHead(repository, commit, headMode);
}

function assertRuntime(artifact: V15ParityArtifact): void {
  const actual = {
    node: process.version.replace(/^v/u, ''),
    v8: process.versions.v8,
    icu: process.versions.icu ?? '',
    unicode: process.versions.unicode ?? '',
    os: process.platform,
    architecture: process.arch,
  };
  if (JSON.stringify(actual) !== JSON.stringify(artifact.runtime)) throw new Error('RUNTIME_AUTHORITY_MISMATCH');
}

export async function verifyV15PrivateSourceAuthority(
  artifact: V15ParityArtifact,
  repositories: { synapse: string; graphDb: string; hub: string },
): Promise<void> {
  const sources = artifact.evaluatedSources;
  await assertStrictAncestor(
    repositories.synapse,
    sources.evaluatedSynapseBaseCommit,
    sources.evaluatedSynapseCandidateCommit,
  );
  await Promise.all([
    assertEvaluatedSource(repositories.synapse, sources.evaluatedSynapseCandidateCommit, sources.evaluatedSynapseCandidateTreeDigest, 'exact'),
    computeV15ParityTreeDigest(repositories.synapse, sources.evaluatedSynapseBaseCommit).then((digest) => {
      if (digest !== sources.evaluatedSynapseBaseTreeDigest) throw new Error('SOURCE_TREE_MISMATCH');
    }),
    assertEvaluatedSource(repositories.graphDb, sources.evaluatedGraphDbCommit, sources.evaluatedGraphDbTreeDigest, 'exact'),
    assertEvaluatedSource(repositories.hub, sources.evaluatedHubDriverCommit, sources.evaluatedHubDriverTreeDigest, 'exact'),
    assertPublicManifestAuthority(
      repositories.synapse,
      sources.evaluatedSynapseCandidateCommit,
      artifact.publicManifests,
    ),
    assertTrackedClean(repositories.synapse),
    assertTrackedClean(repositories.graphDb),
    assertTrackedClean(repositories.hub),
  ]);
  assertRuntime(artifact);
}

export async function verifyV15PublicSourceAuthority(
  attestation: V15ParityAttestation,
  repositories: { synapse: string; graphDb: string },
): Promise<void> {
  const sources = attestation.evaluatedSources;
  await assertStrictAncestor(repositories.synapse, sources.evaluatedSynapseBaseCommit, sources.evaluatedSynapseCandidateCommit);
  await Promise.all([
    assertEvaluatedSource(repositories.synapse, sources.evaluatedSynapseCandidateCommit, sources.evaluatedSynapseCandidateTreeDigest, 'descendant'),
    computeV15ParityTreeDigest(repositories.synapse, sources.evaluatedSynapseBaseCommit).then((digest) => {
      if (digest !== sources.evaluatedSynapseBaseTreeDigest) throw new Error('SOURCE_TREE_MISMATCH');
    }),
    assertEvaluatedSource(repositories.graphDb, sources.evaluatedGraphDbCommit, sources.evaluatedGraphDbTreeDigest, 'descendant'),
    assertPublicManifestAuthority(
      repositories.synapse,
      sources.evaluatedSynapseCandidateCommit,
      attestation.publicManifests,
    ),
    assertTrackedClean(repositories.synapse),
    assertTrackedClean(repositories.graphDb),
  ]);
}

export async function readV15ParityInput(
  path: string,
  limit: number,
  testHooks?: { afterInitialStat?: () => void | Promise<void> },
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) throw new Error('UNSAFE_INPUT_FILE');
    await testHooks?.afterInitialStat?.();
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= limit) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - bytesRead));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }
    if (bytesRead > limit) throw new Error('UNSAFE_INPUT_FILE');
    const bytes = Buffer.concat(chunks, bytesRead);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      BigInt(bytes.length) !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || before.nlink !== after.nlink
      || after.dev !== pathAfter.dev
      || after.ino !== pathAfter.ino
      || after.size !== pathAfter.size
      || after.mtimeNs !== pathAfter.mtimeNs
      || after.ctimeNs !== pathAfter.ctimeNs
      || !pathAfter.isFile()
      || pathAfter.nlink !== 1n
    ) throw new Error('INPUT_IDENTITY_CHANGED');
    return bytes;
  } finally {
    await handle.close();
  }
}

function requireArgs(actual: readonly string[], expected: number, usage: string): void {
  if (actual.length !== expected) throw new Error(`USAGE:${usage}`);
}

export async function runV15ParityEvidenceCli(operation: string | undefined, args: readonly string[]): Promise<Buffer> {
  if (operation === '--check-private') {
    requireArgs(args, 7, '--check-private <checker-commit> <artifact> <copy-manifest> <fixture> <synapse-repo> <graphdb-repo> <hub-repo>');
    await assertPrivateCheckerPreflight(args[4]!, args[0]!);
    const [artifact, copyManifest, fixture] = await Promise.all([
      readV15ParityInput(args[1]!, LIMITS.artifact),
      readV15ParityInput(args[2]!, LIMITS.copyManifest),
      readV15ParityInput(args[3]!, LIMITS.fixture),
    ]);
    const checked = checkV15ParityArtifact(artifact, copyManifest, fixture);
    if (checked.synapseCheckerCommit !== args[0]) throw new Error('SOURCE_COMMIT_MISMATCH');
    await verifyV15PrivateSourceAuthority(checked, { synapse: args[4]!, graphDb: args[5]!, hub: args[6]! });
    return Buffer.from('V15_PARITY_PRIVATE_OK\n');
  }
  if (operation === '--project-private') {
    requireArgs(args, 7, '--project-private <checker-commit> <artifact> <copy-manifest> <fixture> <synapse-repo> <graphdb-repo> <hub-repo>');
    await assertPrivateCheckerPreflight(args[4]!, args[0]!);
    const [artifact, copyManifest, fixture] = await Promise.all([
      readV15ParityInput(args[1]!, LIMITS.artifact),
      readV15ParityInput(args[2]!, LIMITS.copyManifest),
      readV15ParityInput(args[3]!, LIMITS.fixture),
    ]);
    const checked = checkV15ParityArtifact(artifact, copyManifest, fixture);
    if (checked.synapseCheckerCommit !== args[0]) throw new Error('SOURCE_COMMIT_MISMATCH');
    await verifyV15PrivateSourceAuthority(checked, { synapse: args[4]!, graphDb: args[5]!, hub: args[6]! });
    return serializeV15ParityJson(projectV15ParityAttestation(artifact, copyManifest, fixture));
  }
  if (operation === '--check-public') {
    requireArgs(args, 3, '--check-public <attestation> <synapse-repo> <graphdb-repo>');
    const attestation = await readV15ParityInput(args[0]!, LIMITS.attestation);
    const checked = checkV15ParityAttestation(attestation);
    await verifyV15PublicSourceAuthority(checked, { synapse: args[1]!, graphDb: args[2]! });
    return Buffer.from('V15_PARITY_PUBLIC_OK\n');
  }
  throw new Error('USAGE:--check-private|--project-private|--check-public');
}
