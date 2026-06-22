/**
 * Application Layer — Multi-hop reasoning infrastructure.
 * T5a: Promise.race 3-racer abort architecture, GuardedUsage accumulator.
 *
 * This module provides the abort/timeout foundation for MultiHopReasoner.
 */

/**
 * Guarded usage accumulator — prevents mutation after settlement/abort.
 * `add()` is a no-op if the pipeline has already settled or been aborted.
 */
export class GuardedUsage {
  private _inputTokens = 0;
  private _outputTokens = 0;
  private _settled = false;
  private readonly signal: AbortSignal | undefined;

  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }

  /** Add token usage. No-op if settled or aborted. */
  add(input: number, output: number): void {
    if (this._settled) return;
    if (this.signal?.aborted) return;
    this._inputTokens += input;
    this._outputTokens += output;
  }

  /** Mark as settled — no further mutations allowed. */
  settle(): void {
    this._settled = true;
  }

  /** Get immutable snapshot of current usage. */
  snapshot(): { readonly inputTokens: number; readonly outputTokens: number } {
    return { inputTokens: this._inputTokens, outputTokens: this._outputTokens };
  }

  get settled(): boolean {
    return this._settled;
  }
}

/** Abort cause attribution. */
export type AbortCause = 'timeout' | 'external';

/**
 * Race result from the 3-racer architecture.
 * The pipeline either completes, times out, or is externally cancelled.
 */
export interface RaceOutcome<T> {
  readonly result?: T;
  readonly abortCause?: AbortCause;
}

/**
 * Run a pipeline with 3-racer abort architecture:
 * 1. The pipeline promise itself
 * 2. A timeout sentinel
 * 3. An external abort sentinel (from caller's signal)
 *
 * Returns the pipeline result or the abort cause.
 * Cleans up timer and listeners in `finally`.
 */
export async function raceWithAbort<T>(
  pipeline: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<RaceOutcome<T>> {
  // Internal controller for coordinating abort
  const controller = new AbortController();
  let abortCause: AbortCause | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let externalListener: (() => void) | undefined;

  try {
    // Check if already aborted
    if (externalSignal?.aborted) {
      throw new Error('Operation was cancelled');
    }

    // Timeout sentinel
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    // External abort sentinel
    const externalPromise = new Promise<'external'>((resolve) => {
      if (!externalSignal) return; // never resolves
      externalListener = () => resolve('external');
      externalSignal.addEventListener('abort', externalListener, { once: true });
    });

    // Pipeline with internal signal
    const pipelinePromise = pipeline(controller.signal);
    // Suppress unhandled rejection if pipeline outlives the race
    pipelinePromise.catch(() => {});

    // Race!
    const winner = await Promise.race([
      pipelinePromise.then(
        (r) => ({ type: 'result' as const, value: r }),
        () => ({ type: 'pipeline_error' as const }),
      ),
      timeoutPromise.then(() => ({ type: 'timeout' as const })),
      externalPromise.then(() => ({ type: 'external' as const })),
    ]);

    if (winner.type === 'result') {
      return { result: (winner as { type: 'result'; value: T }).value };
    }

    if (winner.type === 'pipeline_error') {
      // Pipeline failed before timeout/external — re-run to get error
      return { abortCause: undefined };
    }

    // Abort the pipeline
    abortCause = winner.type as AbortCause;
    controller.abort();

    if (abortCause === 'external') {
      throw new Error('Operation was cancelled');
    }

    return { abortCause };
  } finally {
    // Cleanup timer
    if (timer !== undefined) clearTimeout(timer);
    // Cleanup external listener
    if (externalListener && externalSignal) {
      externalSignal.removeEventListener('abort', externalListener);
    }
  }
}
