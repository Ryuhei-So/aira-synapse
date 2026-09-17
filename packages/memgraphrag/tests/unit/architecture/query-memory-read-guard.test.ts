/**
 * literature-hub #545 static guard.
 *
 * The query path resolves memory objects through IMemoryReader (bounded
 * by-id and by-entity reads). Nothing under src/application/query may hold
 * an IMemoryStore, call `.load(`, or name `memory_load`; the aira-graphdb
 * factory must wire the reader through AiraGraphDbMemoryReader, whose only
 * transport is the advertised bounded methods.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const QUERY_DIR = resolve(PKG_ROOT, 'src', 'application', 'query');
const RUNTIME = resolve(PKG_ROOT, 'src', 'interface', 'runtime', 'MemGraphRagRuntime.ts');
const FACTORY = resolve(PKG_ROOT, 'src', 'infrastructure', 'storage', 'ladybug', 'storageFactory.ts');
const READER = resolve(PKG_ROOT, 'src', 'infrastructure', 'storage', 'aira-graphdb', 'AiraGraphDbMemoryReader.ts');
const READ_CONTRACT = resolve(PKG_ROOT, 'src', 'infrastructure', 'storage', 'memoryReadContract.ts');

const FORBIDDEN: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /\bIMemoryStore\b/, reason: 'imports the whole-snapshot store port' },
  { pattern: /\bmemoryStore\b/, reason: 'holds a memory store' },
  { pattern: /\.load\(/, reason: 'calls a snapshot load' },
  { pattern: /memory_load/, reason: 'names the whole-corpus native method' },
];

function tsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...tsFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

function violations(source: string): string[] {
  return FORBIDDEN
    .filter(({ pattern }) => pattern.test(source))
    .map(({ reason }) => reason);
}

describe('literature-hub #545 guard: the query path never loads the corpus snapshot', () => {
  const queryFiles = tsFiles(QUERY_DIR);

  it('scans a non-empty query module set', () => {
    expect(queryFiles.length).toBeGreaterThan(10);
  });

  it.each(queryFiles.map((file) => [relative(PKG_ROOT, file), file]))(
    '%s neither imports IMemoryStore nor calls memoryStore.load / memory_load',
    (_label, file) => {
      expect(violations(readFileSync(file, 'utf8'))).toEqual([]);
    },
  );

  it('the query service facade in the runtime is wired with IMemoryReader only', () => {
    const source = readFileSync(RUNTIME, 'utf8');
    const start = source.indexOf('class QueryServiceFacade');
    const end = source.indexOf('class RuntimeImpl');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const facade = source.slice(start, end);
    expect(violations(facade)).toEqual([]);
    expect(facade).toContain('memoryReader');
  });

  it('the aira-graphdb factory acquires the reader before any query and fails closed with it', () => {
    const source = readFileSync(FACTORY, 'utf8');
    expect(source).toContain('memoryReader = await AiraGraphDbMemoryReader.create(client);');
    const acquisition = source.slice(
      source.indexOf('indexingMemory = await AiraGraphDbIndexingMemory.create(client);'),
      source.indexOf('} catch (error) {', source.indexOf('AiraGraphDbMemoryReader.create(client)')),
    );
    expect(acquisition).toContain('AiraGraphDbMemoryReader.create(client)');
  });

  it('AiraGraphDbMemoryReader speaks only the advertised bounded methods', () => {
    const reader = readFileSync(READER, 'utf8');
    // The name may appear in the fail-closed error text, never as a method call.
    expect(reader).not.toMatch(/['"]memory_load['"]/);
    expect(reader).not.toMatch(/request<[^>]*>\(\s*['"]memory_load/);
    // No catch-based capability probing (the 9a722b8 anti-pattern).
    expect(reader).not.toMatch(/\bcatch\b/);
    const source = reader + readFileSync(READ_CONTRACT, 'utf8');
    for (const method of [
      'memory_get_passages_by_ids',
      'memory_get_facts_by_ids',
      'memory_find_facts_by_entities',
      'memory_section_counts',
    ]) {
      expect(source).toContain(method);
    }
  });
});
