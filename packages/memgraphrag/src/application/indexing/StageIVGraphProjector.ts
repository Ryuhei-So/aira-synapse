import type { IEmbeddingProvider } from '../../domain/provider/index.js';
import type {
  GraphEdge,
  GraphNode,
  IGraphStore,
  IVectorIndex,
  VectorRecord,
} from '../../domain/storage/index.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { Schema } from '../../domain/memory/schema.js';

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0);
    normA += (a[index] ?? 0) ** 2;
    normB += (b[index] ?? 0) ** 2;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function schemaNodeId(schemaId: string): string {
  return `schema:${schemaId}`;
}

function factNodeId(factId: string): string {
  return `fact:${factId}`;
}

function passageNodeId(passageId: string): string {
  return `passage:${passageId}`;
}

function entityNodeId(entityKey: string): string {
  return `entity:${entityKey}`;
}

function namespaceForNode(layer: GraphNode['layer']): VectorRecord<Readonly<Record<string, unknown>>>['namespace'] {
  switch (layer) {
    case 'ontology':
      return 'schema';
    case 'fact':
      return 'fact';
    case 'passage':
      return 'passage';
    case 'entity':
      return 'entity';
  }
}

export async function projectGraph(
  graphStore: IGraphStore,
  facts: readonly Fact[],
  schemas: readonly Schema[],
  passages: readonly Passage[],
): Promise<{ readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] }> {
  const nodes: GraphNode[] = [
    ...schemas.map((schema) => ({
      nodeId: schemaNodeId(schema.schemaId),
      corpusId: schema.corpusId,
      layer: 'ontology' as const,
      ref: schema,
      label: `${schema.headType} ${schema.relation} ${schema.tailType}`,
    })),
    ...facts.map((fact) => ({
      nodeId: factNodeId(fact.factId),
      corpusId: fact.corpusId,
      layer: 'fact' as const,
      ref: fact,
      label: `${fact.headEntity} ${fact.relation} ${fact.tailEntity}`,
    })),
    ...passages.map((passage) => ({
      nodeId: passageNodeId(passage.passageId),
      corpusId: passage.corpusId,
      layer: 'passage' as const,
      ref: passage,
      label: passage.text,
    })),
  ];

  // Extract unique entities from facts and create entity nodes
  const entityMap = new Map<string, { name: string; corpusId: string; factCount: number; passageIds: Set<string> }>();
  for (const fact of facts) {
    for (const entityName of [fact.headEntity, fact.tailEntity]) {
      const key = entityName.toLowerCase().replace(/\s+/g, '_');
      const existing = entityMap.get(key);
      if (existing) {
        existing.factCount += 1;
        for (const pid of fact.passageIds) existing.passageIds.add(pid);
      } else {
        entityMap.set(key, {
          name: entityName,
          corpusId: fact.corpusId,
          factCount: 1,
          passageIds: new Set(fact.passageIds),
        });
      }
    }
  }

  const entityNodes: GraphNode[] = [];
  for (const [key, info] of entityMap) {
    entityNodes.push({
      nodeId: entityNodeId(key),
      corpusId: info.corpusId,
      layer: 'entity' as const,
      ref: { entityName: info.name, factCount: info.factCount },
      label: info.name,
    });
  }
  nodes.push(...entityNodes);

  const edges: GraphEdge[] = [
    ...facts.map((fact) => ({
      edgeId: `schema-instance:${fact.schemaId}:${fact.factId}`,
      corpusId: fact.corpusId,
      sourceNodeId: schemaNodeId(fact.schemaId),
      targetNodeId: factNodeId(fact.factId),
      relation: 'schema_instance' as const,
      weight: 1,
    })),
    ...facts.flatMap((fact) => fact.passageIds.map((passageId) => ({
      edgeId: `fact-evidence:${fact.factId}:${passageId}`,
      corpusId: fact.corpusId,
      sourceNodeId: factNodeId(fact.factId),
      targetNodeId: passageNodeId(passageId),
      relation: 'fact_evidence' as const,
      weight: 1,
    }))),
  ];

  // Entity co-occurrence edges: connect entities that appear in the same fact
  for (const fact of facts) {
    const headKey = fact.headEntity.toLowerCase().replace(/\s+/g, '_');
    const tailKey = fact.tailEntity.toLowerCase().replace(/\s+/g, '_');
    if (headKey !== tailKey) {
      edges.push({
        edgeId: `entity-cooccur:${headKey}:${tailKey}:${fact.factId}`,
        corpusId: fact.corpusId,
        sourceNodeId: entityNodeId(headKey),
        targetNodeId: entityNodeId(tailKey),
        relation: 'entity_cooccurrence',
        weight: 1,
      });
    }
  }

  // Entity-passage mention edges: connect entities to passages where they appear
  for (const [key, info] of entityMap) {
    for (const passageId of info.passageIds) {
      edges.push({
        edgeId: `entity-mention:${key}:${passageId}`,
        corpusId: info.corpusId,
        sourceNodeId: entityNodeId(key),
        targetNodeId: passageNodeId(passageId),
        relation: 'entity_mention',
        weight: 1,
      });
    }
  }

  await graphStore.upsertNodes(nodes);
  await graphStore.upsertEdges(edges);
  return { nodes, edges };
}

