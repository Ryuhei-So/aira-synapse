/**
 * Full Document Indexing Pipeline — Algorithm 1 (Stage I–IV).
 * Replaces MinimalDocumentIndexingPipeline for real indexing.
 */
import type Database from 'better-sqlite3';
import {
  DocumentMutationError,
  type DocumentIndexingPipeline,
  type ProcessDocumentResult,
} from './AsyncJobRunner.js';
import type { IndexDocumentInput } from './StageIExtractor.js';
import { StageIExtractor } from './StageIExtractor.js';
import { StageIICanonicalizer } from './StageIICanonicalizer.js';
import {
  buildVectorRecords,
  persistGraphProjection,
  persistVectorRecords,
  planGraphProjection,
} from './StageIVGraphProjector.js';
import { SymbolicCanonicalizer } from './SymbolicCanonicalizer.js';
import { SymbolicConflictDetector } from './SymbolicConflictDetector.js';
import { LLMConflictResolver } from './LLMConflictResolver.js';
import { detectConflicts, resolveConflicts, recordConflictAudit } from './StageIIIConflictPipeline.js';
import type { ILLMProvider, IEmbeddingProvider, INLPExtractor } from '../../domain/provider/index.js';
import type { IGraphStore, IIndexingMemory, IVectorIndex } from '../../domain/storage/index.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { ITermDictionary } from '../../domain/dictionary/termDictionary.js';
import { LLMExtractionAgent } from './LLMExtractionAgent.js';
import { LexiconBuilder } from './LexiconBuilder.js';
import { buildDocumentFacts, buildDocumentMemoryDelta } from './DocumentMemoryPlan.js';

export interface FullPipelineOptions {
  readonly db: Database.Database;
  readonly graphStore: IGraphStore;
  readonly vectorIndex: IVectorIndex;
  readonly indexingMemory: IIndexingMemory;
  readonly llmProvider: ILLMProvider;
  readonly embeddingProvider: IEmbeddingProvider;
  readonly nlpExtractor: INLPExtractor;
  readonly enableConflictResolution?: boolean;
  readonly enableDictionaryIndexing?: boolean;
  readonly dictionary?: ITermDictionary;
  /** Factory to create a corpus-scoped ITermDictionary. Used by Stage V to satisfy FK constraints. */
  readonly dictionaryFactory?: (corpusId: string) => ITermDictionary;
}

export class FullDocumentIndexingPipeline implements DocumentIndexingPipeline {
  private readonly stageI: StageIExtractor;
  private readonly canonicalizer: SymbolicCanonicalizer;
  private readonly options: FullPipelineOptions;

  public constructor(options: FullPipelineOptions) {
    this.options = options;
    const extractionAgent = new LLMExtractionAgent(options.llmProvider);
    this.stageI = new StageIExtractor(options.nlpExtractor, extractionAgent);
    this.canonicalizer = new SymbolicCanonicalizer();
  }

