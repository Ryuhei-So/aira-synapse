import { describe, expect, it } from 'vitest';
import domainFixture from '../../../fixtures/bounded-domain-fixture.json';
import { DOMAIN_CONTRACTS } from '../../../../src/domain/memory/domainContract.js';
import {
  BOUNDED_RETRIEVAL_OPERATION_NAMES,
  BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
  validateBoundedSemanticExchange,
  validateBoundedRetrievalStructuralDeclarations,
  type BoundedRetrievalOperationName,
} from '../../../../src/domain/retrieval/boundedContract.js';
import { evaluateRefinementProgram } from '../../../../src/domain/retrieval/refinementEvaluator.js';
import { normalizeV15Entity, V15_ENTITY_NORMALIZATION_DIGEST } from '../../../../src/domain/retrieval/v15Plan.js';

describe('bounded retrieval structural declaration', () => {
  it('derives the complete accepted operation set from the canonical declaration', () => {
    expect(Object.keys(BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS)).toEqual(
      BOUNDED_RETRIEVAL_OPERATION_NAMES,
    );
    expect(validateBoundedRetrievalStructuralDeclarations(
      BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
    )).toEqual({ valid: true, errors: [] });
  });

  it('fails closed when an element is added outside the canonical operation set', () => {
    const futureOperation = {
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      'future_full_snapshot@1': BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[
        BOUNDED_RETRIEVAL_OPERATION_NAMES[0]
      ],
    };
    expect(validateBoundedRetrievalStructuralDeclarations(futureOperation).valid).toBe(false);
    expect(validateBoundedRetrievalStructuralDeclarations({
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      [Symbol('hidden')]: true,
    }).valid).toBe(false);
  });

  it('fails closed when a canonical operation or one of its sides drifts', () => {
    const missing = { ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS } as Record<string, unknown>;
    delete missing[BOUNDED_RETRIEVAL_OPERATION_NAMES[1]];
    expect(validateBoundedRetrievalStructuralDeclarations(missing).valid).toBe(false);

    const operation = BOUNDED_RETRIEVAL_OPERATION_NAMES[0];
    expect(validateBoundedRetrievalStructuralDeclarations({
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      [operation]: {
        ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation],
        futureSide: { kind: 'string' },
      },
    }).valid).toBe(false);
    expect(validateBoundedRetrievalStructuralDeclarations({
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      [operation]: {
        ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation],
        [Symbol('hidden')]: true,
      },
    }).valid).toBe(false);

    const candidate = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation];
    const firstSlot = candidate.result.fields.slots.items[0];
    const hits = firstSlot.fields.hits;
    const hit = hits.items;
    expect(validateBoundedRetrievalStructuralDeclarations({
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      [operation]: {
        ...candidate,
        result: {
          ...candidate.result,
          fields: {
            ...candidate.result.fields,
            slots: {
              ...candidate.result.fields.slots,
              items: [{
                ...firstSlot,
                fields: {
                  ...firstSlot.fields,
                  hits: {
                    ...hits,
                    items: {
                      ...hit,
                      fields: {
                        ...hit.fields,
                        item: { ...hit.fields.item, dependency: 'untrusted-domain-contract@1' },
                      },
                    },
                  },
                },
              }, ...candidate.result.fields.slots.items.slice(1)],
            },
          },
        },
      },
    }).valid).toBe(false);
  });

  it('executes all three canonical refinement programs against bounded fixtures', () => {
    const roots = (operation: keyof typeof BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS) => ({
      request: BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation].request,
      result: BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation].result,
      resolveExternal: (reference: { readonly referenceKind: string }) => DOMAIN_CONTRACTS[
        reference.referenceKind as keyof typeof DOMAIN_CONTRACTS
      ],
    });
    const context = (request: unknown, result: unknown) => ({
      request,
      result,
      normalize: (dependency: string, value: string) => {
        if (dependency !== V15_ENTITY_NORMALIZATION_DIGEST) throw new Error('wrong normalization dependency');
        return normalizeV15Entity(value);
      },
    });
    const hits = domainFixture.candidateHits;
    const boundedHits = (namespace: 'passage' | 'fact' | 'schema') => hits
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
    const candidate = BOUNDED_RETRIEVAL_OPERATION_NAMES[0];
    expect(() => evaluateRefinementProgram(
      BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[candidate].refinement,
      context(candidateRequest, candidateResult),
      roots(candidate),
    )).not.toThrow();

    const factItem = hits.find((hit) => hit.id === 'fact:fixture-fact-inactive')!.item;
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
    const factResult = { facts: [{ factId: 'fixture-fact-inactive', score: 0.3, fact: factItem }] };
    const fact = BOUNDED_RETRIEVAL_OPERATION_NAMES[1];
    expect(() => evaluateRefinementProgram(
      BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[fact].refinement,
      context(factRequest, factResult),
      roots(fact),
    )).not.toThrow();

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
      ...domainFixture.pprMaterialization,
      iterations: 1,
      converged: true,
      l1Delta: 0.001,
    };
    const ppr = BOUNDED_RETRIEVAL_OPERATION_NAMES[2];
    expect(() => evaluateRefinementProgram(
      BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[ppr].refinement,
      context(pprRequest, pprResult),
      roots(ppr),
    )).not.toThrow();

    const validExchangesByOperation = {
      [candidate]: { request: candidateRequest, result: candidateResult },
      [fact]: { request: factRequest, result: factResult },
      [ppr]: { request: pprRequest, result: pprResult },
    } satisfies Record<
      BoundedRetrievalOperationName,
      { readonly request: unknown; readonly result: unknown }
    >;
    expect(Object.keys(validExchangesByOperation)).toEqual(BOUNDED_RETRIEVAL_OPERATION_NAMES);
    for (const operation of BOUNDED_RETRIEVAL_OPERATION_NAMES) {
      const valid = validExchangesByOperation[operation];
      expect(
        validateBoundedSemanticExchange(operation, valid.request, valid.result),
        `${operation} mutation baseline must be a valid runtime exchange`,
      ).toEqual({ valid: true, errors: [] });
    }

    type SemanticMutation = {
      readonly rule: string;
      readonly exchange: () => { readonly request: unknown; readonly result: unknown };
    };
    const invalidExchangesByOperation = {
      [candidate]: [
        { rule: 'non-empty corpus', exchange: () => ({ request: { ...candidateRequest, corpusId: '' }, result: candidateResult }) },
        { rule: 'non-empty query vector', exchange: () => ({
          request: { ...candidateRequest, slots: candidateRequest.slots.map((slot, index) => index === 0 ? { ...slot, queryVector: [] } : slot) }, result: candidateResult,
        }) },
        { rule: 'threshold range', exchange: () => ({
          request: { ...candidateRequest, slots: candidateRequest.slots.map((slot, index) => index === 0 ? { ...slot, threshold: 2 } : slot) }, result: candidateResult,
        }) },
        { rule: 'positive result limit', exchange: () => ({
          request: { ...candidateRequest, slots: candidateRequest.slots.map((slot, index) => index === 0 ? { ...slot, limit: 0 } : slot) }, result: candidateResult,
        }) },
        { rule: 'hit identity', exchange: () => ({ request: candidateRequest, result: {
          ...candidateResult,
          slots: candidateResult.slots.map((slot, index) => index === 0
            ? { ...slot, hits: slot.hits.map((hit) => ({ ...hit, id: 'passage:not-the-item' })) } : slot),
        } }) },
        { rule: 'hit corpus', exchange: () => ({ request: candidateRequest, result: {
          ...candidateResult,
          slots: candidateResult.slots.map((slot, index) => index === 0
            ? { ...slot, hits: slot.hits.map((hit) => ({ ...hit, item: { ...hit.item, corpusId: 'other' } })) } : slot),
        } }) },
        { rule: 'threshold applied to result', exchange: () => ({
          request: { ...candidateRequest, slots: candidateRequest.slots.map((slot, index) => index === 0 ? { ...slot, threshold: 0 } : slot) }, result: candidateResult,
        }) },
        { rule: 'response length limit', exchange: () => ({ request: {
          ...candidateRequest,
          slots: candidateRequest.slots.map((slot, index) => index === 0 ? { ...slot, limit: 1 } : slot),
        }, result: {
          ...candidateResult,
          slots: candidateResult.slots.map((slot, index) => index === 0 ? { ...slot, hits: [
            slot.hits[0],
            { ...slot.hits[0], id: 'passage:second', score: -0.25, item: { ...slot.hits[0]!.item, passageId: 'second' } },
          ] } : slot),
        } }) },
        { rule: 'explicit result score range', exchange: () => ({ request: candidateRequest, result: {
          ...candidateResult,
          slots: candidateResult.slots.map((slot, index) => index === 0 ? { ...slot, hits: slot.hits.map((hit) => ({ ...hit, score: 2 })) } : slot),
        } }) },
        { rule: 'unique hit id', exchange: () => ({ request: candidateRequest, result: {
          ...candidateResult,
          slots: candidateResult.slots.map((slot, index) => index === 0 ? { ...slot, hits: [slot.hits[0], slot.hits[0]] } : slot),
        } }) },
        { rule: 'score-desc id-asc order', exchange: () => ({ request: candidateRequest, result: {
          ...candidateResult,
          slots: candidateResult.slots.map((slot, index) => index === 1 ? { ...slot, hits: [...slot.hits].reverse() } : slot),
        } }) },
      ],
      [fact]: [
        { rule: 'non-empty corpus', exchange: () => ({ request: { ...factRequest, corpusId: '' }, result: factResult }) },
        { rule: 'unique seed key', exchange: () => ({ request: { ...factRequest, plan: { ...factRequest.plan, seedEntities: [{ key: 'alpha', score: 1 }, { key: 'alpha', score: 0.5 }] } }, result: factResult }) },
        { rule: 'non-empty seed key', exchange: () => ({ request: { ...factRequest, plan: { ...factRequest.plan, seedEntities: [{ key: '', score: 1 }] } }, result: factResult }) },
        { rule: 'non-negative seed score', exchange: () => ({ request: { ...factRequest, plan: { ...factRequest.plan, seedEntities: [{ key: 'alpha', score: -1 }] } }, result: factResult }) },
        { rule: 'non-empty excluded id', exchange: () => ({ request: { ...factRequest, plan: { ...factRequest.plan, excludedSeedFactIds: [''] } }, result: factResult }) },
        { rule: 'non-negative attenuation', exchange: () => ({ request: { ...factRequest, plan: { ...factRequest.plan, attenuation: -1 } }, result: factResult }) },
        { rule: 'positive result limit', exchange: () => ({ request: { ...factRequest, plan: { ...factRequest.plan, limit: 0 } }, result: factResult }) },
        { rule: 'normalization dependency', exchange: () => ({ request: { ...factRequest, plan: { ...factRequest.plan, normalizationContractDigest: 'wrong' } }, result: factResult }) },
        { rule: 'fact identity', exchange: () => ({ request: factRequest, result: { facts: [{ ...factResult.facts[0], factId: 'wrong' }] } }) },
        { rule: 'fact corpus', exchange: () => ({ request: factRequest, result: { facts: [{ ...factResult.facts[0], fact: { ...factItem, corpusId: 'other' } }] } }) },
        { rule: 'seed exclusion', exchange: () => ({ request: { ...factRequest, plan: { ...factRequest.plan, excludedSeedFactIds: ['fixture-fact-inactive'] } }, result: factResult }) },
        { rule: 'seed match required', exchange: () => ({ request: { ...factRequest, plan: { ...factRequest.plan, seedEntities: [{ key: 'gamma', score: 1 }] } }, result: factResult }) },
        { rule: 'exact expansion score', exchange: () => ({ request: factRequest, result: { facts: [{ ...factResult.facts[0], score: 0.2 }] } }) },
        { rule: 'response length limit', exchange: () => ({ request: { ...factRequest, plan: { ...factRequest.plan, limit: 1 } }, result: { facts: [
          factResult.facts[0],
          { factId: 'fixture-fact-tie', score: 0.3, fact: hits.find((hit) => hit.id === 'fact:fixture-fact-tie')!.item },
        ] } }) },
        { rule: 'unique fact id', exchange: () => ({ request: factRequest, result: { facts: [factResult.facts[0], factResult.facts[0]] } }) },
        { rule: 'score-desc id-asc order', exchange: () => ({ request: factRequest, result: { facts: [
          { factId: 'fixture-fact-tie', score: 0.3, fact: hits.find((hit) => hit.id === 'fact:fixture-fact-tie')!.item },
          factResult.facts[0],
        ] } }) },
      ],
      [ppr]: [
        { rule: 'non-empty corpus', exchange: () => ({ request: { ...pprRequest, corpusId: '' }, result: pprResult }) },
        { rule: 'unique seed node', exchange: () => ({ request: { ...pprRequest, plan: { ...pprRequest.plan, seeds: [pprRequest.plan.seeds[0], pprRequest.plan.seeds[0]] } }, result: pprResult }) },
        { rule: 'non-empty seed node', exchange: () => ({ request: { ...pprRequest, plan: { ...pprRequest.plan, seeds: [{ nodeId: '', score: 1 }] } }, result: pprResult }) },
        { rule: 'teleport range', exchange: () => ({ request: { ...pprRequest, plan: { ...pprRequest.plan, teleportProbability: 2 } }, result: pprResult }) },
        { rule: 'positive convergence epsilon', exchange: () => ({ request: { ...pprRequest, plan: { ...pprRequest.plan, convergenceEpsilon: 0 } }, result: pprResult }) },
        { rule: 'positive max iterations', exchange: () => ({ request: { ...pprRequest, plan: { ...pprRequest.plan, maxIterations: 0 } }, result: pprResult }) },
        { rule: 'non-negative hub threshold', exchange: () => ({ request: { ...pprRequest, plan: { ...pprRequest.plan, hubDegreeThreshold: -1 } }, result: pprResult }) },
        { rule: 'positive passage limit', exchange: () => ({ request: { ...pprRequest, plan: { ...pprRequest.plan, passageLimit: 0 } }, result: pprResult }) },
        { rule: 'positive entity limit', exchange: () => ({ request: { ...pprRequest, plan: { ...pprRequest.plan, entityLimit: 0 } }, result: pprResult }) },
        { rule: 'passage response length limit', exchange: () => ({ request: {
          ...pprRequest,
          plan: { ...pprRequest.plan, passageLimit: 1 },
        }, result: { ...pprResult, rankedPassages: [
          pprResult.rankedPassages[0],
          { ...pprResult.rankedPassages[0], nodeId: 'passage:second', score: 0.5, rank: 2, passage: { ...pprResult.rankedPassages[0]!.passage, passageId: 'second' } },
        ] } }) },
        { rule: 'entity response length limit', exchange: () => ({ request: { ...pprRequest, plan: { ...pprRequest.plan, entityLimit: 1 } }, result: pprResult }) },
        { rule: 'node identity', exchange: () => ({ request: pprRequest, result: { ...pprResult, rankedPassages: pprResult.rankedPassages.map((entry) => ({ ...entry, nodeId: 'passage:wrong' })) } }) },
        { rule: 'node corpus', exchange: () => ({ request: pprRequest, result: { ...pprResult, rankedPassages: pprResult.rankedPassages.map((entry) => ({ ...entry, passage: { ...entry.passage, corpusId: 'other' } })) } }) },
        { rule: 'rank is index plus one', exchange: () => ({ request: pprRequest, result: { ...pprResult, rankedPassages: pprResult.rankedPassages.map((entry) => ({ ...entry, rank: 2 })) } }) },
        { rule: 'unique ranked node id', exchange: () => ({ request: pprRequest, result: { ...pprResult, rankedFacts: pprResult.rankedFacts.map((entry, index) => index === 1 ? {
          ...entry,
          nodeId: pprResult.rankedFacts[0]!.nodeId,
          fact: pprResult.rankedFacts[0]!.fact,
        } : entry) } }) },
        { rule: 'score-desc id-asc order', exchange: () => ({ request: pprRequest, result: { ...pprResult, rankedFacts: [...pprResult.rankedFacts].reverse() } }) },
        { rule: 'iterations bounded', exchange: () => ({ request: pprRequest, result: { ...pprResult, iterations: 21 } }) },
        { rule: 'non-negative delta', exchange: () => ({ request: pprRequest, result: { ...pprResult, l1Delta: -1 } }) },
        { rule: 'convergence matches delta', exchange: () => ({ request: pprRequest, result: { ...pprResult, converged: false, iterations: 20 } }) },
        { rule: 'non-convergence exhausts iterations', exchange: () => ({ request: pprRequest, result: { ...pprResult, converged: false, l1Delta: 0.1 } }) },
        { rule: 'zero iterations has empty converged result', exchange: () => ({ request: pprRequest, result: { ...pprResult, iterations: 0, l1Delta: 0 } }) },
      ],
    } satisfies Record<
      BoundedRetrievalOperationName,
      readonly SemanticMutation[]
    >;
    expect(Object.keys(invalidExchangesByOperation)).toEqual(BOUNDED_RETRIEVAL_OPERATION_NAMES);
    for (const operation of BOUNDED_RETRIEVAL_OPERATION_NAMES) {
      for (const mutation of invalidExchangesByOperation[operation]) {
        const invalid = mutation.exchange();
        expect(
          validateBoundedSemanticExchange(operation, invalid.request, invalid.result).valid,
          `${operation} must fail closed for ${mutation.rule}`,
        ).toBe(false);
      }
    }
  });
});
