import type {
  ArrayContract,
  ContractNode,
  ExternalReferenceContract,
  ObjectContract,
} from '../contract/structural.js';
import { canonicalJson } from '../contract/structural.js';
import {
  REFINEMENT_NODE_DECLARATIONS,
  validateRefinementProgram,
  type RefinementNode,
  type RefinementProgram,
  type RefinementValidation,
} from './refinementIr.js';

export interface RefinementStructuralRoots {
  readonly request: ContractNode;
  readonly result: ContractNode;
  readonly resolveExternal: (reference: ExternalReferenceContract) => ContractNode | undefined;
}

function decode(segment: string): string {
  return segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

function unwrap(node: ContractNode, roots: RefinementStructuralRoots): ContractNode {
  if (node.kind === 'optional') return unwrap(node.value, roots);
  if (node.kind === 'externalRef') {
    const resolved = roots.resolveExternal(node);
    if (!resolved) throw new TypeError(`unresolved external contract ${node.referenceKind}`);
    return unwrap(resolved, roots);
  }
  return node;
}

function childAt(
  node: ContractNode,
  segment: string,
  roots: RefinementStructuralRoots,
): ContractNode {
  const current = unwrap(node, roots);
  if (current.kind === 'array') {
    if (segment !== '*' && !/^(0|[1-9]\d*)$/u.test(segment)) {
      throw new TypeError(`array segment ${segment} is invalid`);
    }
    return current.items;
  }
  if (current.kind === 'tuple') {
    if (segment === '*') {
      const [first, ...rest] = current.items;
      if (!first || rest.some((item) => canonicalJson(item) !== canonicalJson(first))) {
        throw new TypeError('tuple wildcard crosses non-identical item contracts');
      }
      return first;
    }
    if (!/^(0|[1-9]\d*)$/u.test(segment)) throw new TypeError(`tuple segment ${segment} is invalid`);
    const child = current.items[Number(segment)];
    if (!child) throw new TypeError(`tuple index ${segment} is absent`);
    return child;
  }
  if (current.kind === 'object') {
    const child = current.fields[segment];
    if (!child) throw new TypeError(`field ${segment} is absent`);
    return child;
  }
  if (current.kind === 'discriminatedUnion') {
    const children = Object.values(current.branches).map((branch) => childAt(branch, segment, roots));
    const first = children[0];
    if (!first) throw new TypeError(`union has no branch for ${segment}`);
    if (children.some((child) => canonicalJson(child) !== canonicalJson(first))) {
      throw new TypeError(`union field ${segment} has branch-specific contracts`);
    }
    return first;
  }
  throw new TypeError(`cannot traverse ${current.kind} through ${segment}`);
}

function contractAt(
  root: ContractNode,
  path: string,
  roots: RefinementStructuralRoots,
): ContractNode {
  let current = root;
  if (path === '') return current;
  for (const raw of path.slice(1).split('/')) current = childAt(current, decode(raw), roots);
  return current;
}

function itemContract(node: ContractNode, roots: RefinementStructuralRoots): ContractNode {
  const current = unwrap(node, roots);
  if (current.kind !== 'array') throw new TypeError('collection expression must resolve to an array');
  return current.items;
}

function expressionContract(
  node: RefinementNode,
  roots: RefinementStructuralRoots,
  scopes: ReadonlyMap<string, ContractNode>,
): ContractNode | undefined {
  if (node.op === 'pointer') {
    const root = node.root === 'request' ? roots.request : roots.result;
    return contractAt(root, node.path as string, roots);
  }
  if (node.op === 'iteration_pointer') {
    const scope = scopes.get(node.scope as string);
    if (!scope) throw new TypeError(`iteration scope ${String(node.scope)} is absent`);
    return contractAt(scope, node.path as string, roots);
  }
  if (node.op === 'array_at') {
    const array = expressionContract(node.array as RefinementNode, roots, scopes);
    if (!array) return undefined;
    const current = unwrap(array, roots);
    if (current.kind === 'array') return current.items;
    if (current.kind === 'tuple') {
      const index = node.index as RefinementNode;
      if (index.op !== 'literal' || typeof index.value !== 'number' || !Number.isSafeInteger(index.value)) {
        throw new TypeError('tuple array_at index must be a safe integer literal');
      }
      const item = current.items[index.value];
      if (!item) throw new TypeError(`tuple array_at index ${index.value} is absent`);
      return item;
    }
    throw new TypeError('array_at source must resolve to an array or tuple');
  }
  return undefined;
}

function walkExpression(
  node: RefinementNode,
  roots: RefinementStructuralRoots,
  scopes: ReadonlyMap<string, ContractNode>,
): void {
  expressionContract(node, roots, scopes);
  const declaration = REFINEMENT_NODE_DECLARATIONS[node.op];
  for (const [field, kind] of Object.entries(declaration.fields)) {
    if (kind === 'expression') walkExpression(node[field] as RefinementNode, roots, scopes);
    if (kind === 'expression_array_nonempty') {
      for (const child of node[field] as readonly RefinementNode[]) walkExpression(child, roots, scopes);
    }
  }
}

function walkAssertion(
  node: RefinementNode,
  roots: RefinementStructuralRoots,
): void {
  const declaration = REFINEMENT_NODE_DECLARATIONS[node.op];
  let scopes: ReadonlyMap<string, ContractNode> = new Map();
  if (Object.prototype.hasOwnProperty.call(declaration.fields, 'scope')) {
    const collection = node.collection as RefinementNode;
    walkExpression(collection, roots, scopes);
    const contract = expressionContract(collection, roots, scopes);
    if (!contract) throw new TypeError(`${node.op} collection must have a structural pointer`);
    scopes = new Map([[node.scope as string, itemContract(contract, roots)]]);
  }
  for (const [field, kind] of Object.entries(declaration.fields)) {
    if (field === 'collection' && scopes.size > 0) continue;
    if (kind === 'expression') walkExpression(node[field] as RefinementNode, roots, scopes);
    if (kind === 'expression_array_nonempty') {
      for (const child of node[field] as readonly RefinementNode[]) walkExpression(child, roots, scopes);
    }
  }
}

export function validateRefinementProgramPointers(
  program: RefinementProgram,
  roots: RefinementStructuralRoots,
): RefinementValidation {
  const structural = validateRefinementProgram(program);
  if (!structural.valid) return structural;
  const errors: string[] = [];
  program.assertions.forEach((node, index) => {
    try {
      walkAssertion(node, roots);
    } catch (error) {
      errors.push(`$.assertions[${index}] pointer validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { valid: errors.length === 0, errors };
}

export type RefinementArrayContract = ArrayContract;
export type RefinementObjectContract = ObjectContract;
