/**
 * Synapse-owned semantic shapes for bounded retrieval.
 *
 * Generation/session identity and execution telemetry are intentionally absent:
 * GraphDB composes those native-owned fields after pinning this declaration.
 */
import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { Schema } from '../memory/schema.js';
import { DOMAIN_CONTRACTS, validateDomainObject } from '../memory/domainContract.js';
import {
  arrayContract,
  booleanContract,
  externalRefContract,
  literalContract,
  numberContract,
  objectContract,
  stringContract,
  tupleContract,
  validateContractDeclaration,
  validateContractNode,
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
import {
  CANDIDATE_SEARCH_REFINEMENT_PROGRAM,
  FACT_EXPAND_REFINEMENT_PROGRAM,
  PPR_MATERIALIZE_REFINEMENT_PROGRAM,
} from './boundedRefinementPrograms.js';
import { validateRefinementProgramPointers } from './refinementCompiler.js';
import {
  evaluateRefinementProgram,
  evaluateRefinementRequest,
} from './refinementEvaluator.js';
import {
  REFINEMENT_IR_VERSION,
  REFINEMENT_NODE_DECLARATIONS,
  type RefinementProgram,
} from './refinementIr.js';
import { normalizeV15Entity, V15_ENTITY_NORMALIZATION_DIGEST } from './v15Plan.js';

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

function pinnedDomainContract(
  reference: { readonly referenceKind: string; readonly dependency: string },
): ContractNode {
  if (reference.dependency !== DOMAIN_DEPENDENCY) {
    throw new TypeError(`external reference dependency must be ${DOMAIN_DEPENDENCY}`);
  }
  const kind = reference.referenceKind as keyof typeof DOMAIN_CONTRACTS;
  if (!Object.prototype.hasOwnProperty.call(DOMAIN_CONTRACTS, kind)) {
    throw new TypeError(`unknown external reference ${reference.referenceKind}`);
  }
  return DOMAIN_CONTRACTS[kind];
}

function validatePinnedDependencies(node: ContractNode, path: string, errors: string[]): void {
  switch (node.kind) {
    case 'externalRef':
      try { pinnedDomainContract(node); } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    case 'array': validatePinnedDependencies(node.items, `${path}.items`, errors); return;
    case 'tuple': node.items.forEach((item, index) => validatePinnedDependencies(item, `${path}.items[${index}]`, errors)); return;
    case 'optional': validatePinnedDependencies(node.value, `${path}.value`, errors); return;
    case 'object': Object.entries(node.fields).forEach(([field, value]) => validatePinnedDependencies(value, `${path}.fields.${field}`, errors)); return;
    case 'discriminatedUnion': Object.entries(node.branches).forEach(([branch, value]) => validatePinnedDependencies(value, `${path}.branches.${branch}`, errors)); return;
    default: return;
  }
}

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
  slots: tupleContract(searchSlot('passage'), searchSlot('fact'), searchSlot('schema')),
});

const candidateResult = objectContract({
  slots: tupleContract(
    candidateSlotResult('passage', passageRef),
    candidateSlotResult('fact', factRef),
    candidateSlotResult('schema', schemaRef),
  ),
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
  readonly refinement: RefinementProgram;
}

export const BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS = {
  [CANDIDATE_SEARCH_BOUNDED_V1]: {
    request: candidateRequest, result: candidateResult, refinement: CANDIDATE_SEARCH_REFINEMENT_PROGRAM,
  },
  [FACT_EXPAND_BOUNDED_V1]: {
    request: factExpandRequest, result: factExpandResult, refinement: FACT_EXPAND_REFINEMENT_PROGRAM,
  },
  [PPR_MATERIALIZE_BOUNDED_V1]: {
    request: pprMaterializeRequest, result: pprMaterializeResult, refinement: PPR_MATERIALIZE_REFINEMENT_PROGRAM,
  },
} as const satisfies Readonly<Record<BoundedRetrievalOperationName, BoundedSemanticDeclaration>>;

type SemanticRequest<T> = Omit<T, 'generation'>;
type SemanticResult<T> = Omit<T, 'generation' | 'sessionId'>;
type AssertAssignable<From extends To, To> = From;
type SameKeys<Left, Right> = keyof Left extends keyof Right
  ? keyof Right extends keyof Left ? true : false
  : false;
type SameType<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
  ? (<Value>() => Value extends Right ? 1 : 2) extends
    (<Value>() => Value extends Left ? 1 : 2) ? true : false
  : false;
type NormalizeShape<Value> = Value extends readonly (infer Item)[]
  ? readonly NormalizeShape<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: NormalizeShape<Value[Key]> }
    : Value;
