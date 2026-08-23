import { createHash } from 'node:crypto';
import { z } from 'zod';
import { associateV15RankedObjects, compareV15ScoreThenId } from './v15Plan.js';

export const V15_COPY_MANIFEST_SCHEMA = 'V15CopiedProductionCopyManifest@1' as const;
export const V15_PARITY_ARTIFACT_SCHEMA = 'V15CopiedProductionParityArtifact@1' as const;
export const V15_PARITY_ATTESTATION_SCHEMA = 'V15CopiedProductionParityAttestation@1' as const;
export const V15_PARITY_SCORE_TOLERANCE = 1e-12;

export const V15_ACCEPTED_SEMANTIC_CHANGES = [
  'semantic-expansion-tie-order',
  'semantic-ppr-tie-order',
  'semantic-id-keyed-context-association',
] as const;

export const V15_REQUIRED_PARITY_CASES = [
  'candidate',
  'expansion',
  'ppr',
  'id-association',
  'missing-object-fail-closed',
  'production-missing-object-zero',
  'absent-seed',
  'signed-sum-non-positive',
  'dangling-loss',
  'hub-damping',
  'convergence',
  'candidate-tie-order',
  'expansion-tie-order',
  'ppr-tie-order',
] as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const nonEmpty = z.string().min(1);
const finiteNumber = z.number().finite();
const nonNegativeFinite = finiteNumber.nonnegative();
const count = z.number().int().nonnegative().max(1_000_000);
const rank = z.number().int().positive().max(1_000_000);
const fileSize = z.number().int().nonnegative().max(64 * 1024 ** 3);

const copyManifestEntrySchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('canonical'), path: nonEmpty, size: fileSize, sha256 }),
  z.strictObject({ role: z.literal('ownerManifest'), path: nonEmpty, size: fileSize, sha256 }),
  z.strictObject({ role: z.literal('vectorBlob'), path: nonEmpty, size: fileSize, sha256 }),
]);

export const v15CopyManifestSchema = z.strictObject({
  schema: z.literal(V15_COPY_MANIFEST_SCHEMA),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(copyManifestEntrySchema).length(3),
  descriptor: z.strictObject({
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    vectorBlob: z.strictObject({
      basename: nonEmpty,
      size: fileSize,
      sha256,
      format: z.literal(1),
    }),
  }),
}).superRefine((manifest, context) => {
  if (manifest.descriptor.generation !== manifest.generation) {
    context.addIssue({ code: 'custom', message: 'descriptor generation mismatch' });
  }
  const expectedRoles = ['canonical', 'ownerManifest', 'vectorBlob'];
  if (manifest.entries.some((entry, index) => entry.role !== expectedRoles[index])) {
    context.addIssue({ code: 'custom', message: 'copy roles must use canonical order' });
  }
  const paths = manifest.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: 'custom', message: 'copy role paths must be unique' });
  }
  for (const path of paths) {
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      context.addIssue({ code: 'custom', message: 'copy paths must be normalized relative paths' });
    }
  }
  const blob = manifest.entries[2]!;
  if (
    manifest.descriptor.vectorBlob.basename !== blob.path.split('/').at(-1)
    || manifest.descriptor.vectorBlob.size !== blob.size
    || manifest.descriptor.vectorBlob.sha256 !== blob.sha256
  ) {
    context.addIssue({ code: 'custom', message: 'vector descriptor mismatch' });
  }
});

const evaluatedSourcesSchema = z.strictObject({
  evaluatedSynapseBaseCommit: gitSha,
  evaluatedSynapseBaseTreeDigest: sha256,
  evaluatedSynapseCandidateCommit: gitSha,
  evaluatedSynapseCandidateTreeDigest: sha256,
  evaluatedGraphDbCommit: gitSha,
  evaluatedGraphDbTreeDigest: sha256,
});

