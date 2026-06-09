import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const stringSchema = (description?: string): Record<string, unknown> => ({
  type: 'string',
  ...(description ? { description } : {}),
});

const numberSchema = (
  options: { minimum?: number; maximum?: number; default?: number } = {},
): Record<string, unknown> => ({
  type: 'number',
  ...options,
});

const integerSchema = (
  options: { minimum?: number; maximum?: number; default?: number } = {},
): Record<string, unknown> => ({
  type: 'integer',
  ...options,
});

const booleanSchema = (): Record<string, unknown> => ({ type: 'boolean' });

const objectSchema = (
  properties: Record<string, object>,
  required: readonly string[] = [],
): Tool['inputSchema'] => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
});

const dictionaryEntrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    term_id: stringSchema(),
    term: stringSchema(),
    canonical_form: stringSchema(),
    domain: stringSchema(),
    domain_category: stringSchema(),
    aliases: { type: 'array', items: stringSchema() },
    frequency: integerSchema({ minimum: 0 }),
    confidence: numberSchema({ minimum: 0, maximum: 1 }),
    source: { type: 'string', enum: ['api', 'manual', 'extracted', 'approved_candidate'] },
    version: stringSchema(),
    created_at: stringSchema(),
    updated_at: stringSchema(),
  },
  required: ['term', 'domain', 'confidence', 'source'],
};

const thesaurusRelationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    relation_id: stringSchema(),
    term: stringSchema(),
    source_term: stringSchema(),
    target: stringSchema(),
    target_term: stringSchema(),
    relation: { type: 'string', enum: ['synonym', 'hypernym', 'hyponym', 'related'] },
    relation_type: { type: 'string', enum: ['synonym', 'hypernym', 'hyponym', 'related'] },
    language: { type: 'string', enum: ['en', 'ja', 'mixed', 'unknown'] },
    weight: numberSchema({ minimum: 0, maximum: 1 }),
    bidirectional: booleanSchema(),
    created_at: stringSchema(),
    updated_at: stringSchema(),
  },
  required: ['term', 'target', 'relation'],
};

export type MemGraphRagToolName =
  | 'create_corpus'
  | 'delete_corpus'
  | 'list_corpora'
  | 'index_documents'
  | 'get_job_status'
  | 'cancel_job'
  | 'delete_document'
  | 'query'
  | 'get_stats'
  | 'manage_dictionary'
  | 'manage_thesaurus'
  | 'analyze_conflicts'
  | 'export_graph'
  | 'build_dictionary_from_api';

export type ToolSchemaCatalogEntry = Pick<Tool, 'name' | 'description' | 'inputSchema'>;

export const toolSchemaCatalog: Record<MemGraphRagToolName, ToolSchemaCatalogEntry> = {
  create_corpus: {
    name: 'create_corpus',
    description: 'Create a new corpus.',
    inputSchema: objectSchema({
      name: stringSchema('Corpus display name'),
      description: stringSchema('Optional corpus description'),
    }, ['name']),
  },
  delete_corpus: {
    name: 'delete_corpus',
    description: 'Delete a corpus and its related artifacts.',
    inputSchema: objectSchema({ corpus_id: stringSchema() }, ['corpus_id']),
  },
  list_corpora: {
    name: 'list_corpora',
    description: 'List available corpora.',
    inputSchema: objectSchema({}),
  },
  index_documents: {
    name: 'index_documents',
    description: 'Queue markdown documents for indexing.',
    inputSchema: objectSchema({
      corpus_id: stringSchema(),
      documents: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            document_id: stringSchema(),
            markdown: stringSchema(),
            title: stringSchema(),
            source_url: stringSchema(),
            doi: stringSchema(),
            source_db: stringSchema(),
            source_type: { type: 'string', enum: ['pdf', 'html', 'docx', 'pptx', 'md'] },
            language: { type: 'string', enum: ['en', 'ja', 'mixed', 'unknown'] },
          },
          required: ['document_id', 'markdown', 'title', 'source_url'],
        },
      },
    }, ['corpus_id', 'documents']),
  },
  get_job_status: {
    name: 'get_job_status',
    description: 'Get indexing job status.',
    inputSchema: objectSchema({ job_id: stringSchema() }, ['job_id']),
  },
  cancel_job: {
    name: 'cancel_job',
    description: 'Cancel a queued or running job.',
    inputSchema: objectSchema({ job_id: stringSchema() }, ['job_id']),
  },
  delete_document: {
    name: 'delete_document',
    description: 'Delete a single document from a corpus.',
    inputSchema: objectSchema({
      corpus_id: stringSchema(),
      document_id: stringSchema(),
    }, ['corpus_id', 'document_id']),
  },
  query: {
    name: 'query',
    description: 'Run a retrieval and generation query against a corpus.',
    inputSchema: objectSchema({
      corpus_id: stringSchema(),
      query: stringSchema(),
      top_k: integerSchema({ minimum: 1, default: 10 }),
      top_m: integerSchema({ minimum: 1, default: 5 }),
      threshold: numberSchema({ minimum: 0, maximum: 1, default: 0.5 }),
      context_token_limit: integerSchema({ minimum: 1, default: 8000 }),
    }, ['corpus_id', 'query']),
  },
  get_stats: {
    name: 'get_stats',
    description: 'Get corpus memory and graph statistics.',
    inputSchema: objectSchema({ corpus_id: stringSchema() }, ['corpus_id']),
  },
  manage_dictionary: {
    name: 'manage_dictionary',
    description: 'Add, search, import, export, or inspect dictionary entries.',
    inputSchema: objectSchema({
      corpus_id: stringSchema(),
      action: { type: 'string', enum: ['add', 'search', 'stats', 'import', 'export'] },
      entry: dictionaryEntrySchema,
      query: stringSchema(),
      data: { type: 'array', items: dictionaryEntrySchema },
    }, ['corpus_id', 'action']),
  },
  manage_thesaurus: {
    name: 'manage_thesaurus',
    description: 'Add, lookup, import, export, or inspect thesaurus relations.',
    inputSchema: objectSchema({
      corpus_id: stringSchema(),
      action: { type: 'string', enum: ['add', 'lookup', 'stats', 'import', 'export'] },
      relation: thesaurusRelationSchema,
      term: stringSchema(),
      data: { type: 'array', items: thesaurusRelationSchema },
    }, ['corpus_id', 'action']),
  },
  analyze_conflicts: {
    name: 'analyze_conflicts',
    description: 'Analyze conflict audit records for a corpus.',
    inputSchema: objectSchema({ corpus_id: stringSchema() }, ['corpus_id']),
  },
  export_graph: {
    name: 'export_graph',
    description: 'Export graph data as JSON or GraphML.',
    inputSchema: objectSchema({
      corpus_id: stringSchema(),
      format: { type: 'string', enum: ['graphml', 'json'] },
      offset: integerSchema({ minimum: 0, default: 0 }),
      limit: integerSchema({ minimum: 1, maximum: 10000, default: 10000 }),
    }, ['corpus_id', 'format']),
  },
  build_dictionary_from_api: {
    name: 'build_dictionary_from_api',
    description: 'Build dictionary terms from an external scholarly API.',
    inputSchema: objectSchema({
      corpus_id: stringSchema(),
      domains: { type: 'array', minItems: 1, items: stringSchema() },
      max_papers: integerSchema({ minimum: 1, maximum: 1000 }),
    }, ['corpus_id', 'domains', 'max_papers']),
  },
};

export const allToolSchemas = Object.values(toolSchemaCatalog);
