import { appendFile, mkdir, mkdtemp, link, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  V15_PARITY_ATTESTATION_SCHEMA,
  V15_REQUIRED_PARITY_CASES,
  checkV15ParityAttestation,
  serializeV15ParityJson,
  sha256V15ParityBytes,
  type V15ParityArtifact,
} from '../../../../src/domain/retrieval/v15ParityEvidence.js';
import {
  readV15ParityInput,
  runV15ParityEvidenceCli,
  computeV15ParityTreeDigest,
  verifyV15PrivateSourceAuthority,
} from '../../../../src/interface/cli/v15ParityEvidenceCli.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'v15-parity-cli-'));
  roots.push(root);
  return root;
}

function publicAttestation(verdict: 'pass' | 'fail' = 'pass') {
  const requiredCases = Object.fromEntries(V15_REQUIRED_PARITY_CASES.map((name) => [name, true]));
  const summary = {
    beforeCount: 1, afterCount: 1, matchedCount: 1, changedRankCount: 0,
    maxAbsScoreDelta: 0, maxRankDelta: 0,
  };
  return {
    schema: V15_PARITY_ATTESTATION_SCHEMA,
    detailedArtifactSha256: '1'.repeat(64),
    evaluatedSources: {
      evaluatedSynapseBaseCommit: 'a'.repeat(40),
      evaluatedSynapseBaseTreeDigest: '2'.repeat(64),
      evaluatedSynapseCandidateCommit: 'b'.repeat(40),
      evaluatedSynapseCandidateTreeDigest: '3'.repeat(64),
      evaluatedGraphDbCommit: 'c'.repeat(40),
      evaluatedGraphDbTreeDigest: '4'.repeat(64),
    },
    publicManifests: {
      domainSha256: sha256V15ParityBytes(Buffer.from('domain-manifest\n')),
      normalizationSha256: sha256V15ParityBytes(Buffer.from('normalization-manifest\n')),
    },
    requiredCases,
    aggregate: {
      candidate: summary, expansion: summary, ppr: summary,
      idAssociationRowCount: 1, idAssociationChangedRowCount: 0, maximumAbsScoreDelta: 0, maximumRankDelta: 0,
    },
    acceptedSemanticChanges: [],
    verdict,
  };
}

async function createAuthorityRepository(root: string, name: string, commits: number) {
  const repository = join(root, name);
  execFileSync('git', ['init', '-q', repository]);
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'parity@example.test']);
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'Parity Test']);
  await mkdir(join(repository, 'packages/memgraphrag/tests/fixtures'), { recursive: true });
  await writeFile(join(repository, 'packages/memgraphrag/tests/fixtures/bounded-domain-fixture.manifest.json'), 'domain-manifest\n');
  await writeFile(join(repository, 'packages/memgraphrag/tests/fixtures/unicode16-lowercase.manifest.json'), 'normalization-manifest\n');
  const values: string[] = [];
  for (let index = 0; index < commits; index += 1) {
    await writeFile(join(repository, 'authority.txt'), `authority-${index}\n`);
    execFileSync('git', ['-C', repository, 'add', '.']);
    execFileSync('git', ['-C', repository, 'commit', '-q', '-m', `authority ${index}`]);
    values.push(execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  }
  return { repository, commits: values };
}

