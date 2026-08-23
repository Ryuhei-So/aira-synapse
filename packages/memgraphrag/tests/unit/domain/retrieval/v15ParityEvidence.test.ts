import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import type { RankedNode } from '../../../../src/domain/retrieval/ppr.js';
import {
  associateV15RankedFacts,
  associateV15RankedPassages,
} from '../../../../src/domain/retrieval/v15Plan.js';
import {
  V15_COPY_MANIFEST_SCHEMA,
  V15_PARITY_ATTESTATION_SCHEMA,
  V15_PARITY_ARTIFACT_SCHEMA,
  buildV15ParityArtifact,
  checkV15ParityArtifact,
  checkV15ParityAttestation,
  projectV15ParityAttestation,
  serializeV15ParityJson,
  sha256V15ParityBytes,
  type V15ParityArtifact,
  type V15ParityAssociationRow,
  type V15ParityArtifactBuildInput,
} from '../../../../src/domain/retrieval/v15ParityEvidence.js';

const H = {
  canonical: '1'.repeat(64),
  owner: '2'.repeat(64),
  blob: '3'.repeat(64),
  domain: '4'.repeat(64),
  normalization: '5'.repeat(64),
  tree: '6'.repeat(64),
  fixture: 'fixture-data',
  domainManifest: 'domain-manifest',
  normalizationManifest: 'normalization-manifest',
};
const C = {
  base: 'a'.repeat(40),
  candidate: 'b'.repeat(40),
  graphDb: 'c'.repeat(40),
  hub: 'd'.repeat(40),
};