type SameShape<Left, Right> = SameType<NormalizeShape<Left>, NormalizeShape<Right>>;
type AssertTrue<Value extends true> = Value;
type CandidateWitness = [
  AssertAssignable<ContractValue<typeof candidateRequest>, SemanticRequest<CandidateSearchBoundedRequest>>,
  AssertAssignable<SemanticRequest<CandidateSearchBoundedRequest>, ContractValue<typeof candidateRequest>>,
  AssertAssignable<ContractValue<typeof candidateResult>, SemanticResult<CandidateSearchBoundedResponse>>,
  AssertAssignable<SemanticResult<CandidateSearchBoundedResponse>, ContractValue<typeof candidateResult>>,
  AssertTrue<SameKeys<ContractValue<typeof candidateRequest>, SemanticRequest<CandidateSearchBoundedRequest>>>,
  AssertTrue<SameKeys<ContractValue<typeof candidateResult>, SemanticResult<CandidateSearchBoundedResponse>>>,
  AssertTrue<SameShape<ContractValue<typeof candidateRequest>, SemanticRequest<CandidateSearchBoundedRequest>>>,
  AssertTrue<SameShape<ContractValue<typeof candidateResult>, SemanticResult<CandidateSearchBoundedResponse>>>,
];
type FactExpandWitness = [
  AssertAssignable<ContractValue<typeof factExpandRequest>, SemanticRequest<FactExpandBoundedRequest>>,
  AssertAssignable<SemanticRequest<FactExpandBoundedRequest>, ContractValue<typeof factExpandRequest>>,
  AssertAssignable<ContractValue<typeof factExpandResult>, SemanticResult<FactExpandBoundedResponse>>,
  AssertAssignable<SemanticResult<FactExpandBoundedResponse>, ContractValue<typeof factExpandResult>>,
  AssertTrue<SameKeys<ContractValue<typeof factExpandRequest>, SemanticRequest<FactExpandBoundedRequest>>>,
  AssertTrue<SameKeys<ContractValue<typeof factExpandResult>, SemanticResult<FactExpandBoundedResponse>>>,
  AssertTrue<SameShape<ContractValue<typeof factExpandRequest>, SemanticRequest<FactExpandBoundedRequest>>>,
  AssertTrue<SameShape<ContractValue<typeof factExpandResult>, SemanticResult<FactExpandBoundedResponse>>>,
];
type PprWitness = [
  AssertAssignable<ContractValue<typeof pprMaterializeRequest>, SemanticRequest<PprMaterializeBoundedRequest>>,
  AssertAssignable<SemanticRequest<PprMaterializeBoundedRequest>, ContractValue<typeof pprMaterializeRequest>>,
  AssertAssignable<ContractValue<typeof pprMaterializeResult>, SemanticResult<PprMaterializeBoundedResponse>>,
  AssertAssignable<SemanticResult<PprMaterializeBoundedResponse>, ContractValue<typeof pprMaterializeResult>>,
  AssertTrue<SameKeys<ContractValue<typeof pprMaterializeRequest>, SemanticRequest<PprMaterializeBoundedRequest>>>,
  AssertTrue<SameKeys<ContractValue<typeof pprMaterializeResult>, SemanticResult<PprMaterializeBoundedResponse>>>,
  AssertTrue<SameShape<ContractValue<typeof pprMaterializeRequest>, SemanticRequest<PprMaterializeBoundedRequest>>>,
  AssertTrue<SameShape<ContractValue<typeof pprMaterializeResult>, SemanticResult<PprMaterializeBoundedResponse>>>,
];
type WitnessRejectsOptionalDrift = AssertTrue<SameKeys<
  ContractValue<typeof candidateRequest>,
  SemanticRequest<CandidateSearchBoundedRequest> & { remainingBudget?: number }
> extends false ? true : false>;
type WitnessRejectsNestedOptionalDrift = AssertTrue<SameShape<
  ContractValue<typeof factExpandRequest>,
  SemanticRequest<FactExpandBoundedRequest> & {
    plan: FactExpandBoundedRequest['plan'] & { futureNested?: number };
  }
