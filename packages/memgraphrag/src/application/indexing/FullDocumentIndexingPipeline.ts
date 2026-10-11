/**
 * Full Document Indexing Pipeline — Algorithm 1 (Stage I–IV).
 * Replaces MinimalDocumentIndexingPipeline for real indexing.
 */
import type Database from 'better-sqlite3';
import {
  DocumentMutationError,
  DocumentReplaceRefusedError,
  DocumentReplaceStateInconsistentError,
  type DocumentIndexingPipeline,
  type ProcessDocumentResult,
} from './AsyncJobRunner.js';
import type { IndexDocumentInput } from './StageIExtractor.js';
import { StageIExtractor } from './StageIExtractor.js';
import { StageIICanonicalizer } from './StageIICanonicalizer.js';
import {
  buildVectorRecords,
  buildVectorRecordsFromInputs,
  assertSchemaHydrationGraphStore,
  persistGraphProjection,
  persistVectorRecords,
  planCanonicalGraphProjection,
  planCanonicalGraphHydrationRequests,
  planGraphProjection,
  rebindVectorRecords,
  type GraphProjectionPlan,
} from './StageIVGraphProjector.js';
import { SymbolicCanonicalizer } from './SymbolicCanonicalizer.js';
import { SymbolicConflictDetector } from './SymbolicConflictDetector.js';
import { LLMConflictResolver } from './LLMConflictResolver.js';
import { detectConflicts, resolveConflicts, recordConflictAudit } from './StageIIIConflictPipeline.js';
import type { ILLMProvider, IEmbeddingProvider, INLPExtractor } from '../../domain/provider/index.js';
import {
  isSchemaCanonicalizationMemory,
  type IGraphStore,
  type IIndexingMemory,
  type IVectorIndex,
} from '../../domain/storage/index.js';
import type {
  ISchemaCanonicalizationMemory,
  SchemaCanonicalizationProjection,
} from '../../domain/storage/schemaCanonicalization.js';
import type { IDocumentReplaceMemory } from '../../domain/storage/documentReplace.js';
import type { ActivateFactsRequest } from '../../domain/storage/indexingMemory.js';
import type { Passage } from '../../domain/memory/passage.js';
import {
  predictPostDeleteProjection,
  type CanonicalSchemaPreparation,
  type PreparedSchemaView,
} from './StageIICanonicalizer.js';
import type { SchemaHydrationWireParams } from '../../domain/storage/schemaCanonicalization.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { ITermDictionary } from '../../domain/dictionary/termDictionary.js';
import { LLMExtractionAgent } from './LLMExtractionAgent.js';
import { LexiconBuilder } from './LexiconBuilder.js';
import {
  buildCanonicalizationMemoryDelta,
  buildDocumentFacts,
  buildDocumentMemoryDelta,
} from './DocumentMemoryPlan.js';

function freezeTree<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
  return value;
}

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
  /**
   * Per-document replace delete (literature-hub #614).  Only consulted for a
   * document with `replaceExisting: true`; without it such a document is
   * refused before any write.
   */
  readonly documentReplace?: IDocumentReplaceMemory;
}

interface CanonicalLanePlan {
  readonly canonicalDelta: ReturnType<typeof buildCanonicalizationMemoryDelta>;
  readonly graphPlan: GraphProjectionPlan;
  readonly hydrationRequests: readonly SchemaHydrationWireParams[];
}

function planningKey(view: PreparedSchemaView): string {
  return JSON.stringify([view.schemaId, view.frequency, view.state, view.contributionPresent, view.isNew]);
}

