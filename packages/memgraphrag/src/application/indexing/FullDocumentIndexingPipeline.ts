/**
 * Full Document Indexing Pipeline — Algorithm 1 (Stage I–IV).
 * Replaces MinimalDocumentIndexingPipeline for real indexing.
 */
import type Database from 'better-sqlite3';
import type { DocumentIndexingPipeline, ProcessDocumentResult } from './AsyncJobRunner.js';
import type { IndexDocumentInput } from './StageIExtractor.js';
import { StageIExtractor } from './StageIExtractor.js';
import { StageIICanonicalizer } from './StageIICanonicalizer.js';
import { projectGraph, upsertVectors } from './StageIVGraphProjector.js';
import { SymbolicCanonicalizer } from './SymbolicCanonicalizer.js';
import { SymbolicConflictDetector } from './SymbolicConflictDetector.js';
import { LLMConflictResolver } from './LLMConflictResolver.js';
import { detectConflicts, resolveConflicts, recordConflictAudit } from './StageIIIConflictPipeline.js';
import type { ILLMProvider, IEmbeddingProvider, INLPExtractor } from '../../domain/provider/index.js';
import type { IGraphStore, IVectorIndex, IMemoryStore } from '../../domain/storage/index.js';
import type { Fact } from '../../domain/memory/fact.js';
import { LLMExtractionAgent } from './LLMExtractionAgent.js';
import { LexiconBuilder } from './LexiconBuilder.js';

export interface FullPipelineOptions {
  readonly db: Database.Database;
  readonly graphStore: IGraphStore;
  readonly vectorIndex: IVectorIndex;
  readonly memoryStore: IMemoryStore;
  readonly llmProvider: ILLMProvider;
  readonly embeddingProvider: IEmbeddingProvider;
  readonly nlpExtractor: INLPExtractor;
  readonly enableConflictResolution?: boolean;
  readonly enableDictionaryIndexing?: boolean;
  readonly dictionary?: import('../../domain/dictionary/termDictionary.js').ITermDictionary;
  /** Factory to create a corpus-scoped ITermDictionary. Used by Stage V to satisfy FK constraints. */
  readonly dictionaryFactory?: (corpusId: string) => import('../../domain/dictionary/termDictionary.js').ITermDictionary;
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
    const stageII = new StageIICanonicalizer(corpusId, this.options.memoryStore);
    const schemas = await stageII.canonicalizeSchemas(records, this.canonicalizer);
    await stageII.incrementSchemaFrequency(schemas);
    const stableIds = await stageII.promoteStableSchemas();
    await stageII.cascadeActivateFacts(stableIds);

    // Build facts from candidates (use normalized types for matching)
    const allFacts: Fact[] = [];
    for (const record of records) {
      for (const candidate of record.candidateFacts) {
        // LLM extractors occasionally omit type/relation fields; skip such
        // malformed candidates instead of crashing the whole document job.
        if (!candidate.headType || !candidate.relation || !candidate.tailType) continue;
        const normHead = candidate.headType.toLowerCase().trim();
        const normRel = candidate.relation.toLowerCase().trim();
        const normTail = candidate.tailType.toLowerCase().trim();
        const matchedSchema = schemas.find(
          (s) => s.headType === normHead && s.relation === normRel && s.tailType === normTail,
        );
        if (!matchedSchema) continue;

        const factId = `fact:${document.documentId}:${candidate.headEntity}:${candidate.relation}:${candidate.tailEntity}`.replace(/\s+/g, '_');
        allFacts.push({
          factId,
          corpusId,
          schemaId: matchedSchema.schemaId,
          headEntity: candidate.headEntity,
          headType: candidate.headType,
          relation: candidate.relation,
          tailEntity: candidate.tailEntity,
          tailType: candidate.tailType,
          state: matchedSchema.state === 'stable' ? 'active' : 'inactive',
          passageIds: [record.sourcePassage.passageId],
          sourceDocumentIds: [document.documentId],
          confidence: candidate.confidence,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // Stage III: Conflict detection and resolution
    let conflictCount = 0;
    if (this.options.enableConflictResolution !== false) {
      const passages = records.map((r) => r.sourcePassage);
      const detector = new SymbolicConflictDetector({
        loadFacts: async (cid) => {
          const snap = await this.options.memoryStore.load(cid);
          return snap.facts;
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

    // Save facts and passages to memory (incremental — avoid full snapshot reload)
    const passages = records.map((r) => r.sourcePassage);
    const snapshot = await this.options.memoryStore.load(corpusId);
    // Only save schemas (which need full state for canonicalization) + new data
    // Using upsert semantics: existing passages/facts won't be deleted
    await this.options.memoryStore.save({
      corpusId,
      schemas: snapshot.schemas,
      facts: allFacts,
      passages,
      exportedAt: new Date().toISOString(),
      schemaVersion: snapshot.schemaVersion ?? 1,
    });

    const tMemSave = Date.now();
    // Stage IV: Project graph and upsert vectors
    const { nodes, edges } = await projectGraph(
      this.options.graphStore, allFacts, schemas, passages,
    );

    await upsertVectors(this.options.vectorIndex, this.options.embeddingProvider, nodes);

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
        allFacts,
        passages,
      );
      console.log(
        `  [${document.title}] Stage V: dict=${lexResult.dictionaryEntries} thesaurus=${lexResult.thesaurusRelations} ambiguous=${lexResult.ambiguousExcluded}`,
      );
      console.log(
        `  [${document.title}] timings_ms: stageI(extract+embed)=${tStageI - tStart} memSave=${tMemSave - tStageI} graphProject+rest=${Date.now() - tMemSave}`,
      );
    }

    console.log(
      `  [${document.title}] chunks=${records.length} schemas=${schemas.length} facts=${allFacts.length} nodes=${nodes.length} edges=${edges.length} conflicts=${conflictCount}`,
    );

    return {
      processedDocumentId: document.documentId,
      addedNodes: nodes.length,
      addedEdges: edges.length,
      conflicts: conflictCount,
    };
  }
}
