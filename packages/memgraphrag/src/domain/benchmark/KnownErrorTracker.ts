/**
 * Domain Layer — Known error tracking for benchmark regression detection.
 * DES-MG4-002 (REQ-MG4-002): Track 50 known errors and report recovery/regression.
 */

export type ErrorCategory = 'retrieval' | 'expression' | 'yesno' | 'generic' | 'spelling';

export interface KnownError {
  readonly questionId: string;
  readonly category: ErrorCategory;
  readonly goldAnswer: string;
  readonly baselineResponse: string;
  readonly type?: string;
  readonly question?: string;
}

export interface KnownErrorSet {
  readonly version: string;
  readonly baselineAccuracy: string;
  readonly baselineCorrect: number;
  readonly baselineErrors: number;
  readonly errors: readonly KnownError[];
  readonly correctIds: readonly string[];
}

export interface BenchmarkDelta {
  readonly recovered: Record<ErrorCategory, readonly string[]>;
  readonly regressed: readonly string[];
  readonly unchanged: readonly string[];
  readonly summary: {
    readonly recoveredTotal: number;
    readonly regressedTotal: number;
    readonly netGain: number;
  };
}

export interface BenchmarkResult {
  readonly questionId: string;
  readonly correct: boolean;
  readonly response: string;
}

/**
 * Compare new benchmark results against a known error set.
 * Returns a delta showing which errors were recovered and which correct answers regressed.
 */
export function computeBenchmarkDelta(
  errorSet: KnownErrorSet,
  newResults: ReadonlyMap<string, BenchmarkResult>,
): BenchmarkDelta {
  const recovered: Record<ErrorCategory, string[]> = {
    retrieval: [],
    expression: [],
    yesno: [],
    generic: [],
    spelling: [],
  };
  const unchanged: string[] = [];

  // Check known errors: which ones are now correct?
  for (const error of errorSet.errors) {
    const result = newResults.get(error.questionId);
    if (result && result.correct) {
      recovered[error.category].push(error.questionId);
    } else {
      unchanged.push(error.questionId);
    }
  }

  // Check correct IDs: which ones regressed?
  const regressed: string[] = [];
  for (const correctId of errorSet.correctIds) {
    const result = newResults.get(correctId);
    if (result && !result.correct) {
      regressed.push(correctId);
    }
  }

  const recoveredTotal = Object.values(recovered).reduce((sum, ids) => sum + ids.length, 0);

  return {
    recovered,
    regressed,
    unchanged,
    summary: {
      recoveredTotal,
      regressedTotal: regressed.length,
      netGain: recoveredTotal - regressed.length,
    },
  };
}

/**
 * Format a BenchmarkDelta as a human-readable report string.
 */
export function formatDeltaReport(delta: BenchmarkDelta): string {
  const lines: string[] = [
    `=== Known Error Delta Report ===`,
    `Recovered: ${delta.summary.recoveredTotal} (net gain: ${delta.summary.netGain})`,
  ];

  for (const [category, ids] of Object.entries(delta.recovered)) {
    if (ids.length > 0) {
      lines.push(`  ${category}: +${ids.length}`);
    }
  }

  if (delta.regressed.length > 0) {
    lines.push(`Regressed: ${delta.summary.regressedTotal} (from previously correct)`);
  }

  lines.push(`Unchanged errors: ${delta.unchanged.length}`);
  return lines.join('\n');
}
