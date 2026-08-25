import type { Fact } from '../../domain/memory/fact.js';
import type {
  ActivateFactsRequest,
  ActiveFactRequest,
  IIndexingMemory,
  IndexingMemoryDelta,
  IndexingMemoryMutationPlan,
  IndexingSchemaRequest,
} from '../../domain/storage/indexingMemory.js';
import type { IMemoryStore } from '../../domain/storage/graphStore.js';
import {
  validateActivationRequest,
  validateActiveFactRequest,
  validateActiveFactResponse,
  validateMutationPlan,
  validateSchemaRequest,
  validateSchemaResponse,
} from './indexingMemoryContract.js';

function normalizeSnapshotBoundary<T>(value: T): T {
  // Snapshot stores may materialize absent optional JSON fields as properties
  // whose value is `undefined`.  The bounded port exposes JSON-shaped values,
  // so mirror serialization semantics before applying the strict wire contract.
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Compatibility implementation for snapshot-oriented non-GraphDB backends. */
export class SnapshotBackedIndexingMemory implements IIndexingMemory {
  public constructor(private readonly store: IMemoryStore) {}

  public async getSchemasByIds(request: IndexingSchemaRequest) {
    validateSchemaRequest(request);
    if (request.schemaIds.length === 0) return [];
    const snapshot = await this.store.load(request.corpusId);
    const byId = new Map(snapshot.schemas.map((schema) => [schema.schemaId, schema]));
    const result = request.schemaIds.flatMap((schemaId) => {
      const schema = byId.get(schemaId);
      return schema ? [schema] : [];
    });
    return validateSchemaResponse(result, request);
  }

  public async getActiveFacts(request: ActiveFactRequest): Promise<readonly Fact[]> {
    validateActiveFactRequest(request);
    if (request.limit === 0) return [];
    const snapshot = await this.store.load(request.corpusId);
    const result = normalizeSnapshotBoundary(snapshot.facts
      .filter((fact) => fact.state === 'active')
      .slice(0, request.limit));
    return validateActiveFactResponse(result, request);
  }

  public preflightMutation(plan: IndexingMemoryMutationPlan): void {
    validateMutationPlan(plan);
  }

  public async activateFactsBySchemaIds(request: ActivateFactsRequest): Promise<number> {
    validateActivationRequest(request);
    const snapshot = await this.store.load(request.corpusId);
    const stableIds = new Set(request.schemaIds);
    let activated = 0;
    const facts = snapshot.facts.map((fact) => {
      if (fact.state !== 'inactive' || !stableIds.has(fact.schemaId)) return fact;
      activated += 1;
      return { ...fact, state: 'active' as const, updatedAt: request.updatedAt };
    });
    await this.store.save({ ...snapshot, facts });
    return activated;
  }

  public async upsertDelta(delta: IndexingMemoryDelta): Promise<void> {
    validateMutationPlan({ delta });
    await this.store.save({ ...delta, schemaVersion: 1 });
  }
}
