import { mkdtemp, link, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  V15_PARITY_ATTESTATION_SCHEMA,
  V15_REQUIRED_PARITY_CASES,
  serializeV15ParityJson,
} from '../../../../src/domain/retrieval/v15ParityEvidence.js';
import {
  readV15ParityInput,
  runV15ParityEvidenceCli,
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
    beforeCount: 0, afterCount: 0, matchedCount: 0, changedRankCount: 0,
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
    publicManifests: { domainSha256: '5'.repeat(64), normalizationSha256: '6'.repeat(64) },
    requiredCases,
    aggregate: {
      candidate: summary, expansion: summary, ppr: summary,
      idAssociationChangedRowCount: 0, maximumAbsScoreDelta: 0, maximumRankDelta: 0,
    },
    acceptedSemanticChanges: [],
    verdict,
  };
}

describe('V15 parity evidence CLI boundary', () => {
  it('accepts a canonical public attestation and returns only a stable token', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'attestation.json');
    await writeFile(path, serializeV15ParityJson(publicAttestation()), { mode: 0o600 });
    await expect(runV15ParityEvidenceCli('--check-public', [path]))
      .resolves.toEqual(Buffer.from('V15_PARITY_PUBLIC_OK\n'));
  });

  it('rejects false required cases paired with a passing verdict', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'attestation.json');
    const attestation = publicAttestation();
    attestation.requiredCases['missing-object-fail-closed'] = false;
    await writeFile(path, serializeV15ParityJson(attestation), { mode: 0o600 });
    await expect(runV15ParityEvidenceCli('--check-public', [path])).rejects.toThrow('DECLARED_VERDICT_MISMATCH');
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
    await expect(runV15ParityEvidenceCli('--check-public', [path])).rejects.toThrow('NON_CANONICAL_JSON');
  });
});
