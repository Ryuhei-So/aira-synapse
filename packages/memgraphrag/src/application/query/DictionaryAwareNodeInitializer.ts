/**
 * Application Layer — Dictionary-aware node initializer decorator.
 * DES-MG3-010: Injects dictionary-matched fact nodes into PPR teleport vector.
 *
 * Wraps an existing INodeInitializer and augments its output with
 * dictionary-derived scores for fact nodes matching query terms.
 */

import type {
  INodeInitializer,
  NodeInitializationRequest,
  NodeInitializationVector,
} from '../../domain/retrieval/memoryFilter.js';
import type { ITermDictionary } from '../../domain/dictionary/termDictionary.js';
import type { IMemoryStore } from '../../domain/storage/index.js';
import type { LanguageCode } from '../../domain/memory/types.js';

/** Max dictionary-injected facts per matched entity */
const MAX_PER_ENTITY = parseInt(process.env.DICT_MAX_PER_ENTITY || '3');
/** Max total dictionary-injected facts across all entities */
const MAX_TOTAL = parseInt(process.env.DICT_MAX_TOTAL || '10');
/** Score multiplier for dictionary-injected facts (fraction of maxBaseScore) */
const INJECTION_SCORE_RATIO = parseFloat(process.env.DICT_SCORE_RATIO || '0.1');
/** Minimum confidence threshold for dictionary entries */
const MIN_CONFIDENCE = parseFloat(process.env.DICT_MIN_CONFIDENCE || '0.7');

export class DictionaryAwareNodeInitializer implements INodeInitializer {
  constructor(
    private readonly inner: INodeInitializer,
    private readonly dictionary: ITermDictionary,
    private readonly memoryStore: IMemoryStore,
    private readonly language: LanguageCode = 'en',
  ) {}

  public async initialize(
    request: NodeInitializationRequest,
  ): Promise<NodeInitializationVector> {
    const base = await this.inner.initialize(request);
    const matches = await this.dictionary.match(request.query.text, this.language);

    // Filter by confidence threshold
    const validMatches = matches.filter((m) => m.entry.confidence >= MIN_CONFIDENCE);
    if (validMatches.length === 0) {
      return base;
    }

    // Compute max base score (fallback 1.0 if no positive scores)
    const positiveScores = Object.values(base.scores).filter((s) => s > 0);
    const maxBaseScore = positiveScores.length > 0 ? Math.max(...positiveScores) : 1.0;
    const injectionScore = maxBaseScore * INJECTION_SCORE_RATIO;

    // Collect matched entity names (canonical + aliases)
    const matchedEntities = new Set<string>();
    for (const m of validMatches) {
      matchedEntities.add(m.entry.canonicalForm.toLowerCase());
      for (const alias of m.entry.aliases) {
        matchedEntities.add(alias.toLowerCase());
      }
    }

    // Load snapshot to find facts matching dictionary entities
    const snapshot = await this.memoryStore.load(request.query.corpusId);
    const activeFacts = snapshot.facts.filter((f) => f.state === 'active');

    // Find facts referencing matched entities, capped per entity
    const entityFactCounts = new Map<string, number>();
    const injected: Record<string, number> = {};
    let totalInjected = 0;

    for (const fact of activeFacts) {
      if (totalInjected >= MAX_TOTAL) break;

      const factKey = `fact:${fact.factId}`;
      // Skip facts already in base vector
      if (base.scores[factKey] !== undefined) continue;

      const headNorm = fact.headEntity.toLowerCase();
      const tailNorm = fact.tailEntity.toLowerCase();
      const matchedEntity = matchedEntities.has(headNorm)
        ? headNorm
        : matchedEntities.has(tailNorm)
          ? tailNorm
          : null;

      if (!matchedEntity) continue;

      const currentCount = entityFactCounts.get(matchedEntity) ?? 0;
      if (currentCount >= MAX_PER_ENTITY) continue;

      injected[factKey] = injectionScore;
      entityFactCounts.set(matchedEntity, currentCount + 1);
      totalInjected++;
    }

    if (totalInjected === 0) {
      return base;
    }

    // Merge and L1-normalize
    const merged: Record<string, number> = { ...base.scores, ...injected };
    const sum = Object.values(merged).reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (const key of Object.keys(merged)) {
        merged[key] = merged[key]! / sum;
      }
    }

    return {
      scores: merged,
      fallbackTriggered: base.fallbackTriggered,
      injectedCount: totalInjected,
    };
  }
}
