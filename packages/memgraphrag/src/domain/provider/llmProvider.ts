/**
 * Domain Layer — Provider ports (LLM, Embedding, NLP).
 * DES-MG-011: External provider abstractions.
 */

import type { LanguageCode } from '../memory/types.js';

// --- LLM Provider ---

export type ReasoningEffort = 'low' | 'medium' | 'high';
export type Verbosity = 'low' | 'medium' | 'high';

export interface TextGenerationRequest {
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: 'text' | 'json';
  /** Reasoning effort for reasoning models (gpt-5, o-series). Ignored for non-reasoning models. */
  readonly reasoningEffort?: ReasoningEffort;
  /** Output verbosity for reasoning models. Ignored for non-reasoning models. */
  readonly verbosity?: Verbosity;
  /** AbortSignal for cancellation. When aborted, the provider should reject promptly. */
  readonly signal?: AbortSignal;
}

export interface TextGenerationResponse {
  readonly text: string;
  readonly model: string;
  readonly finishReason?: 'stop' | 'length' | 'content_filter' | string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface ProviderHealth {
  readonly healthy: boolean;
  readonly message?: string;
}

export interface ILLMProvider {
  generate(request: TextGenerationRequest): Promise<TextGenerationResponse>;
  healthCheck(): Promise<ProviderHealth>;
}

// --- Embedding Provider ---

export interface EmbeddingRequest {
  readonly texts: readonly string[];
  readonly model?: string;
}

export interface EmbeddingResponse {
  readonly model: string;
  readonly vectors: readonly (readonly number[])[];
  readonly cached: boolean;
}

export interface IEmbeddingProvider {
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  healthCheck(): Promise<ProviderHealth>;
}

// --- NLP Extractor ---

export interface NlpEntity {
  readonly text: string;
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly confidence?: number;
}

export interface NlpExtractionRequest {
  readonly text: string;
  readonly language: LanguageCode;
}

export interface NlpExtractionResponse {
  readonly language: LanguageCode;
  readonly entities: readonly NlpEntity[];
  readonly nounPhrases: readonly string[];
}

export interface INLPExtractor {
  extract(request: NlpExtractionRequest): Promise<NlpExtractionResponse>;
  healthCheck(): Promise<ProviderHealth>;
}
