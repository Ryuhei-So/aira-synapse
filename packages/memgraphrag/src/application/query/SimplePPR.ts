/**
 * Simple PPR (Personalized PageRank) implementation.
 * Power iteration on the graph transition matrix with teleportation.
 */
import type {
  IPPR,
  PPRRequest,
  PPRResult,
  RankedNode,
  IGraphProjection,
} from '../../domain/retrieval/ppr.js';

export class SimplePPR implements IPPR {
  constructor(private readonly hubDegreeThreshold: number = 50) {}

  public async run(request: PPRRequest, projection: IGraphProjection): Promise<PPRResult> {
    const { corpusId, initialVector, teleportProbability, convergenceEpsilon, maxIterations, topK, topM } = request;

    // Build adjacency list from graph
    const adjacency = new Map<string, { target: string; weight: number }[]>();
    const allNodes = new Set<string>();
    const inDegree = new Map<string, number>();

    for await (const entry of projection.getTransitions(corpusId)) {
      allNodes.add(entry.sourceNodeId);
      allNodes.add(entry.targetNodeId);
      if (!adjacency.has(entry.sourceNodeId)) {
        adjacency.set(entry.sourceNodeId, []);
      }
      adjacency.get(entry.sourceNodeId)!.push({
        target: entry.targetNodeId,
        weight: entry.weight,
      });
      inDegree.set(entry.targetNodeId, (inDegree.get(entry.targetNodeId) ?? 0) + 1);
    }

    // Initialize score vector from seeds
    const nodeList = [...allNodes];
    const n = nodeList.length;
    if (n === 0) {
      return { rankedPassages: [], rankedEntities: [], iterations: 0, converged: true, l1Delta: 0 };
    }

    const nodeIndex = new Map(nodeList.map((id, i) => [id, i]));

    // Selective hub suppression: only dampen schema (type) nodes with very high degree.
    // Fact and passage nodes are preserved — they carry specific entity info needed
    // for comparison tasks.
    const hubDamping = new Float64Array(n);
    const HUB_DEGREE_THRESHOLD = this.hubDegreeThreshold;
    for (let i = 0; i < n; i++) {
      const nodeId = nodeList[i]!;
      const outDeg = adjacency.get(nodeId)?.length ?? 0;
      const inDeg = inDegree.get(nodeId) ?? 0;
      const totalDeg = outDeg + inDeg;
      if (nodeId.startsWith('schema:') && totalDeg > HUB_DEGREE_THRESHOLD) {
        hubDamping[i] = 1.0 / Math.log2(totalDeg + 2);
      } else {
        hubDamping[i] = 1.0;
      }
    }

    // Teleport vector (personalization)
    const teleport = new Float64Array(n);
    let teleportSum = 0;
    for (const [nodeId, score] of Object.entries(initialVector.scores)) {
      const idx = nodeIndex.get(nodeId);
      if (idx !== undefined) {
        teleport[idx] = score;
        teleportSum += score;
      }
    }
    // Normalize teleport
    if (teleportSum > 0) {
      for (let i = 0; i < n; i++) teleport[i]! /= teleportSum;
    } else {
      // Uniform
      for (let i = 0; i < n; i++) teleport[i] = 1 / n;
    }

    // Power iteration
    let scores = new Float64Array(teleport);
    let converged = false;
    let iterations = 0;
    let l1Delta = 0;

    for (let iter = 0; iter < maxIterations; iter++) {
      iterations = iter + 1;
      const newScores = new Float64Array(n);

      // Transition contribution with hub suppression
      for (let i = 0; i < n; i++) {
        const nodeId = nodeList[i]!;
        const neighbors = adjacency.get(nodeId);
        if (!neighbors || neighbors.length === 0) continue;

        const totalWeight = neighbors.reduce((s, e) => s + e.weight, 0);
        const nodeScore = scores[i]!;
        for (const edge of neighbors) {
          const j = nodeIndex.get(edge.target);
          if (j !== undefined) {
            // Apply hub damping: high-degree target nodes receive less score
            const dampedWeight = (edge.weight / totalWeight) * hubDamping[j]!;
            newScores[j] = (newScores[j] ?? 0) + (1 - teleportProbability) * nodeScore * dampedWeight;
          }
        }
      }

      // Teleportation
      for (let i = 0; i < n; i++) {
        newScores[i] = (newScores[i] ?? 0) + teleportProbability * teleport[i]!;
      }

      // L1 delta
      l1Delta = 0;
      for (let i = 0; i < n; i++) {
        l1Delta += Math.abs(newScores[i]! - scores[i]!);
      }

      scores = newScores;

      if (l1Delta < convergenceEpsilon) {
        converged = true;
        break;
      }
    }

    // Classify and rank nodes
    const passageNodes: RankedNode[] = [];
    const entityNodes: RankedNode[] = [];

    for (let i = 0; i < n; i++) {
      const nodeId = nodeList[i]!;
      const score = scores[i] ?? 0;
      if (nodeId.startsWith('passage:')) {
        passageNodes.push({ nodeId, score, layer: 'passage' });
      } else if (nodeId.startsWith('fact:')) {
        entityNodes.push({ nodeId, score, layer: 'fact' });
      } else if (nodeId.startsWith('schema:')) {
        entityNodes.push({ nodeId, score, layer: 'ontology' });
      } else if (nodeId.startsWith('entity:')) {
        entityNodes.push({ nodeId, score, layer: 'entity' });
      }
    }

    passageNodes.sort((a, b) => b.score - a.score);
    entityNodes.sort((a, b) => b.score - a.score);

    return {
      rankedPassages: passageNodes.slice(0, topK),
      rankedEntities: entityNodes.slice(0, topM),
      iterations,
      converged,
      l1Delta,
    };
  }
}
