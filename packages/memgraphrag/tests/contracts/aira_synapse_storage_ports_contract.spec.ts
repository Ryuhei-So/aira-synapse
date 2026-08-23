import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type ContractPort = {
  requiredMethods: string[];
  methodContracts: Record<string, unknown>;
};

type ContractShape = {
  id: string;
  ports: Record<string, ContractPort>;
};

const graphDbRepoPath = process.env.AIRA_GRAPHDB_REPO_PATH;
if (!graphDbRepoPath) throw new Error('AIRA_GRAPHDB_REPO_PATH is required for the GraphDB contract test');
const contractPath = resolve(graphDbRepoPath, 'spec', 'contracts', 'aira-synapse-storage-ports.v1.0.0.json');

const storageInterfacePath = resolve(
  process.cwd(),
  'src',
  'domain',
  'storage',
  'graphStore.ts',
);
const retrievalInterfacePath = resolve(
  process.cwd(),
  'src',
  'domain',
  'retrieval',
  'ppr.ts',
);

function extractInterfaceMethods(source: string, interfaceName: string): string[] {
  const escaped = interfaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bodyMatch = source.match(
    new RegExp(`export\\s+interface\\s+${escaped}[\\s\\S]*?\\{([\\s\\S]*?)\\n\\}`, 'm'),
  );
  if (!bodyMatch?.[1]) return [];
  const body = bodyMatch[1];
  const methods = [...body.matchAll(/^\s*([A-Za-z_]\w*)\s*(?:<[^()\n]*>)?\s*\(/gm)]
    .map((m) => m[1]!)
    .filter((name, index, all) => all.indexOf(name) === index);
  return methods.sort();
}

function compareMethods(actual: string[], expected: string[]): {
  missingInContract: string[];
  extraInContract: string[];
} {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missingInContract: actual.filter((m) => !expectedSet.has(m)),
    extraInContract: expected.filter((m) => !actualSet.has(m)),
  };
}

describe('TASK-AGDB-035: aira-synapse storage port contract parity', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as ContractShape;
  const storageSource = readFileSync(storageInterfacePath, 'utf8');
  const retrievalSource = readFileSync(retrievalInterfacePath, 'utf8');

  it('loads canonical contract id', () => {
    expect(contract.id).toBe('aira-synapse-storage-ports.v1.0.0');
  });

  it('matches IGraphStore methods with AST extraction', () => {
    const actual = extractInterfaceMethods(storageSource, 'IGraphStore');
    const required = [...contract.ports.IGraphStore.requiredMethods].sort();
    const diff = compareMethods(actual, required);
    expect(diff).toEqual({ missingInContract: [], extraInContract: [] });
  });

  it('matches IVectorIndex methods with AST extraction', () => {
    const actual = extractInterfaceMethods(storageSource, 'IVectorIndex');
    const required = [...contract.ports.IVectorIndex.requiredMethods].sort();
    const diff = compareMethods(actual, required);
    expect(diff).toEqual({ missingInContract: [], extraInContract: [] });
  });

  it('matches IMemoryStore methods with AST extraction', () => {
    const actual = extractInterfaceMethods(storageSource, 'IMemoryStore');
    const required = [...contract.ports.IMemoryStore.requiredMethods].sort();
    const diff = compareMethods(actual, required);
    expect(diff).toEqual({ missingInContract: [], extraInContract: [] });
  });

  it('matches IGraphProjection methods with AST extraction', () => {
    const actual = extractInterfaceMethods(retrievalSource, 'IGraphProjection');
    const required = [...contract.ports.IGraphProjection.requiredMethods].sort();
    const diff = compareMethods(actual, required);
    expect(diff).toEqual({ missingInContract: [], extraInContract: [] });
  });

  it('matches ILexicalRetriever methods with AST extraction', () => {
    const actual = extractInterfaceMethods(retrievalSource, 'ILexicalRetriever');
    const required = [...contract.ports.ILexicalRetriever.requiredMethods].sort();
    const diff = compareMethods(actual, required);
    expect(diff).toEqual({ missingInContract: [], extraInContract: [] });
  });

  it('keeps methodContracts keys aligned with requiredMethods', () => {
    const interfaces = Object.entries(contract.ports);
    for (const [, port] of interfaces) {
      const required = [...port.requiredMethods].sort();
      const contractKeys = Object.keys(port.methodContracts).sort();
      expect(contractKeys).toEqual(required);
    }
  });
});
