/**
 * Application Layer — MultiHopReasoner: the main orchestrator.
 * T5d: Combines decomposition, hop execution, abort/timeout (fallback 9-10),
 * self-consistency, and the full pipeline.
 */

import type { ILLMProvider } from '../../domain/provider/llmProvider.js';
import type {
  IMultiHopReasoner,
  MultiHopOptions,
  MultiHopResult,
  HopResult,
  QuestionType,
} from '../../domain/retrieval/multiHop.js';
import { classifyQuestion } from './multiHopHelpers.js';
import { decomposeQuestion } from './multiHopDecompose.js';
import { executeHop } from './multiHopExecute.js';
import { majorityVote } from './multiHopParsers.js';
import { GuardedUsage, raceWithAbort } from './multiHopInfra.js';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_SC_N = 3;

export class MultiHopReasoner implements IMultiHopReasoner {
  constructor(private readonly llm: ILLMProvider) {}

  async reason(
    query: string,
    passages: readonly { id: string; text: string }[],
    options?: MultiHopOptions,
  ): Promise<MultiHopResult> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const enableSC = options?.enableSelfConsistency ?? false;
    const scN = options?.selfConsistencyN ?? DEFAULT_SC_N;

    const questionType = classifyQuestion(query);

    // Comparison and simple questions skip multi-hop
    if (questionType !== 'bridge') {
      return this.buildSkipResult(questionType, startTime);
    }

    const usage = new GuardedUsage(options?.signal);

    const outcome = await raceWithAbort(
      async (signal) => this.pipeline(query, passages, signal, usage, enableSC, scN),
      timeoutMs,
      options?.signal,
    );

    usage.settle();
    const latencyMs = Date.now() - startTime;

    // Timeout fallback (condition 9)
    if (outcome.abortCause === 'timeout') {
      return {
        answer: '',
        questionType: 'bridge',
        fellBack: true,
        fallbackReason: 'timeout',
        latencyMs,
        usage: usage.snapshot(),
      };
    }

    // Pipeline completed
    if (outcome.result) {
      return { ...outcome.result, latencyMs, usage: usage.snapshot() };
    }

    // Pipeline error (shouldn't normally reach here)
    return {
      answer: '',
      questionType: 'bridge',
      fellBack: true,
      fallbackReason: 'llm_api_error',
      latencyMs,
      usage: usage.snapshot(),
    };
  }

  private async pipeline(
    query: string,
    passages: readonly { id: string; text: string }[],
    signal: AbortSignal,
    usage: GuardedUsage,
    enableSC: boolean,
    scN: number,
  ): Promise<Omit<MultiHopResult, 'latencyMs' | 'usage'>> {
    // Step 1: Decompose
    let decompResult;
    try {
      decompResult = await decomposeQuestion(query, this.llm, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      // Fallback 10: LLM API error
      return {
        answer: '',
        questionType: 'bridge',
        fellBack: true,
        fallbackReason: 'llm_api_error',
      };
    }
    usage.add(decompResult.usage.inputTokens, decompResult.usage.outputTokens);

    if (decompResult.fallbackReason) {
      return {
        answer: '',
        questionType: 'bridge',
        fellBack: true,
        fallbackReason: decompResult.fallbackReason,
      };
    }

    const decomposition = decompResult.decomposition!;

    // Step 2: Hop-1
    let hop1Result;
    try {
      hop1Result = await executeHop(decomposition.hop1SubQuestion, passages, this.llm, 'hop1', signal);
    } catch (err) {
      if (signal.aborted) throw err;
      return {
        answer: '',
        questionType: 'bridge',
        fellBack: true,
        fallbackReason: 'llm_api_error',
      };
    }
    usage.add(hop1Result.usage.inputTokens, hop1Result.usage.outputTokens);

    if (hop1Result.fallbackReason) {
      return {
        answer: '',
        questionType: 'bridge',
        hop1: hop1Result.hop,
        fellBack: true,
        fallbackReason: hop1Result.fallbackReason,
      };
    }

    const hop1Answer = hop1Result.hop!.answer;

    // Step 3: Hop-2 (substitute hop1Answer into template)
    const hop2Question = decomposition.hop2SubQuestion.replace(/\{hop1Answer\}/g, hop1Answer);

    if (enableSC && scN > 1) {
      // Self-consistency on hop-2
      return this.hop2WithSC(hop2Question, passages, signal, usage, scN, hop1Result.hop!);
    }

    // Single hop-2
    let hop2Result;
    try {
      hop2Result = await executeHop(hop2Question, passages, this.llm, 'hop2', signal);
    } catch (err) {
      if (signal.aborted) throw err;
      return {
        answer: '',
        questionType: 'bridge',
        hop1: hop1Result.hop,
        fellBack: true,
        fallbackReason: 'llm_api_error',
      };
    }
    usage.add(hop2Result.usage.inputTokens, hop2Result.usage.outputTokens);

    if (hop2Result.fallbackReason) {
      return {
        answer: '',
        questionType: 'bridge',
        hop1: hop1Result.hop,
        hop2: hop2Result.hop,
        fellBack: true,
        fallbackReason: hop2Result.fallbackReason,
      };
    }

    return {
      answer: hop2Result.hop!.answer,
      questionType: 'bridge',
      hop1: hop1Result.hop,
      hop2: hop2Result.hop,
      fellBack: false,
    };
  }

  private async hop2WithSC(
    hop2Question: string,
    passages: readonly { id: string; text: string }[],
    signal: AbortSignal,
    usage: GuardedUsage,
    scN: number,
    hop1: HopResult,
  ): Promise<Omit<MultiHopResult, 'latencyMs' | 'usage'>> {
    const candidates: HopResult[] = [];

    for (let i = 0; i < scN; i++) {
      if (signal.aborted) throw new Error('aborted');

      let hop2Result;
      try {
        hop2Result = await executeHop(hop2Question, passages, this.llm, 'hop2', signal);
      } catch (err) {
        if (signal.aborted) throw err;
        continue; // skip failed SC attempt
      }
      usage.add(hop2Result.usage.inputTokens, hop2Result.usage.outputTokens);

      if (hop2Result.hop) {
        candidates.push(hop2Result.hop);
      }
    }

    if (candidates.length === 0) {
      return {
        answer: '',
        questionType: 'bridge',
        hop1,
        fellBack: true,
        fallbackReason: 'hop2_empty',
      };
    }

    const voted = majorityVote(candidates);
    const winnerHop: HopResult = {
      answer: voted.answer,
      passageIds: voted.passageIds,
      grounded: voted.passageIds.length > 0,
    };

    return {
      answer: voted.answer,
      questionType: 'bridge',
      hop1,
      hop2: winnerHop,
      fellBack: false,
    };
  }

  private buildSkipResult(
    questionType: QuestionType,
    startTime: number,
  ): MultiHopResult {
    return {
      answer: '',
      questionType,
      fellBack: true,
      latencyMs: Date.now() - startTime,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