describe('V15 parity evidence CLI boundary', () => {
  it('accepts a canonical public attestation and returns only a stable token', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'attestation.json');
    const synapse = await createAuthorityRepository(root, 'synapse', 3);
    const graphDb = await createAuthorityRepository(root, 'graphdb', 2);
    const attestation = publicAttestation();
    attestation.evaluatedSources = {
      evaluatedSynapseBaseCommit: synapse.commits[0]!,
      evaluatedSynapseBaseTreeDigest: await computeV15ParityTreeDigest(synapse.repository, synapse.commits[0]!),
      evaluatedSynapseCandidateCommit: synapse.commits[1]!,
      evaluatedSynapseCandidateTreeDigest: await computeV15ParityTreeDigest(synapse.repository, synapse.commits[1]!),
      evaluatedGraphDbCommit: graphDb.commits[0]!,
      evaluatedGraphDbTreeDigest: await computeV15ParityTreeDigest(graphDb.repository, graphDb.commits[0]!),
    };
    await writeFile(path, serializeV15ParityJson(attestation), { mode: 0o600 });
    await expect(runV15ParityEvidenceCli('--check-public', [path, synapse.repository, graphDb.repository]))
      .resolves.toEqual(Buffer.from('V15_PARITY_PUBLIC_OK\n'));

    attestation.evaluatedSources.evaluatedGraphDbTreeDigest = 'f'.repeat(64);
    await writeFile(path, serializeV15ParityJson(attestation), { mode: 0o600 });
    await expect(runV15ParityEvidenceCli('--check-public', [path, synapse.repository, graphDb.repository]))
      .rejects.toThrow('SOURCE_TREE_MISMATCH');

    attestation.evaluatedSources.evaluatedGraphDbTreeDigest =
      await computeV15ParityTreeDigest(graphDb.repository, graphDb.commits[0]!);
    attestation.publicManifests.domainSha256 = 'f'.repeat(64);
    await writeFile(path, serializeV15ParityJson(attestation), { mode: 0o600 });
    await expect(runV15ParityEvidenceCli('--check-public', [path, synapse.repository, graphDb.repository]))
      .rejects.toThrow('PUBLIC_MANIFEST_AUTHORITY_MISMATCH');
  });

  it('rejects false required cases paired with a passing verdict', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'attestation.json');
    const attestation = publicAttestation();
    attestation.requiredCases['missing-object-fail-closed'] = false;
    await writeFile(path, serializeV15ParityJson(attestation), { mode: 0o600 });
    expect(() => checkV15ParityAttestation(serializeV15ParityJson(attestation))).toThrow('DECLARED_VERDICT_MISMATCH');

    const empty = publicAttestation();
    const emptySummary = {
      beforeCount: 0, afterCount: 0, matchedCount: 0, changedRankCount: 0,
      maxAbsScoreDelta: 0, maxRankDelta: 0,
    };
    empty.aggregate = {
      candidate: emptySummary,
      expansion: emptySummary,
      ppr: emptySummary,
      idAssociationRowCount: 0,
      idAssociationChangedRowCount: 0,
      maximumAbsScoreDelta: 0,
      maximumRankDelta: 0,
    };
    expect(() => checkV15ParityAttestation(serializeV15ParityJson(empty)))
      .toThrow('EMPTY_PUBLIC_MEASUREMENT');
  });

  it('rejects symlinks and hard links before parsing payload bytes', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'target.json');
    const symbolic = join(root, 'symbolic.json');
    const hard = join(root, 'hard.json');
    await writeFile(target, serializeV15ParityJson(publicAttestation()), { mode: 0o600 });
    await symlink(target, symbolic);
    await link(target, hard);
    await expect(readV15ParityInput(symbolic, 1024 * 1024)).rejects.toThrow();
    await expect(readV15ParityInput(hard, 1024 * 1024)).rejects.toThrow('UNSAFE_INPUT_FILE');
  });

  it('rejects oversized and noncanonical inputs without exposing paths', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'secret-production-name.json');
    await writeFile(path, Buffer.alloc(17, 0x20), { mode: 0o600 });
    await expect(readV15ParityInput(path, 16)).rejects.toThrow('UNSAFE_INPUT_FILE');
    await writeFile(path, Buffer.from(JSON.stringify(publicAttestation())), { mode: 0o600 });
    expect(() => checkV15ParityAttestation(Buffer.from(JSON.stringify(publicAttestation())))).toThrow('NON_CANONICAL_JSON');
  });

  it('bounds a file that grows after admission to limit plus one byte', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'growing.json');
    await writeFile(path, Buffer.alloc(8, 0x20), { mode: 0o600 });
    await expect(readV15ParityInput(path, 16, {
      afterInitialStat: async () => appendFile(path, Buffer.alloc(20, 0x20)),
    })).rejects.toThrow('UNSAFE_INPUT_FILE');
  });

  it('verifies private exact heads, ancestry, tree digests, and runtime', async () => {
    const root = await temporaryRoot();
    const synapse = await createAuthorityRepository(root, 'private-synapse', 2);
    const graphDb = await createAuthorityRepository(root, 'private-graphdb', 1);
    const hub = await createAuthorityRepository(root, 'private-hub', 1);
    const artifact = {
      evaluatedSources: {
        evaluatedSynapseBaseCommit: synapse.commits[0]!,
        evaluatedSynapseBaseTreeDigest: await computeV15ParityTreeDigest(synapse.repository, synapse.commits[0]!),
        evaluatedSynapseCandidateCommit: synapse.commits[1]!,
        evaluatedSynapseCandidateTreeDigest: await computeV15ParityTreeDigest(synapse.repository, synapse.commits[1]!),
        evaluatedGraphDbCommit: graphDb.commits[0]!,
        evaluatedGraphDbTreeDigest: await computeV15ParityTreeDigest(graphDb.repository, graphDb.commits[0]!),
        evaluatedHubDriverCommit: hub.commits[0]!,
        evaluatedHubDriverTreeDigest: await computeV15ParityTreeDigest(hub.repository, hub.commits[0]!),
      },
      publicManifests: {
        domainSha256: sha256V15ParityBytes(Buffer.from('domain-manifest\n')),
        normalizationSha256: sha256V15ParityBytes(Buffer.from('normalization-manifest\n')),
      },
      runtime: {
        node: process.version.replace(/^v/u, ''),
        v8: process.versions.v8,
        icu: process.versions.icu ?? '',
        unicode: process.versions.unicode ?? '',
        os: process.platform,
        architecture: process.arch,
      },
    } as V15ParityArtifact;
    await expect(verifyV15PrivateSourceAuthority(artifact, {
      synapse: synapse.repository, graphDb: graphDb.repository, hub: hub.repository,
    })).resolves.toBeUndefined();
    artifact.evaluatedSources.evaluatedSynapseBaseCommit = synapse.commits[1]!;
    artifact.evaluatedSources.evaluatedSynapseCandidateCommit = synapse.commits[0]!;
    await expect(verifyV15PrivateSourceAuthority(artifact, {
      synapse: synapse.repository, graphDb: graphDb.repository, hub: hub.repository,
    })).rejects.toThrow('SOURCE_ANCESTRY_MISMATCH');
    artifact.evaluatedSources.evaluatedSynapseBaseCommit = synapse.commits[0]!;
    artifact.evaluatedSources.evaluatedSynapseCandidateCommit = synapse.commits[1]!;
    artifact.runtime.node = 'fabricated';
    await expect(verifyV15PrivateSourceAuthority(artifact, {
      synapse: synapse.repository, graphDb: graphDb.repository, hub: hub.repository,
    })).rejects.toThrow('RUNTIME_AUTHORITY_MISMATCH');
  });

  it('requires the private checker checkout to be detached, clean, and exactly pinned', async () => {
    const root = await temporaryRoot();
    const synapse = await createAuthorityRepository(root, 'preflight-synapse', 2);
    const graphDb = await createAuthorityRepository(root, 'preflight-graphdb', 1);
    const hub = await createAuthorityRepository(root, 'preflight-hub', 1);
    const missing = join(root, 'missing.json');
    const args = (checkerCommit: string) => [
      checkerCommit, missing, missing, missing, synapse.repository, graphDb.repository, hub.repository,
    ];

    await expect(runV15ParityEvidenceCli('--check-private', args(synapse.commits[1]!)))
      .rejects.toThrow('SOURCE_NOT_DETACHED');

    execFileSync('git', ['-C', synapse.repository, 'checkout', '--detach', synapse.commits[1]!]);
    await appendFile(join(synapse.repository, 'authority.txt'), 'dirty\n');
    await expect(runV15ParityEvidenceCli('--check-private', args(synapse.commits[1]!)))
      .rejects.toThrow('SOURCE_WORKTREE_DIRTY');
    execFileSync('git', ['-C', synapse.repository, 'checkout', '--', '.']);

    await expect(runV15ParityEvidenceCli('--check-private', args('f'.repeat(40))))
      .rejects.toThrow('SOURCE_HEAD_MISMATCH');
    await expect(runV15ParityEvidenceCli('--check-private', args(synapse.commits[0]!)))
      .rejects.toThrow('SOURCE_HEAD_MISMATCH');
  });
});
