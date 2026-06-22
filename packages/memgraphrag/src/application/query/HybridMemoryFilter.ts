/**
 * Hybrid Memory Filter — combines Vector (embedding) + Lexical (BM25) retrieval.
 *
 * Strategy: Run vector and lexical search in parallel, merge results with
 * reciprocal rank fusion (RRF) to produce a unified candidate list.
 * This recovers passages that vector search misses due to vocabulary mismatch.
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
import type { ILexicalRetriever } from '../../domain/retrieval/ppr.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Schema } from '../../domain/memory/schema.js';

/** RRF constant (controls rank vs score weighting) */
const RRF_K = 60;

/** Attenuation factor for lexical-only results (not confirmed by vector) */
const LEXICAL_ATTENUATION = 0.7;

export class HybridMemoryFilter implements IMemoryFilter {
  constructor(
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly vectorIndex: IVectorIndex,
    private readonly memoryStore: IMemoryStore,
    private readonly lexicalRetriever: ILexicalRetriever,
    _graphStore: unknown,
  ) {}

  public async filter(request: QueryRequest): Promise<FilteredMemoryCandidates> {
    const { vectors } = await this.embeddingProvider.embed({ texts: [request.text] });
    const queryVector = vectors[0];
    if (!queryVector || queryVector.length === 0) {
      return { ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: true };
    }

    // Run vector and lexical searches in parallel
    const [passageHits, factHits, schemaHits, lexicalHits] = await Promise.all([
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
      this.lexicalRetriever.search(request.corpusId, request.text, request.topK),
    ]);

    // Load memory snapshot
    const snapshot = await this.memoryStore.load(request.corpusId);
    const passageMap = new Map(snapshot.passages.map((p) => [p.passageId, p]));
    const factMap = new Map(snapshot.facts.map((f) => [f.factId, f]));
    const schemaMap = new Map(snapshot.schemas.map((s) => [s.schemaId, s]));

    // --- Merge passage hits with RRF ---
    const vectorPassageIds = new Set<string>();
    const passageScores = new Map<string, number>();

    // Vector passages: use cosine similarity as score
    for (let i = 0; i < passageHits.length; i++) {
      const hit = passageHits[i]!;
      const nodeId = hit.id;
      const passageId = nodeId.startsWith('passage:') ? nodeId.slice('passage:'.length) : nodeId;
      vectorPassageIds.add(passageId);
      // RRF score from vector rank
      const rrfVector = 1 / (RRF_K + i + 1);
      passageScores.set(passageId, (passageScores.get(passageId) ?? 0) + rrfVector);
    }

    // Lexical passages: add RRF contribution
    for (let i = 0; i < lexicalHits.length; i++) {
      const hit = lexicalHits[i]!;
      const passageId = hit.passageId;
      const rrfLexical = 1 / (RRF_K + i + 1);
      passageScores.set(passageId, (passageScores.get(passageId) ?? 0) + rrfLexical);
    }

    // Sort by fused score, take topK
    const fusedPassageIds = Array.from(passageScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, request.topK);

    const passages: MemoryCandidate<Passage>[] = [];
    for (const [passageId, rrfScore] of fusedPassageIds) {
      const passage = passageMap.get(passageId) ?? passageMap.get(`passage:${passageId}`);
      if (passage) {
        // Use original vector similarity if available, else attenuated RRF
        const vectorHit = passageHits.find((h) => {
          const hId = h.id.startsWith('passage:') ? h.id.slice('passage:'.length) : h.id;
          return hId === passageId;
        });
        const similarity = vectorHit
          ? vectorHit.score
          : rrfScore * LEXICAL_ATTENUATION;
        passages.push({ layer: 'passage', item: passage, similarity });
      }
    }

    // Facts (vector only — lexical not applicable to structured facts)
    const facts: MemoryCandidate<Fact>[] = [];
    for (const hit of factHits) {
      const nodeId = hit.id;
      const factId = nodeId.startsWith('fact:') ? nodeId.slice('fact:'.length) : nodeId;
      const fact = factMap.get(factId) ?? factMap.get(nodeId);
      if (fact) {
        facts.push({ layer: 'fact', item: fact, similarity: hit.score });
      }
    }

    // Schema (vector only)
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