const hitSchema = z.strictObject({ id: nonEmpty.max(512), rank, score: finiteNumber });
const comparisonSummarySchema = z.strictObject({
  beforeCount: count,
  afterCount: count,
  matchedCount: count,
  changedRankCount: count,
  maxAbsScoreDelta: nonNegativeFinite,
  maxRankDelta: count,
});
const comparisonSchema = z.strictObject({
  before: z.array(hitSchema).max(100_000),
  after: z.array(hitSchema).max(100_000),
  summary: comparisonSummarySchema,
});

const associationRowSchema = z.strictObject({
  rankedResultId: nonEmpty.max(512),
  passageIds: z.array(nonEmpty.max(512)).max(10_000),
  factIds: z.array(nonEmpty.max(512)).max(10_000),
});
const rankedNodeSchema = z.strictObject({
  nodeId: nonEmpty.max(512),
  score: finiteNumber,
  layer: z.enum(['ontology', 'fact', 'passage', 'entity']),
});
const associationComparisonSchema = z.strictObject({
  before: z.array(associationRowSchema).max(100_000),
  after: z.array(associationRowSchema).max(100_000),
  inputs: z.strictObject({
    rankedNodes: z.array(rankedNodeSchema).max(100_000),
    passageIds: z.array(nonEmpty.max(512)).max(100_000),
    factIds: z.array(nonEmpty.max(512)).max(100_000),
  }),
  changedRowCount: count,
});

const requiredCasesShape = Object.fromEntries(
  V15_REQUIRED_PARITY_CASES.map((name) => [name, z.boolean()]),
) as { [K in (typeof V15_REQUIRED_PARITY_CASES)[number]]: z.ZodBoolean };
const requiredCasesSchema = z.strictObject(requiredCasesShape);

const publicManifestsSchema = z.strictObject({
  domainSha256: sha256,
  normalizationSha256: sha256,
});

const aggregateSchema = z.strictObject({
  candidate: comparisonSummarySchema,
  expansion: comparisonSummarySchema,
  ppr: comparisonSummarySchema,
  idAssociationChangedRowCount: count,
  maximumAbsScoreDelta: nonNegativeFinite,
  maximumRankDelta: count,
});

export const v15ParityArtifactSchema = z.strictObject({
  schema: z.literal(V15_PARITY_ARTIFACT_SCHEMA),
  generatedAt: z.iso.datetime({ offset: true }),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  canonicalSha256: sha256,
  ownerManifestSha256: sha256,
  vectorBlobSha256: sha256,
  copyManifestSha256: sha256,
  fixtureSha256: sha256,
  evaluatedSources: evaluatedSourcesSchema.extend({
    evaluatedHubDriverCommit: gitSha,
    evaluatedHubDriverTreeDigest: sha256,
  }),
  synapseCheckerCommit: gitSha,
  publicManifests: publicManifestsSchema,
  runtime: z.strictObject({
    node: nonEmpty,
    v8: nonEmpty,
    icu: nonEmpty,
    unicode: nonEmpty,
    os: nonEmpty,
    architecture: nonEmpty,
  }),
  normalizedArguments: z.array(z.string().max(4096).regex(/^[^\r\n]*$/u)).max(128),
  comparisons: z.strictObject({
    candidate: comparisonSchema,
    expansion: comparisonSchema,
    ppr: comparisonSchema,
    idAssociation: associationComparisonSchema,
  }),
  missingObjectAudit: z.strictObject({ checked: count, missing: count }),
  requiredCases: requiredCasesSchema,
  aggregate: aggregateSchema,
  acceptedSemanticChanges: z.array(z.enum(V15_ACCEPTED_SEMANTIC_CHANGES)).max(V15_ACCEPTED_SEMANTIC_CHANGES.length),
  verdict: z.enum(['pass', 'fail']),
}).superRefine((artifact, context) => {
  if (artifact.synapseCheckerCommit !== artifact.evaluatedSources.evaluatedSynapseCandidateCommit) {
    context.addIssue({ code: 'custom', message: 'checker must equal evaluated Synapse candidate' });
  }
  if (new Set(artifact.acceptedSemanticChanges).size !== artifact.acceptedSemanticChanges.length) {
    context.addIssue({ code: 'custom', message: 'accepted semantic changes must be unique' });
  }
});

