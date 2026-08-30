/**
 * Synapse-owned semantic shapes for bounded retrieval.
 *
 * Generation/session identity and execution telemetry are intentionally absent:
 * GraphDB composes those native-owned fields after pinning this declaration.
 */
import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { Schema } from '../memory/schema.js';
import {
  arrayContract,
  booleanContract,
  externalRefContract,
  literalContract,
  numberContract,
  objectContract,
  stringContract,
  validateContractDeclaration,
  type ContractNode,
  type ContractValue,
  type ContractValidation,
  type ObjectContract,
} from '../contract/structural.js';
import type {
  CandidateSearchBoundedRequest,
  CandidateSearchBoundedResponse,
  FactExpandBoundedRequest,
  FactExpandBoundedResponse,
  PprMaterializeBoundedRequest,
  PprMaterializeBoundedResponse,
} from './bounded.js';

export const BOUNDED_RETRIEVAL_CONTRACT_VERSION = 'aira-synapse-bounded-retrieval-contract@1' as const;
export const CANDIDATE_SEARCH_BOUNDED_V1 = 'candidate_search_bounded@1' as const;
export const FACT_EXPAND_BOUNDED_V1 = 'fact_expand_bounded@1' as const;
export const PPR_MATERIALIZE_BOUNDED_V1 = 'ppr_materialize_bounded@1' as const;

export const BOUNDED_RETRIEVAL_OPERATION_NAMES = [
  CANDIDATE_SEARCH_BOUNDED_V1,
  FACT_EXPAND_BOUNDED_V1,
  PPR_MATERIALIZE_BOUNDED_V1,
] as const;
export type BoundedRetrievalOperationName = typeof BOUNDED_RETRIEVAL_OPERATION_NAMES[number];

const DOMAIN_DEPENDENCY = 'aira-synapse-domain-contract@1' as const;
const passageRef = externalRefContract<'passage', Passage>('passage', DOMAIN_DEPENDENCY);
const factRef = externalRefContract<'fact', Fact>('fact', DOMAIN_DEPENDENCY);
const schemaRef = externalRefContract<'schema', Schema>('schema', DOMAIN_DEPENDENCY);

const searchSlot = <const Kind extends 'passage' | 'fact' | 'schema'>(kind: Kind) => objectContract({
  slotId: literalContract(kind),
  namespace: literalContract(kind),
  queryVector: arrayContract(numberContract()),
  threshold: numberContract(),
  limit: numberContract(),
});

const candidateHit = <const Kind extends 'passage' | 'fact' | 'schema', Item>(
  item: ReturnType<typeof externalRefContract<Kind, Item>>,
) => objectContract({
  id: stringContract(),
  score: numberContract(),
  item,
});

const candidateSlotResult = <
  const Kind extends 'passage' | 'fact' | 'schema',
  Item,
>(kind: Kind, item: ReturnType<typeof externalRefContract<Kind, Item>>) => objectContract({
  slotId: literalContract(kind),
  namespace: literalContract(kind),
  hits: arrayContract(candidateHit(item)),
});

const candidateRequest = objectContract({
  corpusId: stringContract(),
  slots: arrayContract({
    kind: 'discriminatedUnion',
    discriminator: 'slotId',
    branches: {
      passage: searchSlot('passage'),
      fact: searchSlot('fact'),
      schema: searchSlot('schema'),
    },
  } as const),
});

const candidateResult = objectContract({
  slots: arrayContract({
    kind: 'discriminatedUnion',
    discriminator: 'slotId',
    branches: {
      passage: candidateSlotResult('passage', passageRef),
      fact: candidateSlotResult('fact', factRef),
      schema: candidateSlotResult('schema', schemaRef),
    },
  } as const),
});

const entitySeed = objectContract({ key: stringContract(), score: numberContract() });
const factExpandRequest = objectContract({
  corpusId: stringContract(),
  plan: objectContract({
    seedEntities: arrayContract(entitySeed),
    excludedSeedFactIds: arrayContract(stringContract()),
    attenuation: numberContract(),
    limit: numberContract(),
    normalizationContractDigest: stringContract(),
  }),
});
const factExpandResult = objectContract({
  facts: arrayContract(objectContract({
    factId: stringContract(),
    score: numberContract(),
    fact: factRef,
  })),
});

const pprSeed = objectContract({ nodeId: stringContract(), score: numberContract() });
const pprMaterializeRequest = objectContract({
  corpusId: stringContract(),
  plan: objectContract({
    seeds: arrayContract(pprSeed),
    teleportProbability: numberContract(),
    convergenceEpsilon: numberContract(),
    maxIterations: numberContract(),
    hubDegreeThreshold: numberContract(),
    passageLimit: numberContract(),
    entityLimit: numberContract(),
  }),
});
const pprMaterializeResult = objectContract({
  rankedPassages: arrayContract(objectContract({
    nodeId: stringContract(),
    score: numberContract(),
    rank: numberContract(),
    passage: passageRef,
  })),
  rankedFacts: arrayContract(objectContract({
    nodeId: stringContract(),
    score: numberContract(),
    rank: numberContract(),
    fact: factRef,
  })),
  iterations: numberContract(),
  converged: booleanContract(),
  l1Delta: numberContract(),
});

