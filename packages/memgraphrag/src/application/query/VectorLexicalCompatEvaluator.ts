export type AgdbValidationErrorCode =
  | 'INVALID_TOP_K'
  | 'INVALID_THRESHOLD'
  | 'INVALID_CORPUS_ID'
  | 'INVALID_NAMESPACE';

export class AgdbCompatValidationError extends Error {
  public readonly code: AgdbValidationErrorCode;

  public constructor(code: AgdbValidationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'AgdbCompatValidationError';
  }
}

export interface CompatRequest {
  readonly corpusId: string;
  readonly namespace: string;
  readonly topK: number;
  readonly threshold?: number;
}

export interface VectorCompatMatch {
  readonly id: string;
  readonly score: number;
}

export interface LexicalCompatMatch {
  readonly documentId: string;
  readonly text: string;
  readonly score: number;
  readonly memoryType: 'passage' | 'fact';
}

export interface VectorCompatibilityResult {
  readonly matchRate: number;
  readonly matchedIds: readonly string[];
  readonly expectedIds: readonly string[];
  readonly actualIds: readonly string[];
}

function roundScore(score: number, digits: number): number {
  const base = 10 ** digits;
  return Math.round(score * base) / base;
}

export class VectorLexicalCompatEvaluator {
  public validateRequest(request: CompatRequest): void {
    if (!Number.isInteger(request.topK) || request.topK <= 0) {
      throw new AgdbCompatValidationError('INVALID_TOP_K', 'topK must be an integer greater than 0');
    }
    if (
      request.threshold !== undefined
      && (typeof request.threshold !== 'number' || request.threshold < 0 || request.threshold > 1)
    ) {
      throw new AgdbCompatValidationError('INVALID_THRESHOLD', 'threshold must be within [0, 1]');
    }
    if (request.corpusId.trim().length === 0) {
      throw new AgdbCompatValidationError('INVALID_CORPUS_ID', 'corpusId must be a non-empty string');
    }
    if (request.namespace.trim().length === 0) {
      throw new AgdbCompatValidationError('INVALID_NAMESPACE', 'namespace must be a non-empty string');
    }
  }

  public compareVectorTopK(
    baseline: readonly VectorCompatMatch[],
    candidate: readonly VectorCompatMatch[],
    options?: { scoreRoundingDecimals?: number; threshold?: number; thresholdEpsilon?: number },
  ): VectorCompatibilityResult {
    const scoreRoundingDecimals = options?.scoreRoundingDecimals ?? 6;
    const threshold = options?.threshold;
    const epsilon = options?.thresholdEpsilon ?? 0;
    const filter = (entry: VectorCompatMatch): boolean => {
      if (threshold === undefined) return true;
      return entry.score + epsilon >= threshold;
    };

    const expectedIds = baseline
      .filter(filter)
      .map((entry) => ({
        id: entry.id,
        score: roundScore(entry.score, scoreRoundingDecimals),
      }))
      .map((entry) => entry.id);
    const actualIds = candidate
      .filter(filter)
      .map((entry) => ({
        id: entry.id,
        score: roundScore(entry.score, scoreRoundingDecimals),
      }))
      .map((entry) => entry.id);

    const expectedSet = new Set(expectedIds);
    const actualSet = new Set(actualIds);
    const matchedIds = expectedIds.filter((id) => actualSet.has(id));
    const denominator = expectedSet.size === 0 ? 1 : expectedSet.size;
    const matchRate = matchedIds.length / denominator;

    return {
      matchRate,
      matchedIds,
      expectedIds,
      actualIds,
    };
  }

  public assertLexicalSchemaAndSort(matches: readonly LexicalCompatMatch[]): void {
    for (const item of matches) {
      if (item.documentId.trim().length === 0) {
        throw new AgdbCompatValidationError('INVALID_CORPUS_ID', 'documentId must be non-empty');
      }
      if (item.text.trim().length === 0) {
        throw new AgdbCompatValidationError('INVALID_NAMESPACE', 'text must be non-empty');
      }
      if (item.memoryType !== 'passage' && item.memoryType !== 'fact') {
        throw new AgdbCompatValidationError('INVALID_NAMESPACE', 'memoryType must be passage|fact');
      }
    }

    for (let i = 1; i < matches.length; i += 1) {
      const prev = matches[i - 1]!;
      const curr = matches[i]!;
      if (prev.score < curr.score) {
        throw new AgdbCompatValidationError(
          'INVALID_NAMESPACE',
          'lexical results must be sorted by score desc',
        );
      }
      if (prev.score === curr.score && prev.documentId.localeCompare(curr.documentId) > 0) {
        throw new AgdbCompatValidationError(
          'INVALID_NAMESPACE',
          'lexical tie-break must be documentId asc',
        );
      }
    }
  }
}
