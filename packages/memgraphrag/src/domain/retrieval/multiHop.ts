/**
 * Domain Layer — Multi-hop reasoning types and interfaces.
 * REQ-MH-001 to REQ-MH-010: Multi-hop reasoning chain for bridge questions.
 */

// --- Enums ---

export type QuestionType = 'bridge' | 'comparison' | 'simple';

export type MultiHopFallbackReason =
  | 'decomposition_parse_error'
  | 'decomposition_missing_field'
  | 'decomposition_missing_placeholder'
  | 'decomposition_duplicate_hops'
  | 'hop1_empty'
  | 'hop1_ungrounded'
  | 'hop2_empty'
  | 'hop2_ungrounded'
  | 'timeout'
  | 'llm_api_error';

// --- Value Objects ---

export interface Decomposition {
  readonly hop1SubQuestion: string;
  readonly hop2SubQuestion: string; // contains {hop1Answer} placeholder
  readonly bridgeEntityHint?: string;
}

export interface HopResult {
  readonly answer: string;
  readonly passageIds: readonly string[];
  readonly grounded: boolean;
}

export interface MultiHopResult {
  readonly answer: string;
  readonly questionType: QuestionType;
  readonly hop1?: HopResult;
  readonly hop2?: HopResult;
  readonly fallbackReason?: MultiHopFallbackReason;
  readonly fellBack: boolean;
  readonly latencyMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

// --- Options ---

export interface MultiHopOptions {
  readonly timeoutMs?: number;
  readonly enableSelfConsistency?: boolean;
  readonly selfConsistencyN?: number;
  readonly signal?: AbortSignal;
}

// --- Port Interface ---

export interface IMultiHopReasoner {
  reason(
    query: string,
    passages: readonly { id: string; text: string }[],
    options?: MultiHopOptions,
  ): Promise<MultiHopResult>;
}