export const v15ParityAttestationSchema = z.strictObject({
  schema: z.literal(V15_PARITY_ATTESTATION_SCHEMA),
  detailedArtifactSha256: sha256,
  evaluatedSources: evaluatedSourcesSchema,
  publicManifests: publicManifestsSchema,
  requiredCases: requiredCasesSchema,
  aggregate: aggregateSchema,
  acceptedSemanticChanges: z.array(z.enum(V15_ACCEPTED_SEMANTIC_CHANGES)).max(V15_ACCEPTED_SEMANTIC_CHANGES.length),
  verdict: z.enum(['pass', 'fail']),
});

export type V15CopyManifest = z.infer<typeof v15CopyManifestSchema>;
export type V15ParityArtifact = z.infer<typeof v15ParityArtifactSchema>;
export type V15ParityAttestation = z.infer<typeof v15ParityAttestationSchema>;
export type V15ParityHit = z.infer<typeof hitSchema>;
export type V15ParityAssociationRow = z.infer<typeof associationRowSchema>;
export type V15ParityRequiredCases = z.infer<typeof requiredCasesSchema>;
export type V15AcceptedSemanticChange = (typeof V15_ACCEPTED_SEMANTIC_CHANGES)[number];

function normalizeJsonValue(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NON_FINITE_JSON_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeJsonValue(child)]));
  }
  return value;
}

