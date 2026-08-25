import type { ConflictSet, IConflictDetector, ConflictType } from '../../domain/agent/conflictDetection.js';
import type { Fact } from '../../domain/memory/fact.js';
import { normalizeSchemaTerm } from '../../domain/memory/schema.js';

export interface SymbolicConflictDetectorOptions {
  readonly loadFacts: (corpusId: string) => Promise<readonly Fact[]>;
}

function classifyConflict(left: Fact, right: Fact): ConflictType | null {
  const sameHead = normalizeSchemaTerm(left.headEntity) === normalizeSchemaTerm(right.headEntity);
  const sameRelation = normalizeSchemaTerm(left.relation) === normalizeSchemaTerm(right.relation);
  const sameTail = normalizeSchemaTerm(left.tailEntity) === normalizeSchemaTerm(right.tailEntity);

  if (sameHead && sameRelation && !sameTail) {
    return 'mutually_exclusive';
  }
  if (sameHead && sameRelation && sameTail && left.temporalScope !== right.temporalScope) {
    return 'temporal';
  }
  if (sameHead && sameRelation && sameTail && left.granularityParentFactId !== right.granularityParentFactId) {
    return 'granularity';
  }
  return null;
}

export class SymbolicConflictDetector implements IConflictDetector {
  public constructor(private readonly options: SymbolicConflictDetectorOptions) {}

  public async detect(request: {
    corpusId: string;
    newFact: Fact;
    activeFactLimit: number;
    similarityThreshold: number;
  }): Promise<readonly ConflictSet[]> {
    const activeFacts = (await this.options.loadFacts(request.corpusId))
      .filter((fact) => fact.state === 'active' && fact.factId !== request.newFact.factId)
      .slice(0, request.activeFactLimit);

    const byType = new Map<ConflictType, Fact[]>();
    for (const fact of activeFacts) {
      const conflictType = classifyConflict(request.newFact, fact);
      if (!conflictType) {
        continue;
      }
      const facts = byType.get(conflictType) ?? [];
      facts.push(fact);
      byType.set(conflictType, facts);
    }

    return [...byType.entries()].map(([conflictType, conflictingFacts]) => ({
      corpusId: request.corpusId,
      newFact: request.newFact,
      conflictingFacts,
      candidates: conflictingFacts.map((fact) => ({
        factId: fact.factId,
        similarity: 1,
        symbolicMatch: true,
      })),
      conflictType,
      scanLimit: request.activeFactLimit,
    }));
  }
}