> extends false ? true : false>;
export type BoundedRetrievalStructuralTypeWitness =
  | CandidateWitness
  | FactExpandWitness
  | PprWitness
  | WitnessRejectsOptionalDrift
  | WitnessRejectsNestedOptionalDrift;

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
    const entryPrototype = Object.getPrototypeOf(declaration);
    if (entryPrototype !== Object.prototype && entryPrototype !== null) {
      errors.push(`$.${operation} must use a plain or null prototype`);
    }
    for (const key of Reflect.ownKeys(entry)) {
      if (typeof key !== 'string' || (key !== 'request' && key !== 'result' && key !== 'refinement')) {
        errors.push(`$.${operation}.${typeof key === 'symbol' ? key.toString() : key} is unknown`);
      }
    }
    for (const side of ['request', 'result'] as const) {
      if (!(side in entry)) {
        errors.push(`$.${operation}.${side} is required`);
        continue;
      }
      const validation = validateContractDeclaration(entry[side]);
      errors.push(...validation.errors.map((error) => `$.${operation}.${side}${error.slice(1)}`));
      if (validation.valid) {
        validatePinnedDependencies(
          entry[side] as ContractNode,
          `$.${operation}.${side}`,
          errors,
        );
      }
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'refinement')) {
      errors.push(`$.${operation}.refinement is required`);
    } else {
      const pointerValidation = validateRefinementProgramPointers(
        entry.refinement as RefinementProgram,
        {
          request: entry.request as ContractNode,
          result: entry.result as ContractNode,
          resolveExternal: pinnedDomainContract,
        },
      );
      errors.push(...pointerValidation.errors.map((error) => `$.${operation}.refinement${error.slice(1)}`));
    }
  }
  return { valid: errors.length === 0, errors };
}

export const BOUNDED_RETRIEVAL_STRUCTURAL_ARTIFACT = {
  contractVersion: BOUNDED_RETRIEVAL_CONTRACT_VERSION,
  refinementIrVersion: REFINEMENT_IR_VERSION,
  refinementNodes: REFINEMENT_NODE_DECLARATIONS,
  operations: BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
} as const;

const refinementRoots = (declaration: BoundedSemanticDeclaration) => ({
  request: declaration.request,
  result: declaration.result,
  resolveExternal: pinnedDomainContract,
});

const normalizeRefinementValue = (dependency: string, value: string): string => {
  if (dependency !== V15_ENTITY_NORMALIZATION_DIGEST) {
    throw new TypeError(`unknown normalization dependency ${dependency}`);
  }
  return normalizeV15Entity(value);
};

const validateSemanticNode = (node: ContractNode, value: unknown): ContractValidation =>
  validateContractNode(node, value, (reference, referencedValue, path, errors) => {
    try {
      pinnedDomainContract(reference);
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const kind = reference.referenceKind as keyof typeof DOMAIN_CONTRACTS;
    const validation = validateDomainObject(kind, referencedValue);
    errors.push(...validation.errors.map((error) => `${path}${error.slice(1)}`));
  });

/** Validate every request-only invariant before native work begins. */
export function validateBoundedSemanticRequest(
  operation: BoundedRetrievalOperationName,
  request: unknown,
): ContractValidation {
  const declaration = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation];
  const validation = validateSemanticNode(declaration.request, request);
  const errors = validation.errors.map((error) => `request${error.slice(1)}`);
  if (errors.length === 0) {
    try {
      evaluateRefinementRequest(
        declaration.refinement,
        request,
        refinementRoots(declaration),
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateBoundedSemanticExchange(
  operation: BoundedRetrievalOperationName,
  request: unknown,
  result: unknown,
): ContractValidation {
  const declaration = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation];
  const requestValidation = validateBoundedSemanticRequest(operation, request);
  const resultValidation = validateSemanticNode(declaration.result, result);
  const errors = [...requestValidation.errors];
  errors.push(...resultValidation.errors.map((error) => `result${error.slice(1)}`));
  if (errors.length === 0) {
    try {
      evaluateRefinementProgram(
        declaration.refinement,
        { request, result, normalize: normalizeRefinementValue },
        refinementRoots(declaration),
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { valid: errors.length === 0, errors };
}

export type BoundedRetrievalStructuralNode = ContractNode;
