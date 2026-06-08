import type Database from 'better-sqlite3';
import type { ConflictSet, IConflictDetector } from '../../domain/agent/conflictDetection.js';
import type { ConflictResolution, IConflictResolver } from '../../domain/agent/conflictResolution.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';

export interface ConflictDetectionConfig {
  readonly scanLimit?: number;
  readonly similarityThreshold?: number;
}

export interface ConflictResolutionAuditEntry {
  readonly corpusId: string;
  readonly conflictSet: ConflictSet;
  readonly resolution: ConflictResolution;
}

export async function detectConflicts(
  detector: IConflictDetector,
  facts: readonly Fact[],
  config: ConflictDetectionConfig = {},
): Promise<readonly ConflictSet[]> {
  const activeFacts = facts.filter((fact) => fact.state === 'active');
  const result: ConflictSet[] = [];

  for (const fact of activeFacts) {
    const detected = await detector.detect({
      corpusId: fact.corpusId,
      newFact: fact,
      activeFactLimit: config.scanLimit ?? 100,
      similarityThreshold: config.similarityThreshold ?? 0.8,
    });
    result.push(...detected);
  }

  return result;
}

export async function resolveConflicts(
  resolver: IConflictResolver,
  conflictSets: readonly ConflictSet[],
  passages: readonly Passage[],
): Promise<readonly ConflictResolutionAuditEntry[]> {
  const results: ConflictResolutionAuditEntry[] = [];

  for (const conflictSet of conflictSets) {
    const relevantPassageIds = new Set<string>([
      ...conflictSet.newFact.passageIds,
      ...conflictSet.conflictingFacts.flatMap((fact) => fact.passageIds),
    ]);
    const evidencePassages = passages.filter((passage) => relevantPassageIds.has(passage.passageId));
    const resolution = await resolver.resolve({
      conflictSet,
      evidencePassages,
    });
    results.push({
      corpusId: conflictSet.corpusId,
      conflictSet,
      resolution,
    });
  }

  return results;
}

export async function recordConflictAudit(
  db: Database.Database,
  resolutions: readonly ConflictResolutionAuditEntry[],
): Promise<void> {
  const insert = db.prepare(
    `INSERT INTO audit_logs (corpus_id, action, entity_type, entity_id, detail)
     VALUES (?, 'conflict_resolution', 'fact', ?, ?)`,
  );

  const transaction = db.transaction((entries: readonly ConflictResolutionAuditEntry[]) => {
    for (const entry of entries) {
      insert.run(
        entry.corpusId,
        entry.conflictSet.newFact.factId,
        JSON.stringify({
          conflictType: entry.conflictSet.conflictType,
          resolutionState: entry.resolution.state,
          confidence: entry.resolution.confidence,
          keptFactIds: entry.resolution.keptFactIds,
          inactivatedFactIds: entry.resolution.inactivatedFactIds,
          evidencePassageIds: entry.resolution.evidence.map((evidence) => evidence.passageId),
        }),
      );
    }
  });

  transaction(resolutions);
}
