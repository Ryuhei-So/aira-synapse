export {
  type GraphNode,
  type GraphEdge,
  type IGraphStore,
  type VectorRecord,
  type VectorSearchRequest,
  type VectorSearchMatch,
  type IVectorIndex,
  type JobCheckpoint,
  type IMemoryStore,
} from './graphStore.js';
export {
  INDEXING_MEMORY_CONTRACT,
  type ActiveFactRequest,
  type ActivateFactsRequest,
  type IIndexingMemory,
  type IndexingMemoryDelta,
  type IndexingMemoryMutationPlan,
  type IndexingSchemaRequest,
} from './indexingMemory.js';