  public async processDocument(
    corpusId: string,
    document: IndexDocumentInput,
  ): Promise<ProcessDocumentResult> {
    const now = new Date().toISOString();

    // Insert document metadata
    this.options.db.prepare(
      `INSERT OR REPLACE INTO documents (
        document_id, corpus_id, title, source_url, doi, source_db, source_type, language, converted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      document.documentId, corpusId, document.title, document.sourceUrl,
      document.doi ?? null, document.sourceDb ?? null, document.sourceType ?? null,
      document.language ?? 'unknown', now, now, now,
    );

    // Stage I: Extract chunks, entities, schemas, facts
    const tStart = Date.now();
    const records = await this.stageI.extractChunks(corpusId, document);
    const tStageI = Date.now();

    if (records.length === 0) {
      return { processedDocumentId: document.documentId, addedNodes: 0, addedEdges: 0, conflicts: 0 };
    }

    // Stage II: Canonicalize schemas and merge into memory
    const stageII = new StageIICanonicalizer(corpusId, this.options.indexingMemory);
    const candidateSchemas = await stageII.canonicalizeSchemas(records, this.canonicalizer);
    const { finalSchemas: schemas, newlyStableSchemaIds } = await stageII.prepareSchemas(candidateSchemas);

    // Schema candidates retain occurrence pressure, while repeated fact
    // candidates fold to one identity with all supporting passage provenance.
    const allFacts: Fact[] = [...buildDocumentFacts(
      corpusId,
      document.documentId,
      records,
      schemas,
      now,
    )];

    // Stage III: Conflict detection and resolution
    let conflictCount = 0;
    if (this.options.enableConflictResolution !== false) {
      const passages = records.map((r) => r.sourcePassage);
      const activeFacts = allFacts.some((fact) => fact.state === 'active')
        ? await this.options.indexingMemory.getActiveFacts({ corpusId, limit: 100 })
        : [];
      const detector = new SymbolicConflictDetector({
        loadFacts: async (cid) => {
          if (cid !== corpusId) {
            throw new Error('conflict detector requested the wrong corpus');
          }
          return activeFacts;
        },
      });
      const conflictSets = await detectConflicts(detector, allFacts);
      conflictCount = conflictSets.length;

      if (conflictSets.length > 0) {
        const resolver = new LLMConflictResolver(this.options.llmProvider);
        const resolutions = await resolveConflicts(resolver, conflictSets, passages);

        // Apply resolutions: inactivate discarded facts
        const inactivatedIds = new Set(
          resolutions.flatMap((r) => r.resolution.inactivatedFactIds),
        );
        for (let i = 0; i < allFacts.length; i++) {
          if (inactivatedIds.has(allFacts[i]!.factId)) {
            allFacts[i] = { ...allFacts[i]!, state: 'inactive' };
          }
        }

        // Record audit trail
        await recordConflictAudit(this.options.db, resolutions);
        console.log(`  [${document.title}] Stage III: ${conflictSets.length} conflicts detected, ${inactivatedIds.size} facts inactivated`);
      }
    }

    const passages = records.map((r) => r.sourcePassage);
    const delta = buildDocumentMemoryDelta(corpusId, schemas, allFacts, passages, now);
    const activation = newlyStableSchemaIds.length > 0
      ? { corpusId, schemaIds: newlyStableSchemaIds, updatedAt: now }
      : undefined;

    // Complete deterministic validation and external provider work before the
    // first mutation. Admission failures after this boundary are uncertain and
    // must poison the whole owner transaction.
    this.options.indexingMemory.preflightMutation(
      activation ? { delta, activation } : { delta },
    );
    const graphPlan = planGraphProjection(delta.facts, delta.schemas, delta.passages);
    const vectorRecords = await buildVectorRecords(
      this.options.embeddingProvider,
      graphPlan.nodes,
    );

    try {
      const upsertResult = await this.options.indexingMemory.upsertDelta(delta);
      if (activation) {
        await this.options.indexingMemory.activateFactsBySchemaIds(activation);
      }

      const tMemSave = Date.now();
      // Stage IV persistence is write-only; graph derivation and embeddings
      // were completed before the mutation boundary above.
      await persistGraphProjection(this.options.graphStore, graphPlan);
      await persistVectorRecords(this.options.vectorIndex, vectorRecords);

      // Stage V: Lexicon construction (dictionary + thesaurus from extracted facts)
      if (this.options.enableDictionaryIndexing !== false && this.options.dictionary) {
        // Use corpus-scoped dictionary if factory is available, otherwise fall back to shared
        const scopedDictionary = this.options.dictionaryFactory
          ? this.options.dictionaryFactory(corpusId)
          : this.options.dictionary;
        const lexiconBuilder = new LexiconBuilder(
          scopedDictionary,
          this.options.db,
          corpusId,
        );
        const lexResult = await lexiconBuilder.buildIncremental(
          document.documentId,
          delta.facts,
          delta.passages,
        );
        console.log(
          `  [${document.title}] Stage V: dict=${lexResult.dictionaryEntries} thesaurus=${lexResult.thesaurusRelations} ambiguous=${lexResult.ambiguousExcluded}`,
        );
        console.log(
          `  [${document.title}] timings_ms: stageI(extract+embed)=${tStageI - tStart} memSave=${tMemSave - tStageI} graphProject+rest=${Date.now() - tMemSave}`,
        );
      }

      console.log(
        `  [${document.title}] chunks=${records.length} schemas=${schemas.length} facts=${allFacts.length} nodes=${graphPlan.nodes.length} edges=${graphPlan.edges.length} conflicts=${conflictCount}`,
      );

      return {
        processedDocumentId: document.documentId,
        addedNodes: graphPlan.nodes.length,
        addedEdges: graphPlan.edges.length,
        conflicts: conflictCount,
        memoryDeltaMutationCount: upsertResult?.mutationCount ?? 1,
      };
    } catch (error) {
      throw new DocumentMutationError(error);
    }
  }
}
