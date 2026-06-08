/**
 * Infrastructure Layer — File-based ANN vector index.
 * DES-MG-031, ADR-006: f32 binary + JSONL metadata for single-machine vector search.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  IVectorIndex,
  VectorRecord,
  VectorSearchRequest,
  VectorSearchMatch,
} from '../../domain/storage/graphStore.js';

interface ManifestEntry {
  readonly id: string;
  readonly corpusId: string;
  readonly namespace: string;
  readonly offset: number;
  readonly dimensions: number;
  readonly deleted: boolean;
  readonly documentId?: string;
}

interface Manifest {
  entries: ManifestEntry[];
  version: number;
}

export class FileVectorIndex implements IVectorIndex {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
  }

  async upsert<TMetadata extends Readonly<Record<string, unknown>>>(
    records: readonly VectorRecord<TMetadata>[],
  ): Promise<void> {
    for (const record of records) {
      const nsDir = this.getNamespaceDir(record.corpusId, record.namespace);
      if (!existsSync(nsDir)) {
        mkdirSync(nsDir, { recursive: true });
      }

      const manifest = this.loadManifest(nsDir);
      const vectorsPath = resolve(nsDir, 'vectors.f32');
      const metadataPath = resolve(nsDir, 'metadata.jsonl');

      // Mark old entry as deleted if exists
      const existingIdx = manifest.entries.findIndex(
        (e) => e.id === record.id && !e.deleted,
      );
      if (existingIdx >= 0) {
        manifest.entries[existingIdx] = {
          ...manifest.entries[existingIdx]!,
          deleted: true,
        };
      }

      // Append vector
      const float32 = new Float32Array(record.values);
      const buffer = Buffer.from(float32.buffer);
      const offset = existsSync(vectorsPath)
        ? readFileSync(vectorsPath).byteLength / 4
        : 0;

      appendFileSync(vectorsPath, buffer);

      // Append metadata
      const metaLine = JSON.stringify({
        id: record.id,
        ...record.metadata,
      });
      appendFileSync(metadataPath, metaLine + '\n');

      // Update manifest
      const documentId =
        (record.metadata as Record<string, unknown>)['documentId'] as
          | string
          | undefined;
      manifest.entries.push({
        id: record.id,
        corpusId: record.corpusId,
        namespace: record.namespace,
        offset,
        dimensions: record.values.length,
        deleted: false,
        documentId,
      });
      manifest.version++;

      this.saveManifest(nsDir, manifest);
    }
  }

  async search<TMetadata extends Readonly<Record<string, unknown>>>(
    request: VectorSearchRequest,
  ): Promise<readonly VectorSearchMatch<TMetadata>[]> {
    const nsDir = this.getNamespaceDir(request.corpusId, request.namespace);
    if (!existsSync(nsDir)) return [];

    const manifest = this.loadManifest(nsDir);
    const activeEntries = manifest.entries.filter((e) => !e.deleted);
    if (activeEntries.length === 0) return [];

    const vectorsPath = resolve(nsDir, 'vectors.f32');
    if (!existsSync(vectorsPath)) return [];

    const vectorBuffer = readFileSync(vectorsPath);
    const metadataPath = resolve(nsDir, 'metadata.jsonl');
    const metadataLines = existsSync(metadataPath)
      ? readFileSync(metadataPath, 'utf-8').trim().split('\n')
      : [];

    const queryVec = new Float32Array(request.queryVector);
    const results: VectorSearchMatch<TMetadata>[] = [];

    for (const entry of activeEntries) {
      const startByte = entry.offset * 4;
      const endByte = startByte + entry.dimensions * 4;
      if (endByte > vectorBuffer.byteLength) continue;

      const entryBuffer = vectorBuffer.subarray(startByte, endByte);
      const entryVec = new Float32Array(
        entryBuffer.buffer,
        entryBuffer.byteOffset,
        entry.dimensions,
      );

      const score = cosineSimilarity(queryVec, entryVec);
      if (request.threshold !== undefined && score < request.threshold) continue;

      // Find metadata
      const metaLine = metadataLines.find((line) => {
        try {
          const parsed = JSON.parse(line) as { id: string };
          return parsed.id === entry.id;
        } catch {
          return false;
        }
      });

      const metadata = metaLine
        ? (JSON.parse(metaLine) as TMetadata)
        : ({} as TMetadata);

      results.push({ id: entry.id, score, metadata });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, request.topK);
  }

  async deleteByDocument(
    corpusId: string,
    documentId: string,
  ): Promise<void> {
    for (const ns of ['schema', 'fact', 'passage', 'entity'] as const) {
      const nsDir = this.getNamespaceDir(corpusId, ns);
      if (!existsSync(nsDir)) continue;

      const manifest = this.loadManifest(nsDir);
      let changed = false;
      for (let i = 0; i < manifest.entries.length; i++) {
        const entry = manifest.entries[i]!;
        if (entry.documentId === documentId && !entry.deleted) {
          manifest.entries[i] = { ...entry, deleted: true };
          changed = true;
        }
      }
      if (changed) {
        manifest.version++;
        this.saveManifest(nsDir, manifest);
      }
    }
  }

  private getNamespaceDir(corpusId: string, namespace: string): string {
    return resolve(this.baseDir, corpusId, namespace);
  }

  private loadManifest(nsDir: string): Manifest {
    const manifestPath = resolve(nsDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      return { entries: [], version: 0 };
    }
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
  }

  private saveManifest(nsDir: string, manifest: Manifest): void {
    writeFileSync(
      resolve(nsDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
