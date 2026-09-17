/**
 * Vector-based Memory Filter.
 * Embeds the query, searches the vector index across passage/fact/schema namespaces,
 * and returns candidates for PPR initialization.
 */
import type {
  IMemoryFilter,
  QueryRequest,
  FilteredMemoryCandidates,
  MemoryCandidate,
} from '../../domain/retrieval/memoryFilter.js';
import type { IEmbeddingProvider } from '../../domain/provider/index.js';
import type { IMemoryReader, IVectorIndex } from '../../domain/storage/index.js';
import type { Schema } from '../../domain/memory/schema.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';
import {
  buildV15SearchSlots,
  orderV15ScoreThenId,
} from '../../domain/retrieval/v15Plan.js';
import { indexById, lookupIds, resolveNode } from './memoryReadLookup.js';

export class VectorMemoryFilter implements IMemoryFilter {
  constructor(
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly vectorIndex: IVectorIndex,
    private readonly memoryReader: IMemoryReader,
    _graphStore: unknown,
  ) {}

  public async filter(request: QueryRequest, precomputedVector?: readonly number[]): Promise<FilteredMemoryCandidates> {
    let queryVector: readonly number[];
    if (precomputedVector && precomputedVector.length > 0) {
      queryVector = precomputedVector;
    } else {
      const { vectors } = await this.embeddingProvider.embed({ texts: [request.text] });
      const v = vectors[0];
      if (!v || v.length === 0) {
        return { ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: true, queryVector: [] };
      }
      queryVector = v;
    }

    const [passageSlot, factSlot, schemaSlot] = buildV15SearchSlots(request, queryVector);
    const [passageHits, factHits, schemaHits] = await Promise.all([
      this.vectorIndex.search({
        corpusId: request.corpusId,
        namespace: passageSlot!.namespace,
        queryVector: passageSlot!.queryVector,
        topK: passageSlot!.limit,
        threshold: passageSlot!.threshold,
      }),
      this.vectorIndex.search({
        corpusId: request.corpusId,
        namespace: factSlot!.namespace,
        queryVector: factSlot!.queryVector,
        topK: factSlot!.limit,
        threshold: factSlot!.threshold,
      }),
      this.vectorIndex.search({
        corpusId: request.corpusId,
        namespace: schemaSlot!.namespace,
        queryVector: schemaSlot!.queryVector,
        topK: schemaSlot!.limit,
        threshold: schemaSlot!.threshold,
      }),
    ]);

    // Resolve the hit ids to full objects with bounded by-id reads: the
    // reply volume is a function of the hits, never of the corpus.
    const corpusId = request.corpusId;
    const [passageRows, factRows, schemaRows] = await Promise.all([
      this.memoryReader.getPassagesByIds({ corpusId, passageIds: lookupIds(passageHits.map((hit) => hit.id), 'passage:') }),
      this.memoryReader.getFactsByIds({ corpusId, factIds: lookupIds(factHits.map((hit) => hit.id), 'fact:') }),
      this.memoryReader.getSchemasByIds({ corpusId, schemaIds: lookupIds(schemaHits.map((hit) => hit.id), 'schema:') }),
    ]);
    const passageMap = indexById(passageRows, (p) => p.passageId);
    const factMap = indexById(factRows, (f) => f.factId);
    const schemaMap = indexById(schemaRows, (s) => s.schemaId);

    const passages: MemoryCandidate<Passage>[] = [];
    for (const hit of orderV15ScoreThenId(passageHits)) {
      // nodeId format: "passage:passage:chunkId" → passageId is the nodeId without prefix
      const passage = resolveNode(passageMap, hit.id, 'passage:');
      if (passage) {
        passages.push({ layer: 'passage', item: passage, similarity: hit.score });
      }
    }

    const facts: MemoryCandidate<Fact>[] = [];
    for (const hit of orderV15ScoreThenId(factHits)) {
      const fact = resolveNode(factMap, hit.id, 'fact:');
      if (fact) {
        facts.push({ layer: 'fact', item: fact, similarity: hit.score });
      }
    }

    const ontology: MemoryCandidate<Schema>[] = [];
    for (const hit of orderV15ScoreThenId(schemaHits)) {
      const schema = resolveNode(schemaMap, hit.id, 'schema:');
      if (schema) {
        ontology.push({ layer: 'ontology', item: schema, similarity: hit.score });
      }
    }

    const fallbackRequired = passages.length === 0 && facts.length === 0;

    return {
      ontology,
      facts,
      passages,
      expandedTerms: [],
      fallbackRequired,
      queryVector: [...queryVector],
    };
  }
}
