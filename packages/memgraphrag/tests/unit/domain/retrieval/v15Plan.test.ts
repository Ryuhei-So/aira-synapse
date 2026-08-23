import { describe, expect, it } from 'vitest';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import { V15_QUERY_FEATURE_SUPPORT, type QueryFeatureFlags } from '../../../../src/domain/config/featureFlags.js';
import { isComparisonQuery } from '../../../../src/application/query/comparisonDetector.js';
import type { FilteredMemoryCandidates, QueryRequest } from '../../../../src/domain/retrieval/memoryFilter.js';
import type { RankedNode, TransitionEntry } from '../../../../src/domain/retrieval/ppr.js';
import {
  assertV15FeatureProfile,
  associateV15RankedFacts,
  associateV15RankedPassages,
  associateV15RankedSchemas,
  buildV15FactExpansionPlan,
  buildV15InitialVector,
  buildV15PprMaterializationPlan,
  buildV15RetrievalRequestPlan,
  compareV15Transitions,
  isV15RetrievalPlan,
  normalizeV15Entity,
  orderV15RankedNodes,
  orderV15ScoreThenId,
  orderV15Transitions,
  unsupportedV15Features,
  validateV15RetrievalPlan,
  validateV15FactExpansionPlan,
  V15_ENTITY_NORMALIZATION_DIGEST,
  V15RetrievalPlanValidationError,
} from '../../../../src/domain/retrieval/v15Plan.js';

const flags: QueryFeatureFlags = {
  enableDictionaryInjection: false,
  enableThesaurusExpansion: false,
  enableHypernymExpansion: false,
  enableAliasHints: false,
  enableSubQueryDecomposition: false,
  enableComparisonVerification: false,
  enableMultiHopReasoning: false,
};

const query: QueryRequest = {
  corpusId: 'corpus-1',
  text: 'Which entity is larger?',
  topK: 3,
  topM: 2,
  threshold: -0.25,
  contextTokenLimit: 512,
};

const factA = makeFact('fact-a', 'Alpha', 'relates', 'Beta');
const factB = makeFact('fact-b', 'beta', 'relates', 'Gamma');
const passageA = makePassage('passage-a', 'A');
const passageB = makePassage('passage-b', 'B');

function candidates(): FilteredMemoryCandidates {
  return {
    ontology: [],
    facts: [
      { layer: 'fact', item: factB, similarity: -0.4 },
      { layer: 'fact', item: factA, similarity: -0.2 },
    ],
    passages: [
      { layer: 'passage', item: passageA, similarity: -0.1 },
    ],
    expandedTerms: [],
    fallbackRequired: false,
    queryVector: [1, 0],
  };
}

function makePlan() {
  return buildV15RetrievalRequestPlan(
    query,
    [1, 0],
    {
      comparisonMode: true,
      featureFlags: flags,
      teleportProbability: 0.5,
      convergenceEpsilon: 1e-6,
      maxIterations: 100,
      hubDegreeThreshold: 50,
    },
  );
}

