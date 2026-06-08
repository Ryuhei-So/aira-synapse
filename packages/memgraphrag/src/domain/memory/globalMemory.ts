/**
 * Domain Layer — GlobalMemory, MemorySnapshot, MemoryStatistics.
 * DES-MG-001, DES-MG-002: Memory aggregation, snapshots, and statistics.
 */

import type { CorpusScoped } from './types.js';
import type { Schema } from './schema.js';
import type { Fact } from './fact.js';
import type { Passage } from './passage.js';

export interface MemorySnapshot extends CorpusScoped {
  readonly exportedAt: string;
  readonly schemas: readonly Schema[];
  readonly facts: readonly Fact[];
  readonly passages: readonly Passage[];
  readonly schemaVersion: number;
}

export interface MemoryStatistics extends CorpusScoped {
  readonly totalSchemas: number;
  readonly stableSchemas: number;
  readonly totalFacts: number;
  readonly activeFacts: number;
  readonly inactiveFacts: number;
  readonly totalPassages: number;
  readonly linkedFacts: number;
  readonly detectedConflicts: number;
  readonly resolvedConflicts: number;
  readonly connectedComponents: number;
}

export interface GlobalMemory extends CorpusScoped {
  getSchema(schemaId: string): Promise<Schema | null>;
  getFact(factId: string): Promise<Fact | null>;
  getPassage(passageId: string): Promise<Passage | null>;
  listFactsBySchema(schemaId: string): Promise<readonly Fact[]>;
  listPassagesByFact(factId: string): Promise<readonly Passage[]>;
  listFactsByPassage(passageId: string): Promise<readonly Fact[]>;
  exportSnapshot(format: 'json'): Promise<MemorySnapshot>;
  importSnapshot(snapshot: MemorySnapshot): Promise<void>;
  getStatistics(): Promise<MemoryStatistics>;
}
