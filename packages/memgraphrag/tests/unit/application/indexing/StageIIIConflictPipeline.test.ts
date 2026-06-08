import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { IConflictDetector, ConflictSet } from '../../../../src/domain/agent/conflictDetection.js';
import type { IConflictResolver } from '../../../../src/domain/agent/conflictResolution.js';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import { detectConflicts, resolveConflicts, recordConflictAudit } from '../../../../src/application/indexing/StageIIIConflictPipeline.js';
import { runMigrations } from '../../../../src/infrastructure/storage/migrate.js';

function createFact(overrides: Partial<Fact> = {}): Fact {
  return {
    factId: 'fact-1',
    corpusId: 'corpus-1',
    schemaId: 'schema-1',
    headEntity: 'Alice',
    headType: 'Person',
    relation: 'worksAt',
    tailEntity: 'ACME',
    tailType: 'Organization',
    state: 'active',
    passageIds: ['passage-1'],
    sourceDocumentIds: ['doc-1'],
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createPassage(overrides: Partial<Passage> = {}): Passage {
  return {
    passageId: 'passage-1',
    corpusId: 'corpus-1',
    text: 'Alice works at ACME',
    normalizedText: 'alice works at acme',
    metadata: {
      documentId: 'doc-1',
      title: 'Doc',
      sourceUrl: 'https://example.com',
      language: 'en',
      sectionPath: ['Intro'],
      chunkId: 'doc-1:0',
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 10,
    },
    factIds: ['fact-1'],
    entityMentions: ['Alice', 'ACME'],
    qualityFlags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TASK-MG-032: StageIIIConflictPipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('detects conflicts only for active facts', async () => {
    const detector = {
      ...createNotImplementedStub<IConflictDetector>('IConflictDetector'),
      detect: vi.fn<IConflictDetector['detect']>().mockResolvedValue([]),
    } satisfies IConflictDetector;

    await detectConflicts(detector, [createFact(), createFact({ factId: 'fact-2', state: 'inactive' })]);

    expect(detector.detect).toHaveBeenCalledTimes(1);
    expect(detector.detect).toHaveBeenCalledWith(expect.objectContaining({
      activeFactLimit: 100,
      similarityThreshold: 0.8,
      newFact: expect.objectContaining({ factId: 'fact-1' }),
    }));
  });

  it('passes custom conflict config to detector', async () => {
    const conflictSet: ConflictSet = {
      corpusId: 'corpus-1',
      newFact: createFact(),
      conflictingFacts: [createFact({ factId: 'fact-2' })],
      candidates: [],
      conflictType: 'mutually_exclusive',
      scanLimit: 25,
    };
    const detector = {
      ...createNotImplementedStub<IConflictDetector>('IConflictDetector'),
      detect: vi.fn<IConflictDetector['detect']>().mockResolvedValue([conflictSet]),
    } satisfies IConflictDetector;

    const result = await detectConflicts(detector, [createFact()], { scanLimit: 25, similarityThreshold: 0.95 });

    expect(result).toEqual([conflictSet]);
    expect(detector.detect).toHaveBeenCalledWith(expect.objectContaining({
      activeFactLimit: 25,
      similarityThreshold: 0.95,
    }));
  });

  it('resolves conflicts with evidence passages linked to involved facts', async () => {
    const conflictSet: ConflictSet = {
      corpusId: 'corpus-1',
      newFact: createFact(),
      conflictingFacts: [createFact({ factId: 'fact-2', passageIds: ['passage-2'] })],
      candidates: [],
      conflictType: 'temporal',
      scanLimit: 100,
    };
    const resolver = {
      ...createNotImplementedStub<IConflictResolver>('IConflictResolver'),
      resolve: vi.fn<IConflictResolver['resolve']>().mockResolvedValue({
        state: 'temporalized',
        confidence: 0.88,
        keptFactIds: ['fact-1'],
        inactivatedFactIds: ['fact-2'],
        derivedFacts: [],
        evidence: [{ passageId: 'passage-1', supportsFactIds: ['fact-1'], rationale: 'recent source' }],
      }),
    } satisfies IConflictResolver;

    const results = await resolveConflicts(resolver, [conflictSet], [createPassage(), createPassage({ passageId: 'passage-2', factIds: ['fact-2'] })]);

    expect(results[0]?.resolution.state).toBe('temporalized');
    expect(resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      evidencePassages: expect.arrayContaining([
        expect.objectContaining({ passageId: 'passage-1' }),
        expect.objectContaining({ passageId: 'passage-2' }),
      ]),
    }));
  });

  it('records conflict audit rows using the migration schema columns', async () => {
    const conflictSet: ConflictSet = {
      corpusId: 'corpus-1',
      newFact: createFact(),
      conflictingFacts: [createFact({ factId: 'fact-2' })],
      candidates: [],
      conflictType: 'mutually_exclusive',
      scanLimit: 100,
    };

    await recordConflictAudit(db, [{
      corpusId: 'corpus-1',
      conflictSet,
      resolution: {
        state: 'resolved_keep_new',
        confidence: 0.91,
        keptFactIds: ['fact-1'],
        inactivatedFactIds: ['fact-2'],
        derivedFacts: [],
        evidence: [{ passageId: 'passage-1', supportsFactIds: ['fact-1'], rationale: 'better evidence' }],
      },
    }]);

    const row = db.prepare('SELECT action, entity_type, entity_id, detail FROM audit_logs').get() as { action: string; entity_type: string; entity_id: string; detail: string };
    const detail = JSON.parse(row.detail) as Record<string, unknown>;

    expect(row.action).toBe('conflict_resolution');
    expect(row.entity_type).toBe('fact');
    expect(row.entity_id).toBe('fact-1');
    expect(detail.conflictType).toBe('mutually_exclusive');
    expect(detail.resolutionState).toBe('resolved_keep_new');
  });
});
