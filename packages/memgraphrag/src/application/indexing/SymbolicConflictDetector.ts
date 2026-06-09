import type { ConflictSet, IConflictDetector, ConflictType } from '../../domain/agent/conflictDetection.js';
import type { Fact } from '../../domain/memory/fact.js';

export interface SymbolicConflictDetectorOptions {
  readonly loadFacts: (corpusId: string) => Promise<readonly Fact[]>;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function classifyConflict(left: Fact, right: Fact): ConflictType | null {
  const sameHead = normalize(left.headEntity) === normalize(right.headEntity);
  const sameRelation = normalize(left.relation) === normalize(right.relation);
  const sameTail = normalize(left.tailEntity) === normalize(right.tailEntity);

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