export async function buildTypeBasedBridges(
  graphStore: IGraphStore,
  schemas: readonly Schema[],
): Promise<readonly GraphEdge[]> {
  const edges: GraphEdge[] = [];

  for (let left = 0; left < schemas.length; left += 1) {
    for (let right = left + 1; right < schemas.length; right += 1) {
      const a = schemas[left];
      const b = schemas[right];
      if (!a || !b) {
        continue;
      }
      const sharedTypes = new Set([
        a.headType.toLowerCase(),
        a.tailType.toLowerCase(),
      ]);
      if (![b.headType.toLowerCase(), b.tailType.toLowerCase()].some((value) => sharedTypes.has(value))) {
        continue;
      }
      edges.push({
        edgeId: `type-bridge:${a.schemaId}:${b.schemaId}`,
        corpusId: a.corpusId,
        sourceNodeId: schemaNodeId(a.schemaId),
        targetNodeId: schemaNodeId(b.schemaId),
        relation: 'type_based_bridge',
        weight: 1,
        bridgeKind: 'type_based',
      });
    }
  }

  if (edges.length > 0) {
    await graphStore.upsertEdges(edges);
  }
  return edges;
}

export async function buildSimilarityBridges(
  _vectorIndex: IVectorIndex,
  embeddingProvider: IEmbeddingProvider,
  nodes: readonly GraphNode[],
  similarityThreshold = 0.7,
): Promise<readonly GraphEdge[]> {
  if (nodes.length < 2) {
    return [];
  }

  const embeddings = await embeddingProvider.embed({ texts: nodes.map((node) => node.label) });
  const edges: GraphEdge[] = [];

  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < Math.min(nodes.length, 50); right += 1) {
      const score = cosineSimilarity(embeddings.vectors[left] ?? [], embeddings.vectors[right] ?? []);
      if (score < similarityThreshold) {
        continue;
      }
      const source = nodes[left];
      const target = nodes[right];
      if (!source || !target) {
        continue;
      }
      edges.push({
        edgeId: `similarity-bridge:${source.nodeId}:${target.nodeId}`,
        corpusId: source.corpusId,
        sourceNodeId: source.nodeId,
        targetNodeId: target.nodeId,
        relation: 'similarity_bridge',
        weight: score,
        bridgeKind: 'similarity_based',
      });
    }
  }

  return edges;
}

export async function upsertVectors(
  vectorIndex: IVectorIndex,
  embeddingProvider: IEmbeddingProvider,
  items: readonly GraphNode[],
): Promise<readonly VectorRecord<Readonly<Record<string, unknown>>>[]> {
  if (items.length === 0) {
    return [];
  }

  const embeddings = await embeddingProvider.embed({ texts: items.map((item) => item.label) });
  const records = items.map((item, index) => ({
    id: item.nodeId,
    corpusId: item.corpusId,
    namespace: namespaceForNode(item.layer),
    values: embeddings.vectors[index] ?? [],
    metadata: {
      nodeId: item.nodeId,
      documentId: 'metadata' in item.ref && typeof item.ref.metadata === 'object' && item.ref.metadata !== null
        ? (item.ref.metadata as Record<string, unknown>).documentId
        : 'sourceDocumentIds' in item.ref && Array.isArray((item.ref as Schema | Fact).sourceDocumentIds)
          ? (item.ref as Schema | Fact).sourceDocumentIds[0]
          : undefined,
      layer: item.layer,
    },
  }));

  await vectorIndex.upsert(records);
  return records;
}
