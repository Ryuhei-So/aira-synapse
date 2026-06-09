/**
 * Interface Layer — MCP server, CLI, and runtime composition root.
 * Depends on: Application layer (and transitively Domain).
 */

export * from './mcp/errors.js';
export * from './mcp/toolSchemaCatalog.js';
export * from './mcp/server.js';
export * from './mcp/featureGate.js';
export * from './mcp/safeErrorSerializer.js';
export * from './mcp/handlers/corpusHandlers.js';
export * from './mcp/handlers/jobHandlers.js';
export * from './mcp/handlers/queryHandlers.js';
export * from './mcp/handlers/dictionaryHandlers.js';
export * from './mcp/handlers/thesaurusHandlers.js';
export * from './cli/index.js';
export * from './cli/registerIndexCommand.js';
export * from './cli/registerQueryCommand.js';
export * from './cli/registerStatsCommand.js';
export * from './cli/registerInitCommand.js';
export * from './cli/registerDictionaryCommand.js';
export * from './cli/registerThesaurusCommand.js';
export * from './cli/registerVisualizeCommand.js';
export * from './cli/registerConflictsCommand.js';
export * from './runtime/MemGraphRagRuntime.js';
