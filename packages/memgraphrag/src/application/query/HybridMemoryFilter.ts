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
import type { IMemoryReader, IVectorIndex } from '../../domain/storage/index.js';
import type { ILexicalRetriever } from '../../domain/retrieval/ppr.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Schema } from '../../domain/memory/schema.js';
import { indexById, lookupIds, resolveNode, stripNodePrefix } from './memoryReadLookup.js';

/** RRF constant (controls rank vs score weighting) */
const RRF_K = 60;

/** Attenuation factor for lexical-only results (not confirmed by vector) */
const LEXICAL_ATTENUATION = 0.7;

export class HybridMemoryFilter implements IMemoryFilter {
  constructor(
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly vectorIndex: IVectorIndex,
    private readonly memoryReader: IMemoryReader,
    private readonly lexicalRetriever: ILexicalRetriever,
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

    // --- Merge passage hits with RRF ---
    const vectorPassageIds = new Set<string>();
    const passageScores = new Map<string, number>();

    // Vector passages: use cosine similarity as score
    for (let i = 0; i < passageHits.length; i++) {
      const hit = passageHits[i]!;
      const passageId = stripNodePrefix(hit.id, 'passage:');
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

    // Resolve the fused ids with bounded by-id reads (a stripped id may be
    // stored under its `passage:` prefix, so both spellings are requested).
    const corpusId = request.corpusId;
    const [passageRows, factRows, schemaRows] = await Promise.all([
      this.memoryReader.getPassagesByIds({
        corpusId,
        passageIds: fusedPassageIds.flatMap(([passageId]) => [passageId, `passage:${passageId}`]),
      }),
      this.memoryReader.getFactsByIds({ corpusId, factIds: lookupIds(factHits.map((hit) => hit.id), 'fact:') }),
      this.memoryReader.getSchemasByIds({ corpusId, schemaIds: lookupIds(schemaHits.map((hit) => hit.id), 'schema:') }),
    ]);
    const passageMap = indexById(passageRows, (p) => p.passageId);
    const factMap = indexById(factRows, (f) => f.factId);
    const schemaMap = indexById(schemaRows, (s) => s.schemaId);

    const passages: MemoryCandidate<Passage>[] = [];
    for (const [passageId, rrfScore] of fusedPassageIds) {
      const passage = passageMap.get(passageId) ?? passageMap.get(`passage:${passageId}`);
      if (passage) {
        // Use original vector similarity if available, else attenuated RRF
        const vectorHit = passageHits.find((h) => stripNodePrefix(h.id, 'passage:') === passageId);
        const similarity = vectorHit
          ? vectorHit.score
          : rrfScore * LEXICAL_ATTENUATION;
        passages.push({ layer: 'passage', item: passage, similarity });
      }
    }

    // Facts (vector only — lexical not applicable to structured facts)
    const facts: MemoryCandidate<Fact>[] = [];
    for (const hit of factHits) {
      const fact = resolveNode(factMap, hit.id, 'fact:');
      if (fact) {
        facts.push({ layer: 'fact', item: fact, similarity: hit.score });
      }
    }

    // Schema (vector only)
    const ontology: MemoryCandidate<Schema>[] = [];
    for (const hit of schemaHits) {
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
