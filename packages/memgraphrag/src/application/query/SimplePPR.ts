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
  public async run(request: PPRRequest, projection: IGraphProjection): Promise<PPRResult> {
    const { corpusId, initialVector, teleportProbability, convergenceEpsilon, maxIterations, topK, topM } = request;

    // Build adjacency list from graph
    const adjacency = new Map<string, { target: string; weight: number }[]>();
    const allNodes = new Set<string>();

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
    }

    // Initialize score vector from seeds
    const nodeList = [...allNodes];
    const n = nodeList.length;
    if (n === 0) {
      return { rankedPassages: [], rankedEntities: [], iterations: 0, converged: true, l1Delta: 0 };
    }

    const nodeIndex = new Map(nodeList.map((id, i) => [id, i]));

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

      // Transition contribution
      for (let i = 0; i < n; i++) {
        const nodeId = nodeList[i]!;
        const neighbors = adjacency.get(nodeId);
        if (!neighbors || neighbors.length === 0) continue;

        const totalWeight = neighbors.reduce((s, e) => s + e.weight, 0);
        const nodeScore = scores[i]!;
        for (const edge of neighbors) {
          const j = nodeIndex.get(edge.target);
          if (j !== undefined) {
            newScores[j] = (newScores[j] ?? 0) + (1 - teleportProbability) * nodeScore * (edge.weight / totalWeight);
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