function factPlanningKey(fact: Fact): string {
  return JSON.stringify([fact.factId, fact.state]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
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

  /**
   * Replace is supported on the canonical lane only (design #612 §5.2): a
   * legacy-lane schema write after the delete would restore the deleted
   * document from full schemas read before it.  Decided from configuration
   * alone, so the refusal precedes extraction, every native RPC and the
   * sqlite documents row.  The job runner still records the refusal on the
   * job row and commits its batch, which has no mutation from this document.
   */
  private requireReplaceSupport(documentId: string): IDocumentReplaceMemory {
    // Fact ids are `fact:{documentId}:{schemaId}:…`; a ':' in the document id
    // would make one document's fact-id prefix match another's.
    if (documentId.includes(':')) {
      throw new DocumentReplaceRefusedError('document id contains ":"');
    }
    if (!isSchemaCanonicalizationMemory(this.options.indexingMemory)) {
      throw new DocumentReplaceRefusedError('indexing memory has no canonical schema lane');
    }
    if (!this.options.documentReplace) {
      throw new DocumentReplaceRefusedError('backend has no memory_delete_document');
    }
    return this.options.documentReplace;
  }

  /**
   * Deterministic canonical-lane planning and validation.  Shared by the
   * pre-mutation plan and the in-batch replace re-plan so both run exactly
   * the same checks in the same order.
   */
  private planCanonicalLane(
    corpusId: string,
    documentId: string,
    canonicalMemory: ISchemaCanonicalizationMemory,
    preparation: CanonicalSchemaPreparation,
    facts: readonly Fact[],
    passages: readonly Passage[],
    activation: ActivateFactsRequest | undefined,
    now: string,
  ): CanonicalLanePlan {
    const canonicalDelta = freezeTree(buildCanonicalizationMemoryDelta(
      corpusId,
      preparation.schemaViews,
      preparation.mergeIntents,
      facts,
      passages,
      now,
    ));
    // Complete deterministic validation, including the graph marker shape,
    // before embedding or the first mutation.
    canonicalMemory.preflightSchemaCanonicalizationDelta(canonicalDelta);
    if (activation) {
      this.options.indexingMemory.preflightMutation({
        delta: { corpusId, passages: [], facts: [], schemas: [], exportedAt: now },
        activation,
      });
    }
    const graphPlan = planCanonicalGraphProjection(
      facts,
      preparation.schemaViews,
      passages,
      documentId,
    );
    assertSchemaHydrationGraphStore(this.options.graphStore);
    const schemaCapability = canonicalMemory.schemaCanonicalizationCapability;
    if (!schemaCapability) {
      throw new Error('schema canonicalization capability is unavailable');
    }
    const hydrationRequests = planCanonicalGraphHydrationRequests(graphPlan, schemaCapability);
    for (const request of hydrationRequests) {
      this.options.graphStore.preflightSchemaHydration(request);
    }
    return { canonicalDelta, graphPlan, hydrationRequests };
  }

  public async processDocument(
    corpusId: string,
    document: IndexDocumentInput,
  ): Promise<ProcessDocumentResult> {
    const documentReplace = document.replaceExisting === true
      ? this.requireReplaceSupport(document.documentId)
      : undefined;
    const now = new Date().toISOString();

    const writeDocumentRow = (): void => {
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
    };
    // A replace writes the row only just before its mutation section, so a
    // replace that keeps the existing version (no chunks, or refused) leaves
    // its row untouched.
    if (!documentReplace) writeDocumentRow();

    // Stage I: Extract chunks, entities, schemas, facts
    const tStart = Date.now();
    const records = await this.stageI.extractChunks(corpusId, document);
    const tStageI = Date.now();

    if (records.length === 0) {
      if (documentReplace) {
        // Keep the existing version: a replace never commits a delete
        // without new content.  An ordinary, chargeable document failure.
        throw new Error('replace produced no indexable chunks; the existing version is kept');
      }
      return { processedDocumentId: document.documentId, addedNodes: 0, addedEdges: 0, conflicts: 0 };
    }

    // Stage II: Canonicalize schemas and merge into memory
    const stageII = new StageIICanonicalizer(corpusId, this.options.indexingMemory);
    const candidateSchemas = await stageII.canonicalizeSchemas(records, this.canonicalizer);
    // A negotiated native projection is selected only when this document has
    // schema candidates.  A schema-free document keeps the established empty
    // legacy delta shape so passages/facts remain a valid no-schema update.
    const canonicalMemory: ISchemaCanonicalizationMemory | undefined = candidateSchemas.length > 0
      && isSchemaCanonicalizationMemory(this.options.indexingMemory)
      ? this.options.indexingMemory
      : undefined;
    // Replace planning (design #612 §5.2): before the delete, plan against
    // the post-delete state the native will produce, so fact states and
    // conflict detection match what commits.  Activation is decided against
    // the committed (pre-delete) state: a schema the delete only demotes
    // inside the batch is not newly stable and must not re-activate other
    // documents' inactive facts.
    const committedProjections = new Map<string, SchemaCanonicalizationProjection>();
    const replaceActivationIds = (preparation: CanonicalSchemaPreparation): readonly string[] =>
      preparation.newlyStableSchemaIds.filter((schemaId) => committedProjections.get(schemaId)?.state !== 'stable');
    // A schema-bearing document always takes the canonical lane here:
    // requireReplaceSupport refused a replace without a canonical memory, so
    // a replace reaches the legacy lane only with zero schemas.
    const canonicalPreparation = canonicalMemory
      ? documentReplace
        ? await stageII.prepareCanonicalSchemas(candidateSchemas, document.documentId, undefined, {
          projectionView: (projection) => {
            committedProjections.set(projection.schemaId, projection);
            return predictPostDeleteProjection(projection);
          },
        })
        : await stageII.prepareCanonicalSchemas(candidateSchemas, document.documentId)
      : undefined;
    const legacyPreparation = canonicalPreparation === undefined
      ? await stageII.prepareSchemas(candidateSchemas)
      : undefined;
    let schemas = canonicalPreparation?.schemaViews ?? legacyPreparation!.finalSchemas;
    const newlyStableSchemaIds = canonicalPreparation
      ? documentReplace ? replaceActivationIds(canonicalPreparation) : canonicalPreparation.newlyStableSchemaIds
      : legacyPreparation?.newlyStableSchemaIds
      ?? [];

    // Schema candidates retain occurrence pressure, while repeated fact
    // candidates fold to one identity with all supporting passage provenance.
    let allFacts: Fact[] = [...buildDocumentFacts(
      corpusId,
      document.documentId,
      records,
      schemas,
      now,
    )];

    // Stage III: Conflict detection and resolution
    let conflictCount = 0;
    let inactivatedFactIds: ReadonlySet<string> = new Set();
    if (this.options.enableConflictResolution !== false) {
      const passages = records.map((r) => r.sourcePassage);
      const loadedActiveFacts = allFacts.some((fact) => fact.state === 'active')
        ? await this.options.indexingMemory.getActiveFacts({ corpusId, limit: 100 })
        : [];
      // A replace deletes the facts sourced only from this document before
      // its new facts are written; they must not conflict with their own
      // successors.  Known limitation: the window is the native's first
      // INDEXING_MEMORY_CONTRACT.maxActiveFacts (100) active facts in
      // snapshot order and memory_get_active_facts takes exactly
      // {corpusId, limit}, so the filtered facts are not replaced by others.
      // Excluding them in the read needs a native parameter.
      const activeFacts = documentReplace
        ? loadedActiveFacts.filter((fact) => !(fact.sourceDocumentIds.length > 0
          && fact.sourceDocumentIds.every((id) => id === document.documentId)))
        : loadedActiveFacts;
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
        inactivatedFactIds = inactivatedIds;
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
    let activation = newlyStableSchemaIds.length > 0
      ? { corpusId, schemaIds: newlyStableSchemaIds, updatedAt: now }
      : undefined;

    let delta: ReturnType<typeof buildDocumentMemoryDelta> | ReturnType<typeof buildCanonicalizationMemoryDelta>;
    let canonicalDelta: ReturnType<typeof buildCanonicalizationMemoryDelta> | undefined;
    let legacyDelta: ReturnType<typeof buildDocumentMemoryDelta> | undefined;
    let graphPlan: GraphProjectionPlan;
    let hydrationRequests: readonly SchemaHydrationWireParams[] | undefined;
    let vectorRecords;
    if (canonicalPreparation && canonicalMemory) {
      const plan = this.planCanonicalLane(
        corpusId,
        document.documentId,
        canonicalMemory,
        canonicalPreparation,
        allFacts,
        passages,
        activation,
        now,
      );
      canonicalDelta = plan.canonicalDelta;
      delta = canonicalDelta;
      graphPlan = plan.graphPlan;
      hydrationRequests = plan.hydrationRequests;
      vectorRecords = await buildVectorRecordsFromInputs(
        this.options.embeddingProvider,
        graphPlan.vectorInputs ?? [],
      );
    } else {
      legacyDelta = buildDocumentMemoryDelta(
        corpusId,
        legacyPreparation!.finalSchemas,
        allFacts,
        passages,
        now,
      );
      delta = legacyDelta;
      // Complete deterministic validation and external provider work before
      // the first mutation. Admission failures after this boundary are
      // uncertain and must poison the whole owner transaction.
      this.options.indexingMemory.preflightMutation(
        activation ? { delta: legacyDelta, activation } : { delta: legacyDelta },
      );
      graphPlan = planGraphProjection(legacyDelta.facts, legacyDelta.schemas, legacyDelta.passages);
      vectorRecords = await buildVectorRecords(
        this.options.embeddingProvider,
        graphPlan.nodes,
      );
    }

    if (documentReplace) writeDocumentRow();
    let activationApplied = false;
    try {
      if (documentReplace) {
        // Replace (design #612 §5.2): delete inside the open batch, then
        // re-read the schema projections, which now show the post-delete
        // state, and rebuild the merge intents from that read through the
        // same preparation code.  Any failure from here on is a
        // DocumentMutationError, so the batch never commits the delete
        // without its upsert.
        await documentReplace.memoryDeleteDocument({
          corpusId,
          documentId: document.documentId,
          updatedAt: now,
        });
        if (canonicalPreparation && canonicalMemory) {
          const fresh = await stageII.prepareCanonicalSchemas(candidateSchemas, document.documentId);
          const freshFacts = buildDocumentFacts(
            corpusId,
            document.documentId,
            records,
            fresh.schemaViews,
            now,
          ).map((fact) => (inactivatedFactIds.has(fact.factId)
            ? { ...fact, state: 'inactive' as const }
            : fact));
          // The pre-delete plan used the predicted post-delete projection, so
          // the in-batch read must agree on every planning field: identity is
          // fixed by the extracted candidates and the document, and the
          // prediction is the native's own schema rule for a schema that
          // lists the document.  The projection cannot show the native's
          // other two rules (a schema listing one of the document's facts, or
          // named by one of its stored facts, without listing the document);
          // those legacy-era shapes surface here.  Disagreement means the
          // facts were planned (and conflict-checked) against the wrong
          // state: never commit that; park it.  No replace read scales with a
          // schema's factIds.
          if (!sameIds(fresh.schemaViews.map(planningKey), canonicalPreparation.schemaViews.map(planningKey))
            || !sameIds(freshFacts.map(factPlanningKey), allFacts.map(factPlanningKey))) {
            throw new DocumentReplaceStateInconsistentError(
              document.documentId,
              'replace in-batch schema state differs from the pre-delete prediction',
            );
          }
          const freshActivationIds = replaceActivationIds(fresh);
          const freshActivation = freshActivationIds.length > 0
            ? { corpusId, schemaIds: freshActivationIds, updatedAt: now }
            : undefined;
          const plan = this.planCanonicalLane(
            corpusId,
            document.documentId,
            canonicalMemory,
            fresh,
            freshFacts,
            passages,
            freshActivation,
            now,
          );
          vectorRecords = rebindVectorRecords(
            vectorRecords,
            graphPlan.vectorInputs ?? [],
            plan.graphPlan.vectorInputs ?? [],
          );
          schemas = fresh.schemaViews;
          allFacts = freshFacts;
          activation = freshActivation;
          canonicalDelta = plan.canonicalDelta;
          delta = canonicalDelta;
          graphPlan = plan.graphPlan;
          hydrationRequests = plan.hydrationRequests;
          // Activate before writing this document's facts: activation flips
          // every inactive fact of a newly stable schema, and this
          // document's facts must land with exactly the states conflict
          // resolution decided (a fresh insert never re-activates them).
          if (activation) {
            await this.options.indexingMemory.activateFactsBySchemaIds(activation);
            activationApplied = true;
          }
        }
      }
      const upsertResult = canonicalDelta && canonicalMemory
        ? await canonicalMemory.upsertSchemaCanonicalizationDelta(canonicalDelta)
        : await this.options.indexingMemory.upsertDelta(legacyDelta!);
      if (activation && !activationApplied) {
        await this.options.indexingMemory.activateFactsBySchemaIds(activation);
      }

      const tMemSave = Date.now();
      // Stage IV persistence is write-only; graph derivation and embeddings
      // were completed before the mutation boundary above.
      await persistGraphProjection(this.options.graphStore, graphPlan, hydrationRequests);
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

      const addedNodeCount = graphPlan.nodes.length + (graphPlan.schemaNodeRefs?.length ?? 0);
      console.log(
        `  [${document.title}] chunks=${records.length} schemas=${schemas.length} facts=${allFacts.length} nodes=${addedNodeCount} edges=${graphPlan.edges.length} conflicts=${conflictCount}`,
      );

      return {
        processedDocumentId: document.documentId,
        addedNodes: addedNodeCount,
        addedEdges: graphPlan.edges.length,
        conflicts: conflictCount,
        memoryDeltaMutationCount: upsertResult?.mutationCount ?? 1,
      };
    } catch (error) {
      // Already a DocumentMutationError carrying its replace-state code.
      if (error instanceof DocumentReplaceStateInconsistentError) throw error;
      throw new DocumentMutationError(error);
    }
  }
}
