import { V15_ENTITY_NORMALIZATION_DIGEST } from './v15Plan.js';
import {
  REFINEMENT_IR_VERSION,
  type RefinementNode,
  type RefinementOpcode,
  type RefinementProgram,
} from './refinementIr.js';

const node = (op: RefinementOpcode, fields: Record<string, unknown>): RefinementNode => ({ op, ...fields });
const literal = (value: string | number | boolean | null) => node('literal', { value });
const pointer = (root: 'request' | 'result', path: string) => node('pointer', { root, path });
const iteration = (scope: string, path: string) => node('iteration_pointer', { scope, path });
const unary = (op: 'not' | 'array_length', value: RefinementNode) => node(op, { value });
const binary = (op: 'eq' | 'lt' | 'lte' | 'multiply', left: RefinementNode, right: RefinementNode) => node(op, { left, right });
const list = (op: 'all' | 'any' | 'max' | 'coalesce', values: readonly RefinementNode[]) => node(op, { values });
const assertTrue = (value: RefinementNode) => node('field_eq_ref', { value, expected: literal(true) });
const safeInteger = (value: RefinementNode, minimum: number, maximum: RefinementNode) => node('safe_integer_range', {
  value, minimum, maximum,
});
const finiteRange = (value: RefinementNode, minimum: number, maximum: number) => node('finite_range', {
  value, minimum, maximum,
});
const unique = (collection: RefinementNode, scope: string, key: RefinementNode) => node('unique_by', {
  collection, scope, key,
});
const ordered = (collection: RefinementNode, scope: string, score: RefinementNode, id: RefinementNode) => node(
  'ordered_score_desc_id_asc',
  { collection, scope, score, id, idOrder: 'unicode_utf16_code_unit_asc' },
);
const forEach = (collection: RefinementNode, scope: string, predicate: RefinementNode) => node('for_each', {
  collection, scope, predicate,
});

const MAX_SAFE = literal(Number.MAX_SAFE_INTEGER);

// The request/result tuple contracts already enforce the fixed slot tags and
// cardinality.  Keeping those duplicate refinements would only create
// schema-only mutations, not independently executable semantic witnesses.
const candidateRequestAssertions: RefinementNode[] = [
  assertTrue(unary('not', binary('eq', pointer('request', '/corpusId'), literal('')))),
];
const candidateResultAssertions: RefinementNode[] = [];

(['passage', 'fact', 'schema'] as const).forEach((kind, index) => {
  const requestSlot = `/slots/${index}`;
  const resultSlot = `/slots/${index}`;
  const hits = pointer('result', `${resultSlot}/hits`);
  const scope = `${kind}Hit`;
  const objectId = kind === 'passage' ? 'passageId' : kind === 'fact' ? 'factId' : 'schemaId';
  candidateRequestAssertions.push(
    assertTrue(unary('not', binary('eq', unary('array_length', pointer('request', `${requestSlot}/queryVector`)), literal(0)))),
    finiteRange(pointer('request', `${requestSlot}/threshold`), -1, 1),
    safeInteger(pointer('request', `${requestSlot}/limit`), 1, MAX_SAFE),
  );
  candidateResultAssertions.push(
    node('length_lte_ref', { actual: hits, limit: pointer('request', `${requestSlot}/limit`) }),
    unique(hits, scope, iteration(scope, '/id')),
    ordered(hits, scope, iteration(scope, '/score'), iteration(scope, '/id')),
    forEach(hits, scope, binary('eq', iteration(scope, '/id'), node('concat', {
      values: [literal(`${kind}:`), iteration(scope, `/item/${objectId}`)],
    }))),
    forEach(hits, scope, binary(
      'eq',
      iteration(scope, '/item/corpusId'),
      pointer('request', '/corpusId'),
    )),
    forEach(hits, scope, binary(
      'lte',
      pointer('request', `${requestSlot}/threshold`),
      iteration(scope, '/score'),
    )),
    // The request threshold's lower bound already implies score >= -1.
    // Retaining that redundant clause would make it impossible to witness
    // without also failing the threshold relation.
    forEach(hits, scope, binary('lte', iteration(scope, '/score'), literal(1))),
  );
});

export const CANDIDATE_SEARCH_REFINEMENT_PROGRAM: RefinementProgram = {
  version: REFINEMENT_IR_VERSION,
  requestAssertions: candidateRequestAssertions,
  exchangeAssertions: candidateResultAssertions,
};

const expansionLookup = (scope: string, entityPath: '/fact/headEntity' | '/fact/tailEntity') => node('map_lookup', {
  map: pointer('request', '/plan/seedEntities'),
  key: node('normalize_ref', {
    dependency: V15_ENTITY_NORMALIZATION_DIGEST,
    value: iteration(scope, entityPath),
  }),
  keyField: 'key',
  valueField: 'score',
});