export interface BoundedSemanticDeclaration<
  Request extends ObjectContract = ObjectContract,
  Result extends ObjectContract = ObjectContract,
> {
  readonly request: Request;
  readonly result: Result;
}

export const BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS = {
  [CANDIDATE_SEARCH_BOUNDED_V1]: { request: candidateRequest, result: candidateResult },
  [FACT_EXPAND_BOUNDED_V1]: { request: factExpandRequest, result: factExpandResult },
  [PPR_MATERIALIZE_BOUNDED_V1]: { request: pprMaterializeRequest, result: pprMaterializeResult },
} as const satisfies Readonly<Record<BoundedRetrievalOperationName, BoundedSemanticDeclaration>>;

type SemanticRequest<T> = Omit<T, 'generation'>;
type SemanticResult<T> = Omit<T, 'generation' | 'sessionId'>;
type AssertAssignable<From extends To, To> = From;
type CandidateWitness = [
  AssertAssignable<ContractValue<typeof candidateRequest>, SemanticRequest<CandidateSearchBoundedRequest>>,
  AssertAssignable<SemanticRequest<CandidateSearchBoundedRequest>, ContractValue<typeof candidateRequest>>,
  AssertAssignable<ContractValue<typeof candidateResult>, SemanticResult<CandidateSearchBoundedResponse>>,
  AssertAssignable<SemanticResult<CandidateSearchBoundedResponse>, ContractValue<typeof candidateResult>>,
];
type FactExpandWitness = [
  AssertAssignable<ContractValue<typeof factExpandRequest>, SemanticRequest<FactExpandBoundedRequest>>,
  AssertAssignable<SemanticRequest<FactExpandBoundedRequest>, ContractValue<typeof factExpandRequest>>,
  AssertAssignable<ContractValue<typeof factExpandResult>, SemanticResult<FactExpandBoundedResponse>>,
  AssertAssignable<SemanticResult<FactExpandBoundedResponse>, ContractValue<typeof factExpandResult>>,
];
type PprWitness = [
  AssertAssignable<ContractValue<typeof pprMaterializeRequest>, SemanticRequest<PprMaterializeBoundedRequest>>,
  AssertAssignable<SemanticRequest<PprMaterializeBoundedRequest>, ContractValue<typeof pprMaterializeRequest>>,
  AssertAssignable<ContractValue<typeof pprMaterializeResult>, SemanticResult<PprMaterializeBoundedResponse>>,
  AssertAssignable<SemanticResult<PprMaterializeBoundedResponse>, ContractValue<typeof pprMaterializeResult>>,
];
export type BoundedRetrievalStructuralTypeWitness = CandidateWitness | FactExpandWitness | PprWitness;

/** Reject an operation added outside the canonical three-operation declaration. */
export function validateBoundedRetrievalStructuralDeclarations(value: unknown): ContractValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: ['$ must be an object'] };
  }
  const record = value as Record<string, unknown>;
  const expected = new Set<string>(BOUNDED_RETRIEVAL_OPERATION_NAMES);
  const prototype = Object.getPrototypeOf(value);
  const errors = prototype === Object.prototype || prototype === null
    ? []
    : ['$ must use a plain or null prototype'];
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      errors.push(`$.${typeof key === 'symbol' ? key.toString() : key} is an unknown operation`);
    }
  }
  for (const operation of BOUNDED_RETRIEVAL_OPERATION_NAMES) {
    const declaration = record[operation];
    if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
      errors.push(`$.${operation} is required`);
      continue;
    }
    const entry = declaration as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== 'request' && key !== 'result') errors.push(`$.${operation}.${key} is unknown`);
    }
    for (const side of ['request', 'result'] as const) {
      if (!(side in entry)) {
        errors.push(`$.${operation}.${side} is required`);
        continue;
      }
      const validation = validateContractDeclaration(entry[side]);
      errors.push(...validation.errors.map((error) => `$.${operation}.${side}${error.slice(1)}`));
    }
  }
  return { valid: errors.length === 0, errors };
}

export const BOUNDED_RETRIEVAL_STRUCTURAL_ARTIFACT = {
  contractVersion: BOUNDED_RETRIEVAL_CONTRACT_VERSION,
  operations: BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
} as const;

export type BoundedRetrievalStructuralNode = ContractNode;
