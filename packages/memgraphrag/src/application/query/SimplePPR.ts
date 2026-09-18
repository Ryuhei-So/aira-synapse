/**
 * Simple PPR (Personalized PageRank) implementation.
 * Power iteration on the graph transition matrix with teleportation.
 *
 * The graph is compiled once per transition snapshot into compressed sparse
 * row arrays and reused across queries: on a production corpus the
 * per-query sort and Map construction of ~2.5M transitions dominated retrieval
 * (about 13 s of single-threaded work per query, literature-hub #575). The
 * compiled graph is keyed on the identity of the snapshot array a projection
 * hands out, so it expires exactly when the projection invalidates its cache.
 * Score arithmetic is performed in the same order as the uncompiled loop, so
 * rankings are bit-identical with and without the cache.
 */
import type {
  IPPR,
  PPRRequest,
  PPRResult,
  RankedNode,
  IGraphProjection,
  TransitionEntry,
} from '../../domain/retrieval/ppr.js';
import {
  compareV15Ids,
  orderV15RankedNodes,
  orderV15Seeds,
  orderV15Transitions,
} from '../../domain/retrieval/v15Plan.js';

/** One corpus graph in CSR form, for one hub-degree threshold. */
interface CompiledGraph {
  readonly nodeList: readonly string[];
  readonly nodeIndex: ReadonlyMap<string, number>;
  /** Edge range of node i is [offsets[i], offsets[i + 1]). */
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  /** (weight / total out-weight of the source) * hubDamping[target]. */
  readonly dampedWeights: Float64Array;
  readonly layers: readonly (RankedNode['layer'] | null)[];
}

export function compileGraph(entries: readonly TransitionEntry[], hubDegreeThreshold: number): CompiledGraph | null {
  const adjacency = new Map<string, { target: string; weight: number }[]>();
  const allNodes = new Set<string>();
  const inDegree = new Map<string, number>();
  let edgeCount = 0;
  for (const entry of orderV15Transitions(entries)) {
    allNodes.add(entry.sourceNodeId);
    allNodes.add(entry.targetNodeId);
    if (!adjacency.has(entry.sourceNodeId)) {
      adjacency.set(entry.sourceNodeId, []);
    }
    adjacency.get(entry.sourceNodeId)!.push({ target: entry.targetNodeId, weight: entry.weight });
    inDegree.set(entry.targetNodeId, (inDegree.get(entry.targetNodeId) ?? 0) + 1);
    edgeCount += 1;
  }

  const nodeList = [...allNodes].sort(compareV15Ids);
  const n = nodeList.length;
  if (n === 0) return null;
  const nodeIndex = new Map(nodeList.map((id, i) => [id, i]));

  // Selective hub suppression: only dampen schema (type) nodes with very high degree.
  // Fact and passage nodes are preserved — they carry specific entity info needed
  // for comparison tasks.
  const hubDamping = new Float64Array(n);
  const layers: (RankedNode['layer'] | null)[] = new Array<RankedNode['layer'] | null>(n);
  for (let i = 0; i < n; i++) {
    const nodeId = nodeList[i]!;
    const outDeg = adjacency.get(nodeId)?.length ?? 0;
    const inDeg = inDegree.get(nodeId) ?? 0;
    const totalDeg = outDeg + inDeg;
    if (nodeId.startsWith('schema:') && totalDeg > hubDegreeThreshold) {
      hubDamping[i] = 1.0 / Math.log2(totalDeg + 2);
    } else {
      hubDamping[i] = 1.0;
    }
    layers[i] = nodeId.startsWith('passage:') ? 'passage'
      : nodeId.startsWith('fact:') ? 'fact'
        : nodeId.startsWith('schema:') ? 'ontology'
          : nodeId.startsWith('entity:') ? 'entity'
            : null;
  }

  const offsets = new Int32Array(n + 1);
  const targets = new Int32Array(edgeCount);
  const dampedWeights = new Float64Array(edgeCount);
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    offsets[i] = cursor;
    const neighbors = adjacency.get(nodeList[i]!);
    if (!neighbors || neighbors.length === 0) continue;
    const totalWeight = neighbors.reduce((s, e) => s + e.weight, 0);
    for (const edge of neighbors) {
      const j = nodeIndex.get(edge.target)!;
      targets[cursor] = j;
      // Apply hub damping: high-degree target nodes receive less score
      dampedWeights[cursor] = (edge.weight / totalWeight) * hubDamping[j]!;
      cursor += 1;
    }
  }
  offsets[n] = cursor;

  return { nodeList, nodeIndex, offsets, targets, dampedWeights, layers };
}