const expansionFacts = pointer('result', '/facts');
const expansionScope = 'expandedFact';
const headScore = expansionLookup(expansionScope, '/fact/headEntity');
const tailScore = expansionLookup(expansionScope, '/fact/tailEntity');
export const FACT_EXPAND_REFINEMENT_PROGRAM: RefinementProgram = {
  version: REFINEMENT_IR_VERSION,
  requestAssertions: [
    assertTrue(unary('not', binary('eq', pointer('request', '/corpusId'), literal('')))),
    unique(pointer('request', '/plan/seedEntities'), 'seed', iteration('seed', '/key')),
    forEach(pointer('request', '/plan/seedEntities'), 'seed', unary('not', binary('eq', iteration('seed', '/key'), literal('')))),
    forEach(pointer('request', '/plan/excludedSeedFactIds'), 'excluded', unary('not', binary('eq', iteration('excluded', ''), literal('')))),
    finiteRange(pointer('request', '/plan/seedEntities/*/score'), 0, Number.MAX_VALUE),
    finiteRange(pointer('request', '/plan/attenuation'), 0, Number.MAX_VALUE),
    safeInteger(pointer('request', '/plan/limit'), 1, MAX_SAFE),
    node('field_eq_ref', {
      value: pointer('request', '/plan/normalizationContractDigest'),
      expected: literal(V15_ENTITY_NORMALIZATION_DIGEST),
    }),
  ],
  exchangeAssertions: [
    node('length_lte_ref', { actual: expansionFacts, limit: pointer('request', '/plan/limit') }),
    unique(expansionFacts, expansionScope, iteration(expansionScope, '/factId')),
    ordered(expansionFacts, expansionScope, iteration(expansionScope, '/score'), iteration(expansionScope, '/factId')),
    forEach(expansionFacts, expansionScope, binary(
      'eq',
      iteration(expansionScope, '/factId'),
      iteration(expansionScope, '/fact/factId'),
    )),
    forEach(expansionFacts, expansionScope, binary(
      'eq',
      iteration(expansionScope, '/fact/corpusId'),
      pointer('request', '/corpusId'),
    )),
    forEach(expansionFacts, expansionScope, unary('not', node('set_contains', {
      set: pointer('request', '/plan/excludedSeedFactIds'),
      value: iteration(expansionScope, '/factId'),
    }))),
    forEach(expansionFacts, expansionScope, list('any', [
      unary('not', binary('eq', headScore, literal(null))),
      unary('not', binary('eq', tailScore, literal(null))),
    ])),
    forEach(expansionFacts, expansionScope, binary('eq',
      iteration(expansionScope, '/score'),
      binary(
        'multiply',
        list('max', [
          list('coalesce', [headScore, literal(0)]),
          list('coalesce', [tailScore, literal(0)]),
        ]),
        pointer('request', '/plan/attenuation'),
      ),
    )),
  ],
};

const pprRequestAssertions: RefinementNode[] = [
  assertTrue(unary('not', binary('eq', pointer('request', '/corpusId'), literal('')))),
  unique(pointer('request', '/plan/seeds'), 'seed', iteration('seed', '/nodeId')),
  forEach(pointer('request', '/plan/seeds'), 'seed', unary('not', binary('eq', iteration('seed', '/nodeId'), literal('')))),
  finiteRange(pointer('request', '/plan/teleportProbability'), 0, 1),
  finiteRange(pointer('request', '/plan/convergenceEpsilon'), Number.MIN_VALUE, Number.MAX_VALUE),
  safeInteger(pointer('request', '/plan/maxIterations'), 1, MAX_SAFE),
  safeInteger(pointer('request', '/plan/hubDegreeThreshold'), 0, MAX_SAFE),
  safeInteger(pointer('request', '/plan/passageLimit'), 1, MAX_SAFE),
  safeInteger(pointer('request', '/plan/entityLimit'), 1, MAX_SAFE),
];
const pprExchangeAssertions: RefinementNode[] = [
  node('length_lte_ref', { actual: pointer('result', '/rankedPassages'), limit: pointer('request', '/plan/passageLimit') }),
  node('length_lte_ref', { actual: pointer('result', '/rankedFacts'), limit: pointer('request', '/plan/entityLimit') }),
];

([
  ['rankedPassages', 'passageRank', 'passage', 'passageId', 'passage'],
  ['rankedFacts', 'factRank', 'fact', 'factId', 'fact'],
] as const).forEach(([field, scope, itemField, idField, prefix]) => {
  const collection = pointer('result', `/${field}`);
  pprExchangeAssertions.push(
    unique(collection, scope, iteration(scope, '/nodeId')),
    ordered(collection, scope, iteration(scope, '/score'), iteration(scope, '/nodeId')),
    node('rank_is_index_plus_one', { collection, scope, rank: iteration(scope, '/rank') }),
    forEach(collection, scope, binary('eq', iteration(scope, '/nodeId'), node('concat', {
      values: [literal(`${prefix}:`), iteration(scope, `/${itemField}/${idField}`)],
    }))),
    forEach(collection, scope, binary(
      'eq',
      iteration(scope, `/${itemField}/corpusId`),
      pointer('request', '/corpusId'),
    )),
  );
});

pprExchangeAssertions.push(
  safeInteger(pointer('result', '/iterations'), 0, pointer('request', '/plan/maxIterations')),
  finiteRange(pointer('result', '/l1Delta'), 0, Number.MAX_VALUE),
  // A zero-iteration result is valid exactly when all four conditions hold.
  // Distributing the guard over the conjunction is logically equivalent, but
  // gives each independently removable condition its own witness identity.
  ...[
    binary('eq', unary('array_length', pointer('result', '/rankedPassages')), literal(0)),
    binary('eq', unary('array_length', pointer('result', '/rankedFacts')), literal(0)),
    pointer('result', '/converged'),
    binary('eq', pointer('result', '/l1Delta'), literal(0)),
  ].map((condition) => assertTrue(list('any', [
    unary('not', binary('eq', pointer('result', '/iterations'), literal(0))),
    condition,
  ]))),
  node('field_eq_ref', {
    value: pointer('result', '/converged'),
    expected: binary('lt', pointer('result', '/l1Delta'), pointer('request', '/plan/convergenceEpsilon')),
  }),
  assertTrue(list('any', [
    pointer('result', '/converged'),
    binary('eq', pointer('result', '/iterations'), pointer('request', '/plan/maxIterations')),
  ])),
);

export const PPR_MATERIALIZE_REFINEMENT_PROGRAM: RefinementProgram = {
  version: REFINEMENT_IR_VERSION,
  requestAssertions: pprRequestAssertions,
  exchangeAssertions: pprExchangeAssertions,
};
