/**
 * Domain Layer — PPR, GraphProjection, LexicalRetriever, ContextBuilder ports.
 * DES-MG-009: Personalized PageRank and context construction.
 */

import type { MemoryLayer } from '../memory/types.js';
import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { NodeInitializationVector, QueryRequest } from './memoryFilter.js';

/** Shared v15/legacy default; callers may override it through PPRRequest. */
export const DEFAULT_HUB_DEGREE_THRESHOLD = 50;

export interface RankedNode {
  readonly nodeId: string;
  readonly score: number;
  readonly layer: MemoryLayer;
}

export interface TransitionEntry {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly weight: number;
}

export interface IGraphProjection {
  getTransitions(corpusId: string): AsyncIterable<TransitionEntry>;
  getDanglingNodes(corpusId: string): Promise<readonly string[]>;
  getNodeCount(corpusId: string): Promise<number>;
}

export interface PPRRequest {
  readonly corpusId: string;
  readonly initialVector: NodeInitializationVector;
  readonly teleportProbability: number;
  readonly convergenceEpsilon: number;
  readonly maxIterations: number;
  readonly hubDegreeThreshold: number;
  readonly topK: number;
  readonly topM: number;
}

export interface PPRResult {
  readonly rankedPassages: readonly RankedNode[];
  readonly rankedEntities: readonly RankedNode[];
  readonly iterations: number;
  readonly converged: boolean;
  readonly l1Delta: number;
}

export interface ContextBundle {
  readonly promptContext: string;
  readonly citedPassages: readonly Passage[];
  readonly citedFacts: readonly Fact[];
  readonly confidence: number;
  readonly metadata?: {
    readonly aliasHintCount?: number;
  };
}

export interface ILexicalRetriever {
  indexPassages(
    corpusId: string,
    passages: readonly Passage[],
  ): Promise<void>;
  search(
    corpusId: string,
    query: string,
    topK: number,
  ): Promise<readonly { passageId: string; score: number }[]>;
  deleteByDocument(corpusId: string, documentId: string): Promise<void>;
}

export interface IPPR {
  run(request: PPRRequest, projection: IGraphProjection): Promise<PPRResult>;
}

export interface IContextBuilder {
  build(query: QueryRequest, ranking: PPRResult): Promise<ContextBundle>;
}
