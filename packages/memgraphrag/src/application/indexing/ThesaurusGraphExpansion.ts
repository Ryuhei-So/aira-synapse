import type { IThesaurus } from '../../domain/dictionary/index.js';
import type { GraphEdge, IGraphStore } from '../../domain/storage/index.js';
import type { Schema } from '../../domain/memory/schema.js';

export async function buildThesaurusGraphExpansion(
  graphStore: IGraphStore,
  thesaurus: IThesaurus,
  schemas: readonly Schema[],
): Promise<readonly GraphEdge[]> {
  const edges: GraphEdge[] = [];

  for (let left = 0; left < schemas.length; left += 1) {
    for (let right = left + 1; right < schemas.length; right += 1) {
      const source = schemas[left];
      const target = schemas[right];
      if (!source || !target) {
        continue;
      }
      const relations = await thesaurus.getRelations(source.headType);
      const linked = relations.some((relation) =>
        (relation.relationType === 'hypernym' || relation.relationType === 'hyponym')
        && (relation.sourceTerm.toLowerCase() === target.headType.toLowerCase()
          || relation.targetTerm.toLowerCase() === target.headType.toLowerCase()),
      );
      if (!linked) {
        continue;
      }
      edges.push({
        edgeId: `is-a:${source.schemaId}:${target.schemaId}`,
        corpusId: source.corpusId,
        sourceNodeId: `schema:${source.schemaId}`,
        targetNodeId: `schema:${target.schemaId}`,
        relation: 'is_a',
        weight: 1,
      });
    }
  }

  if (edges.length > 0) {
    await graphStore.upsertEdges(edges);
  }
  return edges;
}
