import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TermDictionaryEntry, ThesaurusRelation } from '../../domain/index.js';
import type { ToolError } from './errors.js';
import { serializeToolError } from './errors.js';
import { safeErrorSerializer } from './safeErrorSerializer.js';

export type JsonObject = Record<string, unknown>;

export function jsonResult(payload: JsonObject): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function jsonErrorResult(error: unknown): CallToolResult {
  const toolError = safeErrorSerializer(error);
  return {
    isError: true,
    content: [{ type: 'text', text: serializeToolError(toolError) }],
    structuredContent: toolError as unknown as JsonObject,
  };
}

export function invalidParams(message: string, field?: string): ToolError {
  return {
    code: 'INVALID_PARAMS',
    message,
    details: field ? { field } : undefined,
  };
}

export function asRecord(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw invalidParams('params must be an object');
  }

  return params as Record<string, unknown>;
}

export function requiredString(
  params: Record<string, unknown>,
  field: string,
): string {
  const value = params[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(`${field} is required`, field);
  }

  return value.trim();
}

export function optionalString(
  params: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = params[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidParams(`${field} must be a string`, field);
  }
  return value;
}

export function optionalNumber(
  params: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  const value = params[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw invalidParams(`${field} must be a number`, field);
  }
  return value;
}

export function requiredArray(
  params: Record<string, unknown>,
  field: string,
): readonly unknown[] {
  const value = params[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidParams(`${field} must be a non-empty array`, field);
  }
  return value;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeAliases(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw invalidParams('aliases must be an array of strings', 'aliases');
  }
  return value;
}

export function toDictionaryEntry(value: unknown): TermDictionaryEntry {
  const entry = asRecord(value);
  const timestamp = now();

  return {
    termId: optionalString(entry, 'term_id') ?? `term_${randomUUID()}`,
    term: requiredString(entry, 'term'),
    canonicalForm: optionalString(entry, 'canonical_form') ?? requiredString(entry, 'term').toLowerCase(),
    domainCategory: optionalString(entry, 'domain_category') ?? requiredString(entry, 'domain'),
    aliases: normalizeAliases(entry['aliases']),
    frequency: optionalNumber(entry, 'frequency', 0),
    confidence: optionalNumber(entry, 'confidence', 1),
    source: (optionalString(entry, 'source') ?? 'manual') as TermDictionaryEntry['source'],
    version: optionalString(entry, 'version') ?? '1',
    createdAt: optionalString(entry, 'created_at') ?? timestamp,
    updatedAt: optionalString(entry, 'updated_at') ?? timestamp,
  };
}

export function toThesaurusRelation(value: unknown): ThesaurusRelation {
  const relation = asRecord(value);
  const timestamp = now();

  return {
    relationId: optionalString(relation, 'relation_id') ?? `relation_${randomUUID()}`,
    sourceTerm: optionalString(relation, 'source_term') ?? requiredString(relation, 'term'),
    targetTerm: optionalString(relation, 'target_term') ?? requiredString(relation, 'target'),
    relationType: (optionalString(relation, 'relation_type') ?? requiredString(relation, 'relation')) as ThesaurusRelation['relationType'],
    language: (optionalString(relation, 'language') ?? 'unknown') as ThesaurusRelation['language'],
    weight: optionalNumber(relation, 'weight', 1),
    bidirectional: relation['bidirectional'] === undefined ? true : Boolean(relation['bidirectional']),
    createdAt: optionalString(relation, 'created_at') ?? timestamp,
    updatedAt: optionalString(relation, 'updated_at') ?? timestamp,
  };
}