describe('V15RetrievalPlan and shared parity helpers', () => {
  it('preserves signed scores and negative thresholds while making policy explicit', () => {
    const plan = makePlan();
    const expansion = buildV15FactExpansionPlan(candidates(), true);
    const initialVector = buildV15InitialVector(
      candidates(),
      [{ factId: 'expanded', score: 0.1 }],
    );
    const ppr = buildV15PprMaterializationPlan(plan.pprPolicy, initialVector);

    expect(plan.candidateSearch.slots.map((slot) => slot.threshold)).toEqual([-0.25, -0.25, -0.25]);
    expect(plan.candidateSearch.slots.map((slot) => slot.slotId)).toEqual(['passage', 'fact', 'schema']);
    expect(ppr.seeds).toEqual([
      { nodeId: 'fact:expanded', score: 0.1 },
      { nodeId: 'fact:fact-a', score: -0.2 },
      { nodeId: 'fact:fact-b', score: -0.4 },
      { nodeId: 'passage:passage-a', score: -0.1 },
    ]);
    expect(expansion?.seedEntities).toEqual([
      { key: 'alpha', score: 0 },
      { key: 'beta', score: 0 },
      { key: 'gamma', score: 0 },
    ]);
    expect(validateV15RetrievalPlan(plan)).toBe(plan);
  });

  it('keeps expansion zero-floor, inactive facts, and deterministic score/id ties in the shared helper', () => {
    const expansion = buildV15FactExpansionPlan(candidates(), true);
    expect(expansion?.attenuation).toBe(0.3);
    expect(expansion?.limit).toBe(20);
    expect(orderV15ScoreThenId([
      { id: 'fact:z', score: 0 },
      { id: 'fact:a', score: 0 },
      { id: 'fact:b', score: -1 },
    ])).toEqual([
      { id: 'fact:a', score: 0 },
      { id: 'fact:z', score: 0 },
      { id: 'fact:b', score: -1 },
    ]);
    expect(normalizeV15Entity('ÄLPHA')).toBe('älpha');
  });

  it('uses the shared comparison authority for bounded expansion mode', () => {
    const bridgeText = 'Which method was used?';
    const comparisonText = 'Are Alpha and Beta from the same country?';
    const bridgeMode = isComparisonQuery(bridgeText);
    const comparisonMode = isComparisonQuery(comparisonText);

    expect(bridgeMode).toBe(false);
    expect(comparisonMode).toBe(true);
    expect(buildV15FactExpansionPlan(candidates(), bridgeMode)).toBeNull();
    expect(buildV15FactExpansionPlan(candidates(), comparisonMode)).not.toBeNull();
  });

  it('uses canonical graph and rank orders independent of insertion order', () => {
    const transitions: TransitionEntry[] = [
      { sourceNodeId: 'fact:z', targetNodeId: 'passage:b', weight: 1 },
      { sourceNodeId: 'fact:a', targetNodeId: 'passage:z', weight: 1 },
      { sourceNodeId: 'fact:a', targetNodeId: 'passage:a', weight: 1 },
    ];
    expect(orderV15Transitions(transitions).map((entry) => `${entry.sourceNodeId}->${entry.targetNodeId}`)).toEqual([
      'fact:a->passage:a',
      'fact:a->passage:z',
      'fact:z->passage:b',
    ]);
    expect(compareV15Transitions(transitions[2]!, transitions[1]!)).toBe(-1);
    const ranked: RankedNode[] = [
      { nodeId: 'passage:z', score: 0.5, layer: 'passage' },
      { nodeId: 'passage:a', score: 0.5, layer: 'passage' },
    ];
    expect(orderV15RankedNodes(ranked).map((node) => node.nodeId)).toEqual(['passage:a', 'passage:z']);
  });

  it('joins materialized context by IDs, never by positions, including schema prefix mapping', () => {
    const rankedPassages: RankedNode[] = [
      { nodeId: 'passage:passage-b', score: 0.9, layer: 'passage' },
      { nodeId: 'passage:passage-a', score: 0.8, layer: 'passage' },
    ];
    const passages = associateV15RankedPassages(rankedPassages, [passageA, passageB]);
    expect(passages.map((association) => [association.item.passageId, association.node.score])).toEqual([
      ['passage-b', 0.9],
      ['passage-a', 0.8],
    ]);

    const rankedFacts: RankedNode[] = [
      { nodeId: 'fact:fact-b', score: 0.7, layer: 'fact' },
      { nodeId: 'schema:schema-a', score: 0.6, layer: 'ontology' },
      { nodeId: 'fact:fact-a', score: 0.5, layer: 'fact' },
    ];
    const facts = associateV15RankedFacts(rankedFacts, [factA, factB]);
    expect(facts.map((association) => [association.item.factId, association.node.score])).toEqual([
      ['fact-b', 0.7],
      ['fact-a', 0.5],
    ]);
    const schema = makeSchema('schema-a');
    const schemas = associateV15RankedSchemas(
      [{ nodeId: 'schema:schema-a', score: 0.4, layer: 'ontology' }],
      [schema],
    );
    expect(schemas[0]?.item.schemaId).toBe('schema-a');
  });

  it('fails closed for unknown fields, unsupported profiles, missing staged values, and active flags', () => {
    const plan = makePlan();
    expect(() => validateV15RetrievalPlan({ ...plan, unknown: true })).toThrow(V15RetrievalPlanValidationError);
    expect(() => validateV15RetrievalPlan({ ...plan, profile: 'hybrid-rrf' })).toThrowError(/Unsupported v15 retrieval profile/);
    expect(isV15RetrievalPlan({ ...plan, profile: 'hybrid-rrf' })).toBe(false);
    expect(() => buildV15RetrievalRequestPlan(
      query,
      [1, 0],
      { ...makePlanOptions(), comparisonMode: false, featureFlags: { ...flags, enableThesaurusExpansion: true } },
    )).toThrowError(/enableThesaurusExpansion/);
    const unsupported = { ...flags, enableSubQueryDecomposition: true };
    expect(unsupportedV15Features(unsupported)).toEqual(['enableSubQueryDecomposition']);
    expect(() => assertV15FeatureProfile(unsupported)).toThrowError(/enableSubQueryDecomposition/);
    expect(() => validateV15RetrievalPlan({
      ...plan,
      candidateSearch: { slots: plan.candidateSearch.slots.slice(1) },
    })).toThrowError(/passage, fact, and schema/);
  });

  it('fails closed for an unregistered runtime query flag', () => {
    expect(Object.keys(V15_QUERY_FEATURE_SUPPORT).sort()).toEqual(Object.keys(flags).sort());
    const unregistered = {
      ...flags,
      enableUnregisteredFeature: true,
    } as QueryFeatureFlags & Record<string, boolean>;
    expect(() => assertV15FeatureProfile(unregistered)).toThrowError(/unknown: enableUnregisteredFeature/);
  });

  it('does not silently construct comparison expansion without the candidate stage', () => {
    expect(() => buildV15FactExpansionPlan(
      undefined as unknown as FilteredMemoryCandidates,
      true,
    )).toThrow();
  });

  it('rejects non-finite candidate and seed scores before a plan can cross the boundary', () => {
    const originalCandidates = candidates();
    const badCandidates = {
      ...originalCandidates,
      facts: originalCandidates.facts.map((candidate, index) =>
        index === 0 ? { ...candidate, similarity: Number.NaN } : candidate),
    };
    expect(() => buildV15FactExpansionPlan(badCandidates, true)).toThrowError(/must be finite/);
    expect(() => buildV15PprMaterializationPlan(
      makePlan().pprPolicy,
      { scores: { 'fact:a': Number.POSITIVE_INFINITY }, fallbackTriggered: false },
    )).toThrowError(/must be finite/);
  });

  it('requires the exact normalization digest before expansion crosses the boundary', () => {
    const expansion = buildV15FactExpansionPlan(candidates(), true)!;
    expect(expansion.normalizationContractDigest).toBe(V15_ENTITY_NORMALIZATION_DIGEST);
    expect(() => validateV15FactExpansionPlan({
      ...expansion,
      normalizationContractDigest: 'wrong-digest',
    })).toThrowError(/normalizationContractDigest/);
  });
});