/**
 * Compiled graphs keyed on the projection's snapshot array, then on
 * hubDegreeThreshold. Module-level on purpose: the runtime constructs a fresh
 * SimplePPR per retrieve() call, and the snapshot array (not the PPR instance)
 * is what identifies the graph. A WeakMap lets the entry die with the array.
 */
const compiledGraphs = new WeakMap<readonly TransitionEntry[], Map<number, CompiledGraph | null>>();

export class SimplePPR implements IPPR {
  private compileCount = 0;

  /** How many times a graph was compiled; lets a host assert the cache actually served a query. */
  public get compilations(): number {
    return this.compileCount;
  }

  private async compiledGraph(
    corpusId: string,
    projection: IGraphProjection,
    hubDegreeThreshold: number,
  ): Promise<CompiledGraph | null> {
    if (typeof projection.getTransitionSnapshot === 'function') {
      const snapshot = await projection.getTransitionSnapshot(corpusId);
      let perThreshold = compiledGraphs.get(snapshot);
      if (!perThreshold) {
        perThreshold = new Map();
        compiledGraphs.set(snapshot, perThreshold);
      }
      if (!perThreshold.has(hubDegreeThreshold)) {
        this.compileCount += 1;
        perThreshold.set(hubDegreeThreshold, compileGraph(snapshot, hubDegreeThreshold));
      }
      return perThreshold.get(hubDegreeThreshold)!;
    }
    const transitions: TransitionEntry[] = [];
    for await (const entry of projection.getTransitions(corpusId)) {
      transitions.push(entry);
    }
    this.compileCount += 1;
    return compileGraph(transitions, hubDegreeThreshold);
  }

  public async run(request: PPRRequest, projection: IGraphProjection): Promise<PPRResult> {
    const {
      corpusId, initialVector, teleportProbability, convergenceEpsilon,
      maxIterations, hubDegreeThreshold, topK, topM,
    } = request;

    const graph = await this.compiledGraph(corpusId, projection, hubDegreeThreshold);
    if (!graph) {
      return { rankedPassages: [], rankedEntities: [], iterations: 0, converged: true, l1Delta: 0 };
    }
    const { nodeList, nodeIndex, offsets, targets, dampedWeights, layers } = graph;
    const n = nodeList.length;

    // Teleport vector (personalization)
    const teleport = new Float64Array(n);
    let teleportSum = 0;
    const seedEntries = orderV15Seeds(
      Object.entries(initialVector.scores).map(([nodeId, score]) => ({ nodeId, score })),
    );
    for (const { nodeId, score } of seedEntries) {
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
    const retained = 1 - teleportProbability;

    for (let iter = 0; iter < maxIterations; iter++) {
      iterations = iter + 1;
      const newScores = new Float64Array(n);

      // Transition contribution with hub suppression. Same evaluation order as
      // the uncompiled loop: ((1 - teleport) * nodeScore) * dampedWeight.
      for (let i = 0; i < n; i++) {
        const end = offsets[i + 1]!;
        let e = offsets[i]!;
        if (e === end) continue;
        const nodeScore = scores[i]!;
        for (; e < end; e++) {
          const j = targets[e]!;
          newScores[j] = newScores[j]! + retained * nodeScore * dampedWeights[e]!;
        }
      }

      // Teleportation
      for (let i = 0; i < n; i++) {
        newScores[i] = newScores[i]! + teleportProbability * teleport[i]!;
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
      const layer = layers[i];
      if (layer === null || layer === undefined) continue;
      const node = { nodeId: nodeList[i]!, score: scores[i]!, layer };
      if (layer === 'passage') passageNodes.push(node);
      else entityNodes.push(node);
    }

    const orderedPassages = orderV15RankedNodes(passageNodes);
    const orderedEntities = orderV15RankedNodes(entityNodes);

    return {
      rankedPassages: orderedPassages.slice(0, topK),
      rankedEntities: orderedEntities.slice(0, topM),
      iterations,
      converged,
      l1Delta,
    };
  }
}
