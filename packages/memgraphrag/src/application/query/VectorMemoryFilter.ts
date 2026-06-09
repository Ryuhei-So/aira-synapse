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
import type { IVectorIndex } from '../../domain/storage/index.js';
import type { IMemoryStore } from '../../domain/storage/index.js';
import type { Schema } from '../../domain/memory/schema.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';

export class VectorMemoryFilter implements IMemoryFilter {
  constructor(
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly vectorIndex: IVectorIndex,
    private readonly memoryStore: IMemoryStore,
    _graphStore: unknown,
  ) {}

  public async filter(request: QueryRequest): Promise<FilteredMemoryCandidates> {
    const { vectors } = await this.embeddingProvider.embed({ texts: [request.text] });
    const queryVector = vectors[0];
    if (!queryVector || queryVector.length === 0) {
      return { ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: true };
    }

    const [passageHits, factHits, schemaHits] = await Promise.all([
      this.vectorIndex.search({
        corpusId: request.corpusId,
        namespace: 'passage',
        queryVector,
        topK: request.topK,
        threshold: request.threshold,
      }),
      this.vectorIndex.search({
        corpusId: request.corpusId,
        namespace: 'fact',
        queryVector,
        topK: request.topM,
        threshold: request.threshold,
      }),
      this.vectorIndex.search({
        corpusId: request.corpusId,
        namespace: 'schema',
        queryVector,
        topK: 10,
        threshold: request.threshold,
      }),
    ]);

    // Load memory snapshot to resolve IDs to full objects
    const snapshot = await this.memoryStore.load(request.corpusId);
    const passageMap = new Map(snapshot.passages.map((p) => [p.passageId, p]));
    const factMap = new Map(snapshot.facts.map((f) => [f.factId, f]));
    const schemaMap = new Map(snapshot.schemas.map((s) => [s.schemaId, s]));

    const passages: MemoryCandidate<Passage>[] = [];
    for (const hit of passageHits) {
      // nodeId format: "passage:passage:chunkId" → passageId is the nodeId without prefix
      const nodeId = hit.id;
      const passageId = nodeId.startsWith('passage:') ? nodeId.slice('passage:'.length) : nodeId;
      const passage = passageMap.get(passageId) ?? passageMap.get(nodeId);
      if (passage) {
        passages.push({ layer: 'passage', item: passage, similarity: hit.score });
      }
    }

    const facts: MemoryCandidate<Fact>[] = [];
    for (const hit of factHits) {
      const nodeId = hit.id;
      const factId = nodeId.startsWith('fact:') ? nodeId.slice('fact:'.length) : nodeId;
      const fact = factMap.get(factId) ?? factMap.get(nodeId);
      if (fact) {
        facts.push({ layer: 'fact', item: fact, similarity: hit.score });
      }
    }

    const ontology: MemoryCandidate<Schema>[] = [];
    for (const hit of schemaHits) {
      const nodeId = hit.id;
      const schemaId = nodeId.startsWith('schema:') ? nodeId.slice('schema:'.length) : nodeId;
      const schema = schemaMap.get(schemaId) ?? schemaMap.get(nodeId);
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
    };
  }
}
