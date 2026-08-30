import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { Schema } from '../memory/schema.js';
import {
  BOUNDED_RETRIEVAL_OPERATION_NAMES,
  type BoundedRetrievalOperationName,
} from './boundedContract.js';
import { V15_ENTITY_NORMALIZATION_DIGEST } from './v15Plan.js';

type SeedNamespace = 'passage' | 'fact' | 'schema';

interface DomainSeedHit {
  readonly namespace?: unknown;
  readonly item?: unknown;
}

interface DomainSeedFixture {
  readonly candidateHits?: unknown;
}

export type BoundedRetrievalExchanges = Readonly<
  Record<BoundedRetrievalOperationName, { readonly request: unknown; readonly result: unknown }>
>;

function seedItems<T>(hits: readonly DomainSeedHit[], namespace: SeedNamespace): readonly T[] {
  return hits
    .filter((hit) => hit.namespace === namespace)
    .map((hit) => hit.item as T);
}

/**
 * Project the compact portable retrieval baselines from the pinned domain fixture.
 *
 * This pure boundary is shared by artifact generation and causal projection tests;
 * semantic and structural validation remain mandatory before publication.
 */
export function projectBoundedRetrievalExchanges(domain: unknown): BoundedRetrievalExchanges {
  const candidateHits = (domain as DomainSeedFixture | null)?.candidateHits;
  if (!Array.isArray(candidateHits)) {
    throw new Error('bounded domain fixture is required to seed the retrieval fixture');
  }
  const hits = candidateHits as readonly DomainSeedHit[];
  const passageSources = seedItems<Passage>(hits, 'passage');
  const factSources = seedItems<Fact>(hits, 'fact');
  const schemaSources = seedItems<Schema>(hits, 'schema');
  if (passageSources.length < 1 || factSources.length < 2 || schemaSources.length < 1) {
    throw new Error('bounded domain fixture must provide passage, two fact, and schema seeds');
  }
  const passageSource = passageSources[0]!;
  const schemaSource = schemaSources[0]!;
  const corpusId = passageSource.corpusId;
  const projectPassage = (source: Passage, passageId: string) => ({
    corpusId: source.corpusId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    passageId,
    text: source.text,
    normalizedText: source.normalizedText,
    metadata: {
      documentId: source.metadata.documentId,
      title: source.metadata.title,
      sourceUrl: source.metadata.sourceUrl,
      language: source.metadata.language,
      sectionPath: source.metadata.sectionPath.slice(0, 1),
      chunkId: source.metadata.chunkId,
      chunkIndex: source.metadata.chunkIndex,
      offsetStart: source.metadata.offsetStart,
      offsetEnd: source.metadata.offsetEnd,
    },
    factIds: source.factIds.slice(0, 1),
    entityMentions: source.entityMentions.slice(0, 1),
    qualityFlags: source.qualityFlags.slice(0, 1),
  });
  const projectFact = (source: Fact, factId: string) => ({
    corpusId: source.corpusId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    factId,
    schemaId: source.schemaId,
    headEntity: source.headEntity,
    headType: source.headType,
    relation: source.relation,
    tailEntity: source.tailEntity,
    tailType: source.tailType,
    state: source.state,
    passageIds: source.passageIds.slice(0, 1),
    sourceDocumentIds: source.sourceDocumentIds.slice(0, 1),
    confidence: source.confidence,
  });
  const projectSchema = (source: Schema, schemaId: string) => ({
    corpusId: source.corpusId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    schemaId,
    headType: source.headType,
    relation: source.relation,
    tailType: source.tailType,
    canonicalKey: source.canonicalKey,
    aliases: source.aliases.slice(0, 1),
    frequency: source.frequency,
    state: source.state,
    stabilizationThreshold: source.stabilizationThreshold,
    factIds: source.factIds.slice(0, 1),
    sourceDocumentIds: source.sourceDocumentIds.slice(0, 1),
    version: source.version,
  });
  const passageOne = projectPassage(passageSource, 'p1');
  const passageTwo = projectPassage(passageSource, 'p2');
  const factOne = projectFact(factSources[0]!, 'f1');
  const factTwo = projectFact(factSources[1]!, 'f2');
  const schemaOne = projectSchema(schemaSource, 's1');
  const schemaTwo = projectSchema(schemaSource, 's2');
  const candidateHitsByNamespace = {
    passage: [
      { id: 'passage:p1', score: -0.1, item: passageOne },
      { id: 'passage:p2', score: -0.2, item: passageTwo },
    ],
    fact: [
      { id: 'fact:f1', score: -0.3, item: factOne },
      { id: 'fact:f2', score: -0.3, item: factTwo },
    ],
    schema: [
      { id: 'schema:s1', score: 0.4, item: schemaOne },
      { id: 'schema:s2', score: 0.2, item: schemaTwo },
    ],
  } as const;
  const boundedHits = (namespace: SeedNamespace) => candidateHitsByNamespace[namespace]
    .map(({ id, score, item }) => ({ id, score, item }));

  const exchanges = {
    [BOUNDED_RETRIEVAL_OPERATION_NAMES[0]]: {
      request: {
        corpusId,
        slots: [
          { slotId: 'passage', namespace: 'passage', queryVector: [0], threshold: -1, limit: 2 },
          { slotId: 'fact', namespace: 'fact', queryVector: [0], threshold: -1, limit: 2 },
          { slotId: 'schema', namespace: 'schema', queryVector: [0], threshold: -1, limit: 2 },
        ],
      },
      result: {
        slots: [
          { slotId: 'passage', namespace: 'passage', hits: boundedHits('passage') },
          { slotId: 'fact', namespace: 'fact', hits: boundedHits('fact') },
          { slotId: 'schema', namespace: 'schema', hits: boundedHits('schema') },
        ],
      },
    },
    [BOUNDED_RETRIEVAL_OPERATION_NAMES[1]]: {
      request: {
        corpusId,
        plan: {
          seedEntities: [{ key: 'alpha', score: 1 }, { key: 'beta', score: 0.5 }],
          excludedSeedFactIds: ['excluded'],
          attenuation: 0.3,
          limit: 2,
          normalizationContractDigest: V15_ENTITY_NORMALIZATION_DIGEST,
        },
      },
      result: {
        facts: [
          { factId: 'f1', score: 0.3, fact: factOne },
          { factId: 'f2', score: 0.3, fact: factTwo },
        ],
      },
    },
    [BOUNDED_RETRIEVAL_OPERATION_NAMES[2]]: {
      request: {
        corpusId,
        plan: {
          seeds: [{ nodeId: 'fact:f1', score: 1 }, { nodeId: 'fact:f2', score: 0.5 }],
          teleportProbability: 0.15,
          convergenceEpsilon: 0.01,
          maxIterations: 20,
          hubDegreeThreshold: 100,
          passageLimit: 2,
          entityLimit: 2,
        },
      },
      result: {
        rankedPassages: [
          { nodeId: 'passage:p1', score: 0.75, rank: 1, passage: passageOne },
          { nodeId: 'passage:p2', score: 0.5, rank: 2, passage: passageTwo },
        ],
        rankedFacts: [
          { nodeId: 'fact:f1', score: 0.5, rank: 1, fact: factOne },
          { nodeId: 'fact:f2', score: 0.5, rank: 2, fact: factTwo },
        ],
        iterations: 1,
        converged: true,
        l1Delta: 0.001,
      },
    },
  } satisfies BoundedRetrievalExchanges;

  if (Object.keys(exchanges).join('\0') !== BOUNDED_RETRIEVAL_OPERATION_NAMES.join('\0')) {
    throw new Error('fixture operation set does not match the canonical declaration');
  }
  return exchanges;
}
