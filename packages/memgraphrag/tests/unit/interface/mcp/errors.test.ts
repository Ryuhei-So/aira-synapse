import { describe, expect, it } from 'vitest';
import {
  serializeToolError,
  toToolError,
  TOOL_ERROR_CODES,
  type ToolError,
} from '../../../../src/interface/mcp/errors.js';

describe('MCP tool error boundaries', () => {
  it('keeps the public error-code catalog exhaustive and passes typed errors through', () => {
    expect(TOOL_ERROR_CODES).toEqual([
      'INVALID_PARAMS',
      'CORPUS_NOT_FOUND',
      'JOB_NOT_FOUND',
      'PROVIDER_FAILURE',
      'RATE_LIMITED',
      'CORRUPTED_GRAPH',
      'UNSUPPORTED_LANGUAGE',
      'LOCAL_EMBEDDING_REQUIRED',
      'FEATURE_REQUIRES_API',
    ]);

    const typed: ToolError = {
      code: 'RATE_LIMITED',
      message: 'retry later',
      details: { request_id: 'req-1', retry_after_ms: 2500, degraded_to: 'local' },
    };
    expect(toToolError(typed)).toBe(typed);
  });

  it.each([
    ['CORPUS_NOT_FOUND', 'Corpus c1 not found'],
    ['JOB_NOT_FOUND', 'job not found: j1'],
    ['JOB_NOT_FOUND', 'unknown job j1'],
    ['JOB_NOT_FOUND', 'job j1 was not found'],
    ['LOCAL_EMBEDDING_REQUIRED', 'LOCAL_EMBEDDING_REQUIRED for this operation'],
    ['FEATURE_REQUIRES_API', 'FEATURE_REQUIRES_API is disabled'],
    ['UNSUPPORTED_LANGUAGE', 'unsupported language: xx'],
    ['CORRUPTED_GRAPH', 'corrupted graph detected'],
    ['RATE_LIMITED', 'rate limit exceeded'],
    ['RATE_LIMITED', 'upstream status 429'],
    ['PROVIDER_FAILURE', 'OpenAI request failed'],
    ['PROVIDER_FAILURE', 'provider unavailable'],
    ['PROVIDER_FAILURE', 'python sidecar failed'],
    ['PROVIDER_FAILURE', 'request timed out'],
  ] as const)('maps "%s" messages without losing the original message', (code, message) => {
    expect(toToolError(message)).toEqual({ code, message });
  });

  it('falls back to invalid parameters for malformed and unclassified errors', () => {
    expect(toToolError(null)).toEqual({ code: 'INVALID_PARAMS', message: 'null' });
    expect(toToolError({ code: 'RATE_LIMITED', message: 42 })).toEqual({
      code: 'INVALID_PARAMS',
      message: '[object Object]',
    });
    expect(toToolError({ code: 'NOT_A_TOOL_ERROR', message: 'bad' })).toEqual({
      code: 'INVALID_PARAMS',
      message: '[object Object]',
    });
    expect(toToolError(new Error('unclassified failure'))).toEqual({
      code: 'INVALID_PARAMS',
      message: 'unclassified failure',
    });
  });

  it('serializes typed errors as JSON with optional details intact', () => {
    const error: ToolError = {
      code: 'PROVIDER_FAILURE',
      message: 'provider unavailable',
      details: { request_id: 'req-2', field: 'query' },
    };
    expect(serializeToolError(error)).toBe(JSON.stringify(error));
    expect(JSON.parse(serializeToolError(error))).toEqual(error);
  });
});
