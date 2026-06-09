import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { MemGraphRagRuntime } from '../runtime/MemGraphRagRuntime.js';
import { jsonErrorResult } from './handlerUtils.js';
import { toolSchemaCatalog } from './toolSchemaCatalog.js';
import { handleCreateCorpus, handleDeleteCorpus, handleListCorpora } from './handlers/corpusHandlers.js';
import { handleCancelJob, handleDeleteDocument, handleGetJobStatus, handleIndexDocuments } from './handlers/jobHandlers.js';
import { handleAnalyzeConflicts, handleExportGraph, handleGetStats, handleQuery } from './handlers/queryHandlers.js';
import { handleBuildDictionaryFromApi, handleManageDictionary } from './handlers/dictionaryHandlers.js';
import { handleManageThesaurus } from './handlers/thesaurusHandlers.js';

type ToolHandler = (params: unknown, runtime: MemGraphRagRuntime) => Promise<CallToolResult>;

const TOOL_HANDLERS = {
  create_corpus: handleCreateCorpus,
  delete_corpus: handleDeleteCorpus,
  list_corpora: handleListCorpora,
  index_documents: handleIndexDocuments,
  get_job_status: handleGetJobStatus,
  cancel_job: handleCancelJob,
  delete_document: handleDeleteDocument,
  query: handleQuery,
  get_stats: handleGetStats,
  manage_dictionary: handleManageDictionary,
  manage_thesaurus: handleManageThesaurus,
  analyze_conflicts: handleAnalyzeConflicts,
  export_graph: handleExportGraph,
  build_dictionary_from_api: handleBuildDictionaryFromApi,
} satisfies Record<keyof typeof toolSchemaCatalog, ToolHandler>;

export function createMcpServer(runtime: MemGraphRagRuntime): Server {
  const server = new Server(
    { name: 'memgraphrag', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(toolSchemaCatalog),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name as keyof typeof TOOL_HANDLERS;
    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      return jsonErrorResult({
        code: 'INVALID_PARAMS',
        message: `Unknown tool: ${request.params.name}`,
      });
    }

    try {
      return await handler(request.params.arguments ?? {}, runtime);
    } catch (error) {
      return jsonErrorResult(error);
    }
  });

  return server;
}

export async function startMcpServer(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport());
}