function makeHelperPassage(id: string): Passage {
  return {
    corpusId: 'parity-fixture',
    passageId: id,
    text: `passage ${id}`,
    normalizedText: `passage ${id}`,
    metadata: {
      documentId: `doc-${id}`,
      title: id,
      sourceUrl: `https://example.test/${id}`,
      language: 'en',
      sectionPath: [],
      chunkId: id,
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 1,
    },
    factIds: [],
    entityMentions: [],
    qualityFlags: [],
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

function makeHelperFact(id: string): Fact {
  return {
    corpusId: 'parity-fixture',
    factId: id,
    schemaId: 'schema-1',
    headEntity: 'Alpha',
    headType: 'Entity',
    relation: 'relates',
    tailEntity: 'Beta',
    tailType: 'Entity',
    state: 'inactive',
    passageIds: [],
    sourceDocumentIds: [],
    confidence: 1,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

function rowsFromSharedAssociationHelpers(): V15ParityAssociationRow[] {
  const passageNodes: RankedNode[] = [
    { nodeId: 'passage:passage-1', score: 0.9, layer: 'passage' },
  ];
  const factNodes: RankedNode[] = [
    { nodeId: 'fact:fact-1', score: 0.8, layer: 'fact' },
  ];
  const passageAssociations = associateV15RankedPassages(
    passageNodes,
    [makeHelperPassage('passage-1')],
  );
  const factAssociations = associateV15RankedFacts(
    factNodes,
    [makeHelperFact('fact-1')],
  );
  return [
    ...passageAssociations.map(({ item, node }) => ({
      rankedResultId: node.nodeId,
      passageIds: [item.passageId],
      factIds: [],
    })),
    ...factAssociations.map(({ item, node }) => ({
      rankedResultId: node.nodeId,
      passageIds: [],
      factIds: [item.factId],
    })),
  ];
}

function manifestBytes() {
  return serializeV15ParityJson({
    schema: V15_COPY_MANIFEST_SCHEMA,
    generation: 7,
    entries: [
      { role: 'canonical', path: 'canonical.json', size: 10, sha256: H.canonical },
      { role: 'ownerManifest', path: 'owner.json', size: 11, sha256: H.owner },
      { role: 'vectorBlob', path: 'g0007.vblob', size: 12, sha256: H.blob },
    ],
    descriptor: {
      generation: 7,
      vectorBlob: { basename: 'g0007.vblob', size: 12, sha256: H.blob, format: 1 },
    },
  });
}

function caseMeasurements() {
  const tieHits = [
    { id: 'alpha', rank: 1, score: 0.5 },
    { id: 'beta', rank: 2, score: 0.5 },
  ];
  return {
    missingObjectFailClosed: { executions: 1, failureClass: 'missing-object', partialResultCount: 0 },
    absentSeed: { executions: 1, absentSeedIds: ['absent-seed'], rankedNodeIds: ['ranked-node'] },
    signedSumNonPositive: { executions: 1, seedScores: [-1], teleportWeights: [0.5, 0.5] },
    danglingLoss: { executions: 1, danglingNodeIds: ['dangling-node'], lostMass: 1, redistributedMass: 0 },
    hubDamping: {
      executions: 1,
      totalDegree: 100,
      hubDegreeThreshold: 50,
      undampedScore: 1,
      dampedScore: 1 / Math.log2(102),
    },
    convergence: { executions: 1, converged: true, iterations: 1, l1Delta: 0, epsilon: 1 },
    candidateTieOrder: { executions: 1, rankedHits: tieHits },
    expansionTieOrder: { executions: 1, rankedHits: tieHits },
    pprTieOrder: { executions: 1, rankedHits: tieHits },
  };
}

function buildInput(): V15ParityArtifactBuildInput {
  const alpha = { id: 'alpha', rank: 1, score: 0.5 };
  const betaBefore = { id: 'beta', rank: 1, score: 0.5 };
  const alphaBefore = { id: 'alpha', rank: 2, score: 0.5 };
  const alphaAfter = { id: 'alpha', rank: 1, score: 0.5 };
  const betaAfter = { id: 'beta', rank: 2, score: 0.5 };
  const association = { rankedResultId: 'passage:alpha', passageIds: ['alpha'], factIds: [] };
  return {
    copyManifestBytes: manifestBytes(),
    fixtureBytes: Buffer.from(H.fixture),
    domainManifestBytes: Buffer.from(H.domainManifest),
    normalizationManifestBytes: Buffer.from(H.normalizationManifest),
    generatedAt: '2026-08-24T00:00:00.000Z',
    evaluatedSources: {
      evaluatedSynapseBaseCommit: C.base,
      evaluatedSynapseBaseTreeDigest: H.tree,
      evaluatedSynapseCandidateCommit: C.candidate,
      evaluatedSynapseCandidateTreeDigest: H.tree,
      evaluatedGraphDbCommit: C.graphDb,
      evaluatedGraphDbTreeDigest: H.tree,
      evaluatedHubDriverCommit: C.hub,
      evaluatedHubDriverTreeDigest: H.tree,
    },
    synapseCheckerCommit: C.candidate,
    runtime: { node: '24.11.1', v8: '13.6', icu: '77.1', unicode: '16.0', os: 'linux', architecture: 'arm64' },
    normalizedArguments: ['--copied-root', '<redacted>'],
    comparisons: {
      candidate: { before: [alpha], after: [alpha] },
      expansion: { before: [betaBefore, alphaBefore], after: [alphaAfter, betaAfter] },
      ppr: { before: [betaBefore, alphaBefore], after: [alphaAfter, betaAfter] },
      idAssociation: {
        before: [association],
        after: [association],
        inputs: {
          rankedNodes: [{ nodeId: 'passage:alpha', score: 0.5, layer: 'passage' }],
          passageIds: ['alpha'],
          factIds: [],
        },
      },
    },
    missingObjectAudit: { checked: 10, missing: 0 },
    caseMeasurements: caseMeasurements(),
    acceptedSemanticChanges: ['semantic-expansion-tie-order', 'semantic-ppr-tie-order'],
  };
}

function buildArtifact(input = buildInput()) {
  return buildV15ParityArtifact(input);
}

describe('V15 copied-production parity evidence authority', () => {
  it('derives exact byte hashes, comparisons, verdict, and redacted attestation', () => {
    const input = buildInput();
    const artifact = buildArtifact(input);
    expect(artifact.schema).toBe(V15_PARITY_ARTIFACT_SCHEMA);
    expect(artifact.copyManifestSha256).toBe(sha256V15ParityBytes(input.copyManifestBytes));
    expect(artifact.fixtureSha256).toBe(sha256V15ParityBytes(input.fixtureBytes));
    expect(artifact.aggregate.expansion.changedRankCount).toBe(2);
    expect(artifact.verdict).toBe('pass');

    const artifactBytes = serializeV15ParityJson(artifact);
    expect(checkV15ParityArtifact(artifactBytes, input.copyManifestBytes, input.fixtureBytes)).toEqual(artifact);
    const attestation = projectV15ParityAttestation(artifactBytes, input.copyManifestBytes, input.fixtureBytes);
    expect(attestation.schema).toBe(V15_PARITY_ATTESTATION_SCHEMA);
    expect(attestation.detailedArtifactSha256).toBe(sha256V15ParityBytes(artifactBytes));
    expect(attestation).not.toHaveProperty('canonicalSha256');
    expect(attestation).not.toHaveProperty('ownerManifestSha256');
    expect(attestation).not.toHaveProperty('vectorBlobSha256');
    expect(attestation).not.toHaveProperty('copyManifestSha256');
    expect(attestation).not.toHaveProperty('fixtureSha256');
    expect(attestation).not.toHaveProperty('normalizedArguments');
    expect(attestation.evaluatedSources).not.toHaveProperty('evaluatedHubDriverCommit');
    expect(attestation.evaluatedSources).not.toHaveProperty('evaluatedHubDriverTreeDigest');
    expect(checkV15ParityAttestation(serializeV15ParityJson(attestation))).toEqual(attestation);
  });

  it('derives the detailed hash from exact private bytes and rejects malformed public hashes', () => {
    const input = buildInput();
    const artifactBytes = serializeV15ParityJson(buildArtifact(input));
    const attestation = projectV15ParityAttestation(artifactBytes, input.copyManifestBytes, input.fixtureBytes);
    expect(attestation.detailedArtifactSha256).toBe(sha256V15ParityBytes(artifactBytes));

    const malformed = {
      ...attestation,
      detailedArtifactSha256: 'not-a-sha256',
    };
    expect(() => checkV15ParityAttestation(serializeV15ParityJson(malformed))).toThrow();
  });

  it('rejects caller-supplied or changed bytes instead of trusting digest fields', () => {
    const input = buildInput();
    const artifact = buildArtifact(input);
    const artifactBytes = serializeV15ParityJson(artifact);
    expect(() => checkV15ParityArtifact(artifactBytes, input.copyManifestBytes, Buffer.from('changed')))
      .toThrow('BYTE_AUTHORITY_MISMATCH');
    const tampered = { ...artifact, copyManifestSha256: 'f'.repeat(64) };
    expect(() => checkV15ParityArtifact(serializeV15ParityJson(tampered), input.copyManifestBytes, input.fixtureBytes))
      .toThrow('BYTE_AUTHORITY_MISMATCH');
  });

  it('rejects noncanonical JSON and unknown schema fields', () => {
    const input = buildInput();
    const artifact = buildArtifact(input);
    const compact = Buffer.from(JSON.stringify(artifact));
    expect(() => checkV15ParityArtifact(compact, input.copyManifestBytes, input.fixtureBytes)).toThrow('NON_CANONICAL_JSON');
    expect(() => projectV15ParityAttestation(
      serializeV15ParityJson({ ...artifact, extra: true }), input.copyManifestBytes, input.fixtureBytes,
    )).toThrow();
  });

  it('does not allow a missing production object to claim pass', () => {
    const input = {
      ...buildInput(),
      missingObjectAudit: { checked: 10, missing: 1 },
    };
    expect(buildArtifact(input).verdict).toBe('fail');

    const zeroAudit = {
      ...buildInput(),
      missingObjectAudit: { checked: 0, missing: 0 },
    };
    expect(buildArtifact(zeroAudit).verdict).toBe('fail');

    const artifact = buildArtifact(buildInput());
    const tampered: V15ParityArtifact = {
      ...artifact,
      missingObjectAudit: { checked: 10, missing: 1 },
      verdict: 'pass',
    };
    expect(() => projectV15ParityAttestation(
      serializeV15ParityJson(tampered), input.copyManifestBytes, input.fixtureBytes,
    )).toThrow('DECLARED_REQUIRED_CASES_MISMATCH');

    const attestation = projectV15ParityAttestation(
      serializeV15ParityJson(artifact), input.copyManifestBytes, input.fixtureBytes,
    );
    const publicTampered = {
      ...attestation,
      requiredCases: { ...attestation.requiredCases, 'production-missing-object-zero': false },
      verdict: 'pass' as const,
    };
    expect(() => checkV15ParityAttestation(serializeV15ParityJson(publicTampered)))
      .toThrow('DECLARED_VERDICT_MISMATCH');
  });

  it('rejects duplicate accepted changes and a checker commit outside the evaluated candidate', () => {
    const duplicate = buildInput();
    duplicate.acceptedSemanticChanges = [
      'semantic-expansion-tie-order',
      'semantic-expansion-tie-order',
    ];
    expect(() => buildArtifact(duplicate)).toThrow();

    const mismatchedChecker = {
      ...buildInput(),
      synapseCheckerCommit: C.base,
    };
    expect(() => buildArtifact(mismatchedChecker)).toThrow();
  });

  it('rejects zero executions and contradictory structured case measurements', () => {
    const zeroExecution = buildInput();
    zeroExecution.caseMeasurements.absentSeed = {
      ...zeroExecution.caseMeasurements.absentSeed,
      executions: 0,
    };
    expect(() => buildArtifact(zeroExecution)).toThrow();

    const overlappingAbsentSeed = buildInput();
    overlappingAbsentSeed.caseMeasurements.absentSeed = {
      ...overlappingAbsentSeed.caseMeasurements.absentSeed,
      rankedNodeIds: ['absent-seed'],
    };
    expect(buildArtifact(overlappingAbsentSeed).verdict).toBe('fail');

    const wrongUniformWeights = buildInput();
    wrongUniformWeights.caseMeasurements.signedSumNonPositive = {
      ...wrongUniformWeights.caseMeasurements.signedSumNonPositive,
      teleportWeights: [0.25, 0.75],
    };
    expect(buildArtifact(wrongUniformWeights).verdict).toBe('fail');

    const wrongHubFormula = buildInput();
    wrongHubFormula.caseMeasurements.hubDamping = {
      ...wrongHubFormula.caseMeasurements.hubDamping,
      dampedScore: 0.5,
    };
    expect(buildArtifact(wrongHubFormula).verdict).toBe('fail');

    const noTieObserved = buildInput();
    noTieObserved.caseMeasurements.candidateTieOrder = {
      executions: 1,
      rankedHits: [
        { id: 'alpha', rank: 1, score: 0.6 },
        { id: 'beta', rank: 2, score: 0.5 },
      ],
    };
    expect(buildArtifact(noTieObserved).verdict).toBe('fail');

    const nonCanonicalOrder = buildInput();
    nonCanonicalOrder.caseMeasurements.candidateTieOrder = {
      executions: 1,
      rankedHits: [
        { id: 'beta', rank: 1, score: 0.5 },
        { id: 'alpha', rank: 2, score: 0.5 },
      ],
    };
    expect(() => buildArtifact(nonCanonicalOrder)).toThrow('candidate-tie-order:INVALID_ORDER');
  });

  it('rejects added IDs, score drift, non-tie reordering, and undeclared hardening', () => {
    const added = buildInput();
    added.comparisons.candidate.after.push({ id: 'new', rank: 2, score: 0.1 });
    expect(() => buildArtifact(added)).toThrow('candidate:ID_SET_MISMATCH');

    const drift = buildInput();
    drift.comparisons.expansion.after[1] = { ...drift.comparisons.expansion.after[1]!, score: 0.4 };
    expect(() => buildArtifact(drift)).toThrow('expansion:SCORE_MISMATCH');

    const notTie = buildInput();
    notTie.comparisons.ppr.before[1] = { id: 'alpha', rank: 2, score: 0.4 };
    notTie.comparisons.ppr.after[0] = { id: 'alpha', rank: 1, score: 0.4 };
    expect(() => buildArtifact(notTie)).toThrow('ppr:NON_TIE_RANK_CHANGE');

    const undeclared = buildInput();
    undeclared.acceptedSemanticChanges.splice(0);
    expect(() => buildArtifact(undeclared)).toThrow('expansion:UNACCEPTED_RANK_CHANGE');

    const unorderedCandidate = buildInput();
    const unordered = [
      { id: 'beta', rank: 1, score: 0.4 },
      { id: 'alpha', rank: 2, score: 0.5 },
    ];
    unorderedCandidate.comparisons.candidate = { before: unordered, after: unordered };
    expect(() => buildArtifact(unorderedCandidate)).toThrow('candidate:INVALID_AFTER_ORDER');
  });

  it('accepts generation zero and rejects contradictory public summaries', () => {
    const input = buildInput();
    const manifest = JSON.parse(input.copyManifestBytes.toString('utf8'));
    manifest.generation = 0;
    manifest.descriptor.generation = 0;
    input.copyManifestBytes = serializeV15ParityJson(manifest);
    const artifact = buildArtifact(input);
    expect(artifact.generation).toBe(0);

    const artifactBytes = serializeV15ParityJson(artifact);
    const attestation = projectV15ParityAttestation(artifactBytes, input.copyManifestBytes, input.fixtureBytes);
    const contradictory = {
      ...attestation,
      aggregate: {
        ...attestation.aggregate,
        candidate: { ...attestation.aggregate.candidate, afterCount: 2 },
      },
    };
    expect(() => checkV15ParityAttestation(serializeV15ParityJson(contradictory)))
      .toThrow('candidate:INVALID_PUBLIC_SUMMARY');
  });

  it('publishes an executable generated schema with exact ordered copy roles', () => {
    const schema = JSON.parse(readFileSync(
      new URL('../../../../config/v15-parity/copy-manifest.schema.json', import.meta.url),
      'utf8',
    ));
    expect(schema.properties.entries.allOf[0].prefixItems).toHaveLength(3);
    expect(schema.properties.entries.allOf[1].minItems).toBe(3);
    expect(schema.properties.entries.allOf[1].maxItems).toBe(3);
    // Zod emits tuple position and length as two allOf branches. Ajv's
    // strictTuples warning cannot see the sibling branch, but validation can.
    const validate = new Ajv2020({ strict: true, strictTuples: false }).compile(schema);
    const manifest = JSON.parse(manifestBytes().toString('utf8'));
    expect(validate(manifest)).toBe(true);

    const reordered = structuredClone(manifest);
    [reordered.entries[0], reordered.entries[1]] = [reordered.entries[1], reordered.entries[0]];
    expect(validate(reordered)).toBe(false);

    const duplicate = structuredClone(manifest);
    duplicate.entries[1] = duplicate.entries[0];
    expect(validate(duplicate)).toBe(false);

    const extra = structuredClone(manifest);
    extra.entries.push(extra.entries[2]);
    expect(validate(extra)).toBe(false);
  });

  it('rejects a measured association changed from the existing shared helper output', () => {
    const base = buildInput();
    const expectedAfter = rowsFromSharedAssociationHelpers();
    const measuredAfter = expectedAfter.map((row) => row.rankedResultId === 'passage:passage-1'
      ? { ...row, passageIds: ['wrong-passage'] }
      : row);
    const input = {
      ...base,
      acceptedSemanticChanges: [
        ...base.acceptedSemanticChanges,
        'semantic-id-keyed-context-association' as const,
      ],
      comparisons: {
        ...base.comparisons,
        idAssociation: {
          before: expectedAfter,
          after: measuredAfter,
          inputs: {
            rankedNodes: [
              { nodeId: 'passage:passage-1', score: 0.9, layer: 'passage' as const },
              { nodeId: 'fact:fact-1', score: 0.8, layer: 'fact' as const },
            ],
            passageIds: ['passage-1'],
            factIds: ['fact-1'],
          },
        },
      },
    };
    expect(() => buildArtifact(input)).toThrow('idAssociation:SHARED_HELPER_MISMATCH');
  });

  it('rejects copy role aliases, reordering, traversal, descriptor drift, and oversized artifact values', () => {
    const manifest = JSON.parse(manifestBytes().toString('utf8'));
    manifest.entries[1].path = manifest.entries[0].path;
    expect(() => buildArtifact({ ...buildInput(), copyManifestBytes: serializeV15ParityJson(manifest) })).toThrow();
    manifest.entries[1].path = '../owner.json';
    expect(() => buildArtifact({ ...buildInput(), copyManifestBytes: serializeV15ParityJson(manifest) })).toThrow();
    manifest.entries[1].path = 'owner.json';
    manifest.descriptor.vectorBlob.sha256 = '9'.repeat(64);
    expect(() => buildArtifact({ ...buildInput(), copyManifestBytes: serializeV15ParityJson(manifest) })).toThrow();

    const reordered = JSON.parse(manifestBytes().toString('utf8'));
    [reordered.entries[0], reordered.entries[1]] = [reordered.entries[1], reordered.entries[0]];
    expect(() => buildArtifact({ ...buildInput(), copyManifestBytes: serializeV15ParityJson(reordered) })).toThrow();

    const pathAlias = JSON.parse(manifestBytes().toString('utf8'));
    pathAlias.entries[1].path = './owner.json';
    expect(() => buildArtifact({ ...buildInput(), copyManifestBytes: serializeV15ParityJson(pathAlias) })).toThrow();

    expect(() => serializeV15ParityJson({ value: Number.POSITIVE_INFINITY })).toThrow('NON_FINITE_JSON_NUMBER');
    expect(serializeV15ParityJson({ value: -0 })).toEqual(Buffer.from('{\n  "value": 0\n}\n'));
  });

  it('rejects tampered derived summaries and aggregate bounds', () => {
    const artifact = buildArtifact();
    const summaryTampered = {
      ...artifact,
      comparisons: {
        ...artifact.comparisons,
        expansion: {
          ...artifact.comparisons.expansion,
          summary: { ...artifact.comparisons.expansion.summary, changedRankCount: 0 },
        },
      },
    };
    expect(() => projectV15ParityAttestation(
      serializeV15ParityJson(summaryTampered),
      buildInput().copyManifestBytes,
      buildInput().fixtureBytes,
    )).toThrow('DECLARED_COMPARISON_MISMATCH');

    const aggregateTampered = {
      ...artifact,
      aggregate: { ...artifact.aggregate, maximumRankDelta: artifact.aggregate.maximumRankDelta + 1 },
    };
    expect(() => projectV15ParityAttestation(
      serializeV15ParityJson(aggregateTampered),
      buildInput().copyManifestBytes,
      buildInput().fixtureBytes,
    )).toThrow('DECLARED_AGGREGATE_MISMATCH');
  });
});
