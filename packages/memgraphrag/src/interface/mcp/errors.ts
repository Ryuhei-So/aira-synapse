export const TOOL_ERROR_CODES = [
  'INVALID_PARAMS',
  'CORPUS_NOT_FOUND',
  'JOB_NOT_FOUND',
  'PROVIDER_FAILURE',
  'RATE_LIMITED',
  'CORRUPTED_GRAPH',
  'UNSUPPORTED_LANGUAGE',
  'LOCAL_EMBEDDING_REQUIRED',
  'FEATURE_REQUIRES_API',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: {
    request_id?: string;
    field?: string;
    retry_after_ms?: number;
    degraded_to?: string;
  };
}

function isToolError(value: unknown): value is ToolError {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ToolError>;
  return (
    typeof candidate.code === 'string'
    && TOOL_ERROR_CODES.includes(candidate.code as ToolErrorCode)
    && typeof candidate.message === 'string'
  );
}

export function toToolError(error: unknown): ToolError {
  if (isToolError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes('corpus') && normalized.includes('not found')) {
    return { code: 'CORPUS_NOT_FOUND', message };
  }

  if (
    normalized.includes('job not found')
    || normalized.includes('unknown job')
    || (normalized.includes('job') && normalized.includes('not found'))
  ) {
    return { code: 'JOB_NOT_FOUND', message };
  }

  if (normalized.includes('local_embedding_required')) {
    return { code: 'LOCAL_EMBEDDING_REQUIRED', message };
  }

  if (normalized.includes('feature_requires_api')) {
    return { code: 'FEATURE_REQUIRES_API', message };
  }

  if (normalized.includes('unsupported language')) {
    return { code: 'UNSUPPORTED_LANGUAGE', message };
  }

  if (normalized.includes('corrupted graph')) {
    return { code: 'CORRUPTED_GRAPH', message };
  }

  if (normalized.includes('rate limit') || normalized.includes('status 429')) {
    return { code: 'RATE_LIMITED', message };
  }

  if (
    normalized.includes('openai')
    || normalized.includes('provider')
    || normalized.includes('python sidecar')
    || normalized.includes('timed out')
  ) {
    return { code: 'PROVIDER_FAILURE', message };
  }

  return { code: 'INVALID_PARAMS', message };
}

export function serializeToolError(error: ToolError): string {
  return JSON.stringify(error);
}
