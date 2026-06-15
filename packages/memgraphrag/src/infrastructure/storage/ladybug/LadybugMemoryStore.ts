/**
 * Infrastructure Layer — LadybugDB-backed memory store adapter.
 * DES-LDB-006: IMemoryStore implementation using Cypher node tables.
 */

import type {
  IMemoryStore,
  JobCheckpoint,
} from '../../../domain/storage/graphStore.js';
import type { MemorySnapshot } from '../../../domain/memory/globalMemory.js';
import type { Schema } from '../../../domain/memory/schema.js';
import type { Fact } from '../../../domain/memory/fact.js';
import type { Passage } from '../../../domain/memory/passage.js';
import type { ILadybugConnectionPool } from './LadybugConnection.js';

export class LadybugMemoryStore implements IMemoryStore {
  constructor(private readonly pool: ILadybugConnectionPool) {}

  private pk(prefix: string, corpusId: string, id: string): string {
    return `${prefix}:${corpusId}:${id}`;
  }

  async save(snapshot: MemorySnapshot): Promise<void> {
    const { corpusId, schemas, facts, passages } = snapshot;

    for (const s of schemas) {
      await this.pool.execute(
        `MERGE (n:SchemaNode {pk: $pk})
         SET n.corpus_id = $cid, n.schema_id = $sid, n.data_json = $data`,
        {
          pk: this.pk('schema', corpusId, s.schemaId),
          cid: corpusId,
          sid: s.schemaId,
          data: JSON.stringify(s),
        },
      );
    }

    for (const f of facts) {
      await this.pool.execute(
        `MERGE (n:FactNode {pk: $pk})
         SET n.corpus_id = $cid, n.fact_id = $fid,
             n.head_entity = $head, n.tail_entity = $tail,
             n.passage_id = $pid, n.data_json = $data`,
        {
          pk: this.pk('fact', corpusId, f.factId),
          cid: corpusId,
          fid: f.factId,
          head: f.headEntity,
          tail: f.tailEntity,
          pid: f.passageIds[0] ?? '',
          data: JSON.stringify(f),
        },
      );
    }

    for (const p of passages) {
      await this.pool.execute(
        `MERGE (n:PassageNode {pk: $pk})
         SET n.corpus_id = $cid, n.passage_id = $pid,
             n.document_id = $did, n.text = $text, n.data_json = $data`,
        {
          pk: this.pk('passage', corpusId, p.passageId),
          cid: corpusId,
          pid: p.passageId,
          did: p.metadata.documentId ?? '',
          text: p.text,
          data: JSON.stringify(p),
        },
      );
    }
  }

  async load(corpusId: string): Promise<MemorySnapshot> {
    const schemasResult = await this.pool.execute(
      `MATCH (n:SchemaNode) WHERE n.corpus_id = $cid RETURN n.data_json AS data`,
      { cid: corpusId },
    );
    const schemas = (await schemasResult.getAll()).map(
      (r) => JSON.parse(r.data as string) as Schema,
    );

    const factsResult = await this.pool.execute(
      `MATCH (n:FactNode) WHERE n.corpus_id = $cid RETURN n.data_json AS data`,
      { cid: corpusId },
    );
    const facts = (await factsResult.getAll()).map(
      (r) => JSON.parse(r.data as string) as Fact,
    );

    const passagesResult = await this.pool.execute(
      `MATCH (n:PassageNode) WHERE n.corpus_id = $cid RETURN n.data_json AS data`,
      { cid: corpusId },
    );
    const passages = (await passagesResult.getAll()).map(
      (r) => JSON.parse(r.data as string) as Passage,
    );

    return {
      corpusId,
      exportedAt: new Date().toISOString(),
      schemas,
      facts,
      passages,
      schemaVersion: 1,
    };
  }

  async saveCheckpoint(checkpoint: JobCheckpoint): Promise<void> {
    await this.pool.execute(
      `MERGE (n:JobCheckpointNode {pk: $pk})
       SET n.job_id = $jid, n.corpus_id = $cid,
           n.processed_doc_ids = $docs, n.updated_at = $at`,
      {
        pk: `cp:${checkpoint.jobId}`,
        jid: checkpoint.jobId,
        cid: checkpoint.corpusId,
        docs: JSON.stringify(checkpoint.processedDocumentIds),
        at: checkpoint.updatedAt,
      },
    );
  }

  async loadCheckpoint(jobId: string): Promise<JobCheckpoint | null> {
    const result = await this.pool.execute(
      `MATCH (n:JobCheckpointNode {pk: $pk})
       RETURN n.job_id AS jid, n.corpus_id AS cid,
              n.processed_doc_ids AS docs, n.updated_at AS at`,
      { pk: `cp:${jobId}` },
    );
    const rows = await result.getAll();
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      jobId: r.jid as string,
      corpusId: r.cid as string,
      processedDocumentIds: JSON.parse(r.docs as string) as string[],
      updatedAt: r.at as string,
    };
  }

  async validateIntegrity(corpusId: string): Promise<readonly string[]> {
    const errors: string[] = [];

    // Check that all facts reference existing schemas
    const factsResult = await this.pool.execute(
      `MATCH (f:FactNode) WHERE f.corpus_id = $cid RETURN f.data_json AS data`,
      { cid: corpusId },
    );
    const facts = (await factsResult.getAll()).map(
      (r) => JSON.parse(r.data as string) as Fact,
    );

    const schemasResult = await this.pool.execute(
      `MATCH (s:SchemaNode) WHERE s.corpus_id = $cid RETURN s.schema_id AS sid`,
      { cid: corpusId },
    );
    const schemaIds = new Set(
      (await schemasResult.getAll()).map((r) => r.sid as string),
    );

    for (const fact of facts) {
      if (!schemaIds.has(fact.schemaId)) {
        errors.push(`Fact ${fact.factId} references missing schema ${fact.schemaId}`);
      }
    }

    return errors;
  }
}
