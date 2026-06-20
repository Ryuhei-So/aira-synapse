/**
 * Infrastructure Layer — Neo4j-backed memory store adapter.
 * IMemoryStore implementation using Cypher MERGE.
 */

import type {
  IMemoryStore,
  JobCheckpoint,
} from '../../../domain/storage/graphStore.js';
import type { MemorySnapshot } from '../../../domain/memory/globalMemory.js';
import type { Schema } from '../../../domain/memory/schema.js';
import type { Fact } from '../../../domain/memory/fact.js';
import type { Passage } from '../../../domain/memory/passage.js';
import type { INeo4jConnectionPool } from './Neo4jConnection.js';

export class Neo4jMemoryStore implements IMemoryStore {
  constructor(private readonly pool: INeo4jConnectionPool) {}

  private pk(prefix: string, corpusId: string, id: string): string {
    return `${prefix}:${corpusId}:${id}`;
  }

  async save(snapshot: MemorySnapshot): Promise<void> {
    const { corpusId, schemas, facts, passages } = snapshot;

    // Batch schemas via UNWIND
    if (schemas.length > 0) {
      const rows = schemas.map((s) => ({
        pk: this.pk('schema', corpusId, s.schemaId),
        cid: corpusId,
        sid: s.schemaId,
        data: JSON.stringify(s),
      }));
      await this.pool.execute(
        `UNWIND $rows AS row
         MERGE (n:SchemaNode {pk: row.pk})
         SET n.corpus_id = row.cid, n.schema_id = row.sid, n.data_json = row.data`,
        { rows },
      );
    }

    // Batch facts via UNWIND
    if (facts.length > 0) {
      const rows = facts.map((f) => ({
        pk: this.pk('fact', corpusId, f.factId),
        cid: corpusId,
        fid: f.factId,
        head: f.headEntity,
        tail: f.tailEntity,
        pid: f.passageIds[0] ?? '',
        data: JSON.stringify(f),
      }));
      await this.pool.execute(
        `UNWIND $rows AS row
         MERGE (n:FactNode {pk: row.pk})
         SET n.corpus_id = row.cid, n.fact_id = row.fid,
             n.head_entity = row.head, n.tail_entity = row.tail,
             n.passage_id = row.pid, n.data_json = row.data`,
        { rows },
      );
    }

    // Batch passages via UNWIND
    if (passages.length > 0) {
      const rows = passages.map((p) => ({
        pk: this.pk('passage', corpusId, p.passageId),
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
  }

  async load(corpusId: string): Promise<MemorySnapshot> {
    const schemasResult = await this.pool.execute(
      `MATCH (n:SchemaNode) WHERE n.corpus_id = $cid RETURN n.data_json AS data`,
      { cid: corpusId },
    );
    const schemas = schemasResult.records.map(
      (r) => JSON.parse(r.get('data') as string) as Schema,
    );

    const factsResult = await this.pool.execute(
      `MATCH (n:FactNode) WHERE n.corpus_id = $cid RETURN n.data_json AS data`,
      { cid: corpusId },
    );
    const facts = factsResult.records.map(
      (r) => JSON.parse(r.get('data') as string) as Fact,
    );

    const passagesResult = await this.pool.execute(
      `MATCH (n:PassageNode) WHERE n.corpus_id = $cid RETURN n.data_json AS data`,
      { cid: corpusId },
    );
    const passages = passagesResult.records.map(
      (r) => JSON.parse(r.get('data') as string) as Passage,
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
    if (result.records.length === 0) return null;
    const r = result.records[0]!;
    return {
      jobId: r.get('jid') as string,
      corpusId: r.get('cid') as string,
      processedDocumentIds: JSON.parse(r.get('docs') as string) as string[],
      updatedAt: r.get('at') as string,
    };
  }

  async validateIntegrity(corpusId: string): Promise<readonly string[]> {
    const errors: string[] = [];

    const factsResult = await this.pool.execute(
      `MATCH (f:FactNode) WHERE f.corpus_id = $cid RETURN f.data_json AS data`,
      { cid: corpusId },
    );
    const facts = factsResult.records.map(
      (r) => JSON.parse(r.get('data') as string) as Fact,
    );

    const schemasResult = await this.pool.execute(
      `MATCH (s:SchemaNode) WHERE s.corpus_id = $cid RETURN s.schema_id AS sid`,
      { cid: corpusId },
    );
    const schemaIds = new Set(
      schemasResult.records.map((r) => r.get('sid') as string),
    );

    for (const fact of facts) {
      if (!schemaIds.has(fact.schemaId)) {
        errors.push(`Fact ${fact.factId} references missing schema ${fact.schemaId}`);
      }
    }

    return errors;
  }
}
