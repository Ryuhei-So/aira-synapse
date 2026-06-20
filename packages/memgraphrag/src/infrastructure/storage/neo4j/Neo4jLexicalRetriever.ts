/**
 * Infrastructure Layer — Neo4j-backed lexical retriever adapter.
 * ILexicalRetriever using Neo4j full-text index (Lucene-based).
 */

import type { ILexicalRetriever } from '../../../domain/retrieval/ppr.js';
import type { Passage } from '../../../domain/memory/passage.js';
import type { INeo4jConnectionPool } from './Neo4jConnection.js';

export class Neo4jLexicalRetriever implements ILexicalRetriever {
  constructor(private readonly pool: INeo4jConnectionPool) {}

  private pk(corpusId: string, passageId: string): string {
    return `passage:${corpusId}:${passageId}`;
  }

  async indexPassages(
    corpusId: string,
    passages: readonly Passage[],
  ): Promise<void> {
    if (passages.length === 0) return;

    const rows = passages.map((p) => ({
      pk: this.pk(corpusId, p.passageId),
      cid: corpusId,
      pid: p.passageId,
      did: p.metadata.documentId ?? '',
      text: p.text,
      data: JSON.stringify(p),
    }));

    await this.pool.execute(
      `UNWIND $rows AS row
       MERGE (n:PassageNode {pk: row.pk})
       SET n.corpus_id = row.cid, n.passage_id = row.pid,
           n.document_id = row.did, n.text = row.text, n.data_json = row.data`,
      { rows },
    );
  }

  async search(
    corpusId: string,
    query: string,
    topK: number,
  ): Promise<readonly { passageId: string; score: number }[]> {
    // Escape Lucene special characters for full-text search
    const escapedQuery = this.escapeLuceneQuery(query);
    if (!escapedQuery) return [];

    // Search PassageNode full-text index
    let passageResults: { passageId: string; score: number }[];
    try {
      const ftsResult = await this.pool.execute(
        `CALL db.index.fulltext.queryNodes('passage_fts_idx', $query)
         YIELD node, score
         WHERE node.corpus_id = $cid
         RETURN node.passage_id AS pid, score
         LIMIT $limit`,
        { query: escapedQuery, cid: corpusId, limit: neo4jInt(topK * 3) },
      );
      passageResults = ftsResult.records.map((r) => ({
        passageId: r.get('pid') as string,
        score: toNumber(r.get('score')),
      }));
    } catch {
      passageResults = [];
    }

    // Search FactNode full-text index
    let factPassageScores: Map<string, number>;
    try {
      const factResult = await this.pool.execute(
        `CALL db.index.fulltext.queryNodes('fact_fts_idx', $query)
         YIELD node, score
         WHERE node.corpus_id = $cid
         RETURN node.passage_id AS pid, score
         LIMIT $limit`,
        { query: escapedQuery, cid: corpusId, limit: neo4jInt(topK * 3) },
      );
      factPassageScores = new Map();
      for (const r of factResult.records) {
        const pid = r.get('pid') as string;
        if (!pid) continue;
        const existing = factPassageScores.get(pid) ?? 0;
        factPassageScores.set(pid, Math.max(existing, toNumber(r.get('score'))));
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

    return [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([passageId, score]) => ({ passageId, score }));
  }

  async deleteByDocument(corpusId: string, documentId: string): Promise<void> {
    await this.pool.execute(
      `MATCH (n:PassageNode)
       WHERE n.corpus_id = $cid AND n.document_id = $did
       DELETE n`,
      { cid: corpusId, did: documentId },
    );
  }

  private escapeLuceneQuery(query: string): string {
    // Escape Lucene special chars: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
    return query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (m) => `\\${m}`).trim();
  }
}

/** Convert neo4j Integer to JS number. */
function toNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val && typeof val === 'object' && 'toNumber' in val) {
    return (val as { toNumber(): number }).toNumber();
  }
  return Number(val);
}

/** Create neo4j-compatible integer for LIMIT. */
function neo4jInt(n: number): number {
  return n;
}