export function serializeV15ParityJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(normalizeJsonValue(value), null, 2)}\n`, 'utf8');
}

export function sha256V15ParityBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseCanonical<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  const parsed = schema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  if (!Buffer.from(bytes).equals(serializeV15ParityJson(parsed))) throw new Error('NON_CANONICAL_JSON');
  return parsed;
}

function validateOrderedHits(hits: readonly V15ParityHit[], label: string): Map<string, V15ParityHit> {
  const byId = new Map<string, V15ParityHit>();
  for (const [index, hit] of hits.entries()) {
    if (hit.rank !== index + 1) throw new Error(`${label}:INVALID_RANK`);
    if (byId.has(hit.id)) throw new Error(`${label}:DUPLICATE_ID`);
    byId.set(hit.id, hit);
  }
  return byId;
}

function deriveComparison(
  before: readonly V15ParityHit[],
  after: readonly V15ParityHit[],
  mode: 'candidate' | 'expansion' | 'ppr',
  accepted: ReadonlySet<V15AcceptedSemanticChange>,
) {
  const beforeById = validateOrderedHits(before, `${mode}.before`);
  const afterById = validateOrderedHits(after, `${mode}.after`);
  if (beforeById.size !== afterById.size || [...beforeById.keys()].some((id) => !afterById.has(id))) {
    throw new Error(`${mode}:ID_SET_MISMATCH`);
  }
  let changedRankCount = 0;
  let maxAbsScoreDelta = 0;
  let maxRankDelta = 0;
  for (const [id, left] of beforeById) {
    const right = afterById.get(id)!;
    const scoreDelta = Math.abs(left.score - right.score);
    const rankDelta = Math.abs(left.rank - right.rank);
    maxAbsScoreDelta = Math.max(maxAbsScoreDelta, scoreDelta);
    maxRankDelta = Math.max(maxRankDelta, rankDelta);
    if (rankDelta > 0) changedRankCount += 1;
    if (mode === 'candidate' && (scoreDelta !== 0 || rankDelta !== 0)) throw new Error('candidate:PARITY_MISMATCH');
    if (mode !== 'candidate' && scoreDelta > V15_PARITY_SCORE_TOLERANCE) throw new Error(`${mode}:SCORE_MISMATCH`);
    if (mode !== 'candidate' && rankDelta > 0) {
      const change = `semantic-${mode}-tie-order` as V15AcceptedSemanticChange;
      if (!accepted.has(change)) throw new Error(`${mode}:UNACCEPTED_RANK_CHANGE`);
      const low = Math.min(left.rank, right.rank) - 1;
      const high = Math.max(left.rank, right.rank);
      if (before.slice(low, high).some((hit) => hit.score !== left.score)
        || after.slice(low, high).some((hit) => hit.score !== right.score)) {
        throw new Error(`${mode}:NON_TIE_RANK_CHANGE`);
      }
    }
  }
  if (mode === 'candidate' || mode === 'expansion' || mode === 'ppr') {
    for (let index = 1; index < after.length; index += 1) {
      const previous = after[index - 1]!;
      const current = after[index]!;
      if (compareV15ScoreThenId(previous, current) > 0) {
        throw new Error(`${mode}:INVALID_AFTER_ORDER`);
      }
    }
  }
  return {
    beforeCount: before.length,
    afterCount: after.length,
    matchedCount: before.length,
    changedRankCount,
    maxAbsScoreDelta,
    maxRankDelta,
  };
}

function deriveAssociation(
  before: readonly V15ParityAssociationRow[],
  after: readonly V15ParityAssociationRow[],
  inputs: z.infer<typeof associationComparisonSchema>['inputs'],
  accepted: ReadonlySet<V15AcceptedSemanticChange>,
): number {
  const toMap = (rows: readonly V15ParityAssociationRow[], label: string) => {
    const map = new Map<string, V15ParityAssociationRow>();
    for (const row of rows) {
      if (map.has(row.rankedResultId)) throw new Error(`${label}:DUPLICATE_ID`);
      map.set(row.rankedResultId, row);
    }
    return map;
  };
  const left = toMap(before, 'idAssociation.before');
  const right = toMap(after, 'idAssociation.after');
  const expectedRows: V15ParityAssociationRow[] = [
    ...associateV15RankedObjects(inputs.rankedNodes, inputs.passageIds, 'passage', (id) => id)
      .map(({ node, item }) => ({ rankedResultId: node.nodeId, passageIds: [item], factIds: [] })),
    ...associateV15RankedObjects(inputs.rankedNodes, inputs.factIds, 'fact', (id) => id)
      .map(({ node, item }) => ({ rankedResultId: node.nodeId, passageIds: [], factIds: [item] })),
  ];
  const expected = toMap(expectedRows, 'idAssociation.sharedHelper');
  if (left.size !== right.size || [...left.keys()].some((id) => !right.has(id))) throw new Error('idAssociation:ID_SET_MISMATCH');
  if (right.size !== expected.size || [...right].some(([id, row]) => JSON.stringify(row) !== JSON.stringify(expected.get(id)))) {
    throw new Error('idAssociation:SHARED_HELPER_MISMATCH');
  }
  let changed = 0;
  for (const [id, row] of left) {
    if (JSON.stringify(row) !== JSON.stringify(right.get(id))) changed += 1;
  }
  if (changed > 0 && !accepted.has('semantic-id-keyed-context-association')) {
    throw new Error('idAssociation:UNACCEPTED_CHANGE');
  }
  return changed;
}

function sameSummary(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deriveAndCheckArtifact(artifact: V15ParityArtifact): void {
  const accepted = new Set(artifact.acceptedSemanticChanges);
  const candidate = deriveComparison(artifact.comparisons.candidate.before, artifact.comparisons.candidate.after, 'candidate', accepted);
  const expansion = deriveComparison(artifact.comparisons.expansion.before, artifact.comparisons.expansion.after, 'expansion', accepted);
  const ppr = deriveComparison(artifact.comparisons.ppr.before, artifact.comparisons.ppr.after, 'ppr', accepted);
  const idAssociationChangedRowCount = deriveAssociation(
    artifact.comparisons.idAssociation.before,
    artifact.comparisons.idAssociation.after,
    artifact.comparisons.idAssociation.inputs,
    accepted,
  );
  if (!sameSummary(candidate, artifact.comparisons.candidate.summary)
    || !sameSummary(expansion, artifact.comparisons.expansion.summary)
    || !sameSummary(ppr, artifact.comparisons.ppr.summary)) throw new Error('DECLARED_COMPARISON_MISMATCH');
  const aggregate = {
    candidate,
    expansion,
    ppr,
    idAssociationChangedRowCount,
    maximumAbsScoreDelta: Math.max(candidate.maxAbsScoreDelta, expansion.maxAbsScoreDelta, ppr.maxAbsScoreDelta),
    maximumRankDelta: Math.max(candidate.maxRankDelta, expansion.maxRankDelta, ppr.maxRankDelta),
  };
  if (idAssociationChangedRowCount !== artifact.comparisons.idAssociation.changedRowCount
    || !sameSummary(aggregate, artifact.aggregate)) throw new Error('DECLARED_AGGREGATE_MISMATCH');
  const requiredPass = V15_REQUIRED_PARITY_CASES.every((name) => artifact.requiredCases[name]);
  const expectedVerdict = requiredPass && artifact.missingObjectAudit.missing === 0 ? 'pass' : 'fail';
  if (artifact.requiredCases['production-missing-object-zero'] !== (artifact.missingObjectAudit.missing === 0)) {
    throw new Error('MISSING_OBJECT_CASE_MISMATCH');
  }
  if (artifact.verdict !== expectedVerdict) throw new Error('DECLARED_VERDICT_MISMATCH');
}

export interface V15ParityArtifactBuildInput extends Omit<V15ParityArtifact,
  | 'schema'
  | 'generation'
  | 'canonicalSha256'
  | 'ownerManifestSha256'
  | 'vectorBlobSha256'
  | 'copyManifestSha256'
  | 'fixtureSha256'
  | 'comparisons'
  | 'aggregate'
  | 'verdict'> {
  readonly copyManifestBytes: Uint8Array;
  readonly fixtureBytes: Uint8Array;
  readonly comparisons: {
    readonly candidate: { readonly before: V15ParityHit[]; readonly after: V15ParityHit[] };
    readonly expansion: { readonly before: V15ParityHit[]; readonly after: V15ParityHit[] };
    readonly ppr: { readonly before: V15ParityHit[]; readonly after: V15ParityHit[] };
    readonly idAssociation: {
      readonly before: V15ParityAssociationRow[];
      readonly after: V15ParityAssociationRow[];
      readonly inputs: z.infer<typeof associationComparisonSchema>['inputs'];
    };
  };
}

export function buildV15ParityArtifact(input: V15ParityArtifactBuildInput): V15ParityArtifact {
  const { copyManifestBytes, fixtureBytes, ...fields } = input;
  const manifest = parseCanonical(copyManifestBytes, v15CopyManifestSchema);
  const accepted = new Set(fields.acceptedSemanticChanges);
  const candidate = deriveComparison(fields.comparisons.candidate.before, fields.comparisons.candidate.after, 'candidate', accepted);
  const expansion = deriveComparison(fields.comparisons.expansion.before, fields.comparisons.expansion.after, 'expansion', accepted);
  const ppr = deriveComparison(fields.comparisons.ppr.before, fields.comparisons.ppr.after, 'ppr', accepted);
  const idAssociationChangedRowCount = deriveAssociation(
    fields.comparisons.idAssociation.before,
    fields.comparisons.idAssociation.after,
    fields.comparisons.idAssociation.inputs,
    accepted,
  );
  const artifact = v15ParityArtifactSchema.parse({
    schema: V15_PARITY_ARTIFACT_SCHEMA,
    ...fields,
    generation: manifest.generation,
    canonicalSha256: manifest.entries[0]!.sha256,
    ownerManifestSha256: manifest.entries[1]!.sha256,
    vectorBlobSha256: manifest.entries[2]!.sha256,
    copyManifestSha256: sha256V15ParityBytes(copyManifestBytes),
    fixtureSha256: sha256V15ParityBytes(fixtureBytes),
    comparisons: {
      candidate: { ...fields.comparisons.candidate, summary: candidate },
      expansion: { ...fields.comparisons.expansion, summary: expansion },
      ppr: { ...fields.comparisons.ppr, summary: ppr },
      idAssociation: { ...fields.comparisons.idAssociation, changedRowCount: idAssociationChangedRowCount },
    },
    aggregate: {
      candidate,
      expansion,
      ppr,
      idAssociationChangedRowCount,
      maximumAbsScoreDelta: Math.max(candidate.maxAbsScoreDelta, expansion.maxAbsScoreDelta, ppr.maxAbsScoreDelta),
      maximumRankDelta: Math.max(candidate.maxRankDelta, expansion.maxRankDelta, ppr.maxRankDelta),
    },
    verdict: V15_REQUIRED_PARITY_CASES.every((name) => fields.requiredCases[name])
      && fields.missingObjectAudit.missing === 0 ? 'pass' : 'fail',
  });
  deriveAndCheckArtifact(artifact);
  return artifact;
}

export function checkV15ParityArtifact(
  artifactBytes: Uint8Array,
  copyManifestBytes: Uint8Array,
  fixtureBytes: Uint8Array,
): V15ParityArtifact {
  const artifact = parseCanonical(artifactBytes, v15ParityArtifactSchema);
  const manifest = parseCanonical(copyManifestBytes, v15CopyManifestSchema);
  if (artifact.copyManifestSha256 !== sha256V15ParityBytes(copyManifestBytes)
    || artifact.fixtureSha256 !== sha256V15ParityBytes(fixtureBytes)) throw new Error('BYTE_AUTHORITY_MISMATCH');
  if (artifact.generation !== manifest.generation
    || artifact.canonicalSha256 !== manifest.entries[0]!.sha256
    || artifact.ownerManifestSha256 !== manifest.entries[1]!.sha256
    || artifact.vectorBlobSha256 !== manifest.entries[2]!.sha256) throw new Error('COPY_MANIFEST_BINDING_MISMATCH');
  deriveAndCheckArtifact(artifact);
  return artifact;
}

export function projectV15ParityAttestation(
  artifactBytes: Uint8Array,
  copyManifestBytes: Uint8Array,
  fixtureBytes: Uint8Array,
): V15ParityAttestation {
  const artifact = checkV15ParityArtifact(artifactBytes, copyManifestBytes, fixtureBytes);
  return v15ParityAttestationSchema.parse({
    schema: V15_PARITY_ATTESTATION_SCHEMA,
    detailedArtifactSha256: sha256V15ParityBytes(artifactBytes),
    evaluatedSources: {
      evaluatedSynapseBaseCommit: artifact.evaluatedSources.evaluatedSynapseBaseCommit,
      evaluatedSynapseBaseTreeDigest: artifact.evaluatedSources.evaluatedSynapseBaseTreeDigest,
      evaluatedSynapseCandidateCommit: artifact.evaluatedSources.evaluatedSynapseCandidateCommit,
      evaluatedSynapseCandidateTreeDigest: artifact.evaluatedSources.evaluatedSynapseCandidateTreeDigest,
      evaluatedGraphDbCommit: artifact.evaluatedSources.evaluatedGraphDbCommit,
      evaluatedGraphDbTreeDigest: artifact.evaluatedSources.evaluatedGraphDbTreeDigest,
    },
    publicManifests: artifact.publicManifests,
    requiredCases: artifact.requiredCases,
    aggregate: artifact.aggregate,
    acceptedSemanticChanges: artifact.acceptedSemanticChanges,
    verdict: artifact.verdict,
  });
}

export function checkV15ParityAttestation(attestationBytes: Uint8Array): V15ParityAttestation {
  const attestation = parseCanonical(attestationBytes, v15ParityAttestationSchema);
  const expectedVerdict = V15_REQUIRED_PARITY_CASES.every((name) => attestation.requiredCases[name])
    ? 'pass'
    : 'fail';
  if (attestation.verdict !== expectedVerdict) throw new Error('DECLARED_VERDICT_MISMATCH');
  if (new Set(attestation.acceptedSemanticChanges).size !== attestation.acceptedSemanticChanges.length) {
    throw new Error('DUPLICATE_SEMANTIC_CHANGE');
  }
  for (const [name, summary] of Object.entries({
    candidate: attestation.aggregate.candidate,
    expansion: attestation.aggregate.expansion,
    ppr: attestation.aggregate.ppr,
  })) {
    if (summary.beforeCount !== summary.afterCount || summary.matchedCount !== summary.beforeCount
      || summary.changedRankCount > summary.matchedCount) throw new Error(`${name}:INVALID_PUBLIC_SUMMARY`);
    if (summary.matchedCount === 0 && (summary.changedRankCount !== 0
      || summary.maxAbsScoreDelta !== 0 || summary.maxRankDelta !== 0)) {
      throw new Error(`${name}:INVALID_PUBLIC_SUMMARY`);
    }
    if ((summary.changedRankCount === 0) !== (summary.maxRankDelta === 0)
      || summary.maxRankDelta > Math.max(0, summary.matchedCount - 1)) {
      throw new Error(`${name}:INVALID_PUBLIC_SUMMARY`);
    }
  }
  if (attestation.aggregate.candidate.changedRankCount !== 0
    || attestation.aggregate.candidate.maxAbsScoreDelta !== 0
    || attestation.aggregate.candidate.maxRankDelta !== 0) throw new Error('candidate:INVALID_PUBLIC_SUMMARY');
  if (attestation.aggregate.expansion.maxAbsScoreDelta > V15_PARITY_SCORE_TOLERANCE
    || attestation.aggregate.ppr.maxAbsScoreDelta > V15_PARITY_SCORE_TOLERANCE) {
    throw new Error('INVALID_PUBLIC_SCORE_DELTA');
  }
  if (attestation.aggregate.expansion.changedRankCount > 0
    && !attestation.acceptedSemanticChanges.includes('semantic-expansion-tie-order')) {
    throw new Error('expansion:UNACCEPTED_PUBLIC_RANK_CHANGE');
  }
  if (attestation.aggregate.ppr.changedRankCount > 0
    && !attestation.acceptedSemanticChanges.includes('semantic-ppr-tie-order')) {
    throw new Error('ppr:UNACCEPTED_PUBLIC_RANK_CHANGE');
  }
  if (attestation.aggregate.idAssociationChangedRowCount > 0
    && !attestation.acceptedSemanticChanges.includes('semantic-id-keyed-context-association')) {
    throw new Error('idAssociation:UNACCEPTED_PUBLIC_CHANGE');
  }
  const expectedMaxScore = Math.max(
    attestation.aggregate.candidate.maxAbsScoreDelta,
    attestation.aggregate.expansion.maxAbsScoreDelta,
    attestation.aggregate.ppr.maxAbsScoreDelta,
  );
  const expectedMaxRank = Math.max(
    attestation.aggregate.candidate.maxRankDelta,
    attestation.aggregate.expansion.maxRankDelta,
    attestation.aggregate.ppr.maxRankDelta,
  );
  if (attestation.aggregate.maximumAbsScoreDelta !== expectedMaxScore
    || attestation.aggregate.maximumRankDelta !== expectedMaxRank) {
    throw new Error('INVALID_PUBLIC_AGGREGATE');
  }
  return attestation;
}