function makePlanOptions() {
  return {
    featureFlags: flags,
    teleportProbability: 0.5,
    convergenceEpsilon: 1e-6,
    maxIterations: 100,
    hubDegreeThreshold: 50,
  };
}

function makeSchema(id: string): Schema {
  return {
    corpusId: 'corpus-1',
    schemaId: id,
    headType: 'Entity',
    relation: 'relates',
    tailType: 'Entity',
    canonicalKey: 'entity::relates::entity',
    aliases: [],
    frequency: 1,
    state: 'pending',
    stabilizationThreshold: 2,
    factIds: [],
    sourceDocumentIds: [],
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makePassage(id: string, text: string): Passage {
  return {
    corpusId: 'corpus-1',
    passageId: id,
    text,
    normalizedText: text.toLowerCase(),
    metadata: {
      documentId: `doc-${id}`,
      title: id,
      sourceUrl: `https://example.com/${id}`,
      language: 'en',
      sectionPath: [],
      chunkId: id,
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: text.length || 1,
    },
    factIds: [],
    entityMentions: [],
    qualityFlags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makeFact(id: string, headEntity: string, relation: string, tailEntity: string): Fact {
  return {
    corpusId: 'corpus-1',
    factId: id,
    schemaId: 'schema-1',
    headEntity,
    headType: 'Entity',
    relation,
    tailEntity,
    tailType: 'Entity',
    state: 'inactive',
    passageIds: [],
    sourceDocumentIds: [],
    confidence: 0.5,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}
