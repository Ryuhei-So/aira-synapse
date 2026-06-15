/**
 * Infrastructure Layer — LadybugDB-backed lexical retriever adapter.
 * DES-LDB-007: ILexicalRetriever using PassageNode FTS + FactNode FTS merge.
 */

import type { ILexicalRetriever } from '../../../domain/retrieval/ppr.js';
import type { Passage } from '../../../domain/memory/passage.js';
import type { ILadybugConnectionPool } from './LadybugConnection.js';

export class LadybugLexicalRetriever implements ILexicalRetriever {
  constructor(private readonly pool: ILadybugConnectionPool) {}

  private pk(corpusId: string, passageId: string): string {
    return `passage:${corpusId}:${passageId}`;
  }

  async indexPassages(
    corpusId: string,
    passages: readonly Passage[],
  ): Promise<void> {
    for (const p of passages) {
      await this.pool.execute(
        `MERGE (n:PassageNode {pk: $pk})
         SET n.corpus_id = $cid, n.passage_id = $pid,
             n.document_id = $did, n.text = $text, n.data_json = $data`,
        {
          pk: this.pk(corpusId, p.passageId),
          cid: corpusId,
          pid: p.passageId,
          did: p.metadata.documentId ?? '',
          text: p.text,
          data: JSON.stringify(p),
        },
      );
    }
  }

  async search(
    corpusId: string,
    query: string,
    topK: number,
  ): Promise<readonly { passageId: string; score: number }[]> {
    // Search PassageNode FTS index
    let passageResults: { passageId: string; score: number }[];
    try {
      const ftsResult = await this.pool.execute(
        `CALL QUERY_FTS_INDEX("PassageNode", "passage_fts_idx", $query)
         RETURN node.passage_id AS pid, node.corpus_id AS cid, score`,
        { query },
      );
      const rows = await ftsResult.getAll();
      passageResults = rows
        .filter((r) => r.cid === corpusId)
        .map((r) => ({
          passageId: r.pid as string,
          score: r.score as number,
        }));
    } catch {
      // FTS query may fail on empty index or invalid query
      passageResults = [];
    }

    // Search FactNode FTS index for entity mentions → map to passage IDs
    let factPassageScores: Map<string, number>;
    try {
      const factResult = await this.pool.execute(
        `CALL QUERY_FTS_INDEX("FactNode", "fact_fts_idx", $query)
         RETURN node.passage_id AS pid, node.corpus_id AS cid, score`,
        { query },
      );
      const factRows = await factResult.getAll();
      factPassageScores = new Map();
      for (const r of factRows) {
        if (r.cid !== corpusId) continue;
        const pid = r.pid as string;
        if (!pid) continue;
        const existing = factPassageScores.get(pid) ?? 0;
        factPassageScores.set(pid, Math.max(existing, r.score as number));
      }
    } catch {
      factPassageScores = new Map();
    }

    // Merge: max(passageScore, factScore) per passageId
    const merged = new Map<string, number>();
    for (const { passageId, score } of passageResults) {
      merged.set(passageId, Math.max(merged.get(passageId) ?? 0, score));
    }
    for (const [pid, score] of factPassageScores) {
      merged.set(pid, Math.max(merged.get(pid) ?? 0, score));
    }

    // Sort by score descending, take topK
    const sorted = [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([passageId, score]) => ({ passageId, score }));

    return sorted;
  }

  async deleteByDocument(corpusId: string, documentId: string): Promise<void> {
    await this.pool.execute(
      `MATCH (n:PassageNode)
       WHERE n.corpus_id = $cid AND n.document_id = $did
       DELETE n`,
      { cid: corpusId, did: documentId },
    );
  }
}
