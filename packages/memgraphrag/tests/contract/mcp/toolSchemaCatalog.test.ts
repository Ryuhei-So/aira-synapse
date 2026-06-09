import { describe, expect, it } from 'vitest';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_ERROR_CODES } from '../../../src/interface/mcp/errors.js';
import { allToolSchemas, toolSchemaCatalog } from '../../../src/interface/mcp/toolSchemaCatalog.js';

describe('TASK-MG-036: toolSchemaCatalog', () => {
  it('defines all 14 tools', () => {
    expect(allToolSchemas).toHaveLength(14);
  });

  it('uses stable tool names', () => {
    expect(Object.keys(toolSchemaCatalog)).toEqual([
      'create_corpus',
      'delete_corpus',
      'list_corpora',
      'index_documents',
      'get_job_status',
      'cancel_job',
      'delete_document',
      'query',
      'get_stats',
      'manage_dictionary',
      'manage_thesaurus',
      'analyze_conflicts',
      'export_graph',
      'build_dictionary_from_api',
    ]);
  });

  it.each(allToolSchemas.map((tool) => [tool.name, tool] as const))(
    'registers %s as an MCP-compatible tool schema',
    (_name, tool) => {
      expect(() => ToolSchema.parse(tool)).not.toThrow();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    },
  );

  it('marks required create_corpus fields', () => {
    expect(toolSchemaCatalog.create_corpus.inputSchema.required).toEqual(['name']);
  });

  it('marks required index_documents fields', () => {
    expect(toolSchemaCatalog.index_documents.inputSchema.required).toEqual(['corpus_id', 'documents']);
  });

  it('marks required query fields', () => {
    expect(toolSchemaCatalog.query.inputSchema.required).toEqual(['corpus_id', 'query']);
  });

  it('marks required manage_dictionary fields', () => {
    expect(toolSchemaCatalog.manage_dictionary.inputSchema.required).toEqual(['corpus_id', 'action']);
  });

  it('marks required manage_thesaurus fields', () => {
    expect(toolSchemaCatalog.manage_thesaurus.inputSchema.required).toEqual(['corpus_id', 'action']);
  });

  it('marks required build_dictionary_from_api fields', () => {
    expect(toolSchemaCatalog.build_dictionary_from_api.inputSchema.required).toEqual([
      'corpus_id',
      'domains',
      'max_papers',
    ]);
  });

  it('covers every protocol-safe tool error code', () => {
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
  });
});
