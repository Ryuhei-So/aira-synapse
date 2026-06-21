/**
 * Infrastructure Layer — OpenAI Batch API Embedding Provider.
 * Submits embedding requests via the Batch API (50% cost reduction, 24h SLA).
 *
 * Flow:
 *   1. Write requests to .jsonl file
 *   2. Upload file to OpenAI
 *   3. Create batch
 *   4. Poll until complete
 *   5. Download and parse results
 */

import { writeFileSync, readFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  EmbeddingRequest,
  EmbeddingResponse,
  IEmbeddingProvider,
  ProviderHealth,
} from '../../domain/provider/llmProvider.js';

interface BatchEmbeddingProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly dimensions?: number;
  readonly outputDir: string;
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
}

interface BatchStatus {
  id: string;
  status: string;
  output_file_id?: string;
  error_file_id?: string;
  request_counts?: { total: number; completed: number; failed: number };
}

export class BatchEmbeddingProvider implements IEmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly dimensions: number | undefined;
  private readonly outputDir: string;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  public constructor(options: BatchEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.dimensions = options.dimensions;
    this.outputDir = options.outputDir;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.maxWaitMs = options.maxWaitMs ?? 24 * 60 * 60 * 1000; // 24h
    mkdirSync(this.outputDir, { recursive: true });
  }

  public async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.apiKey.trim()) {
      throw new Error('BatchEmbeddingProvider requires an API key');
    }
    if (request.texts.length === 0) {
      return { model: request.model ?? this.model, vectors: [], cached: true };
    }

    const model = request.model ?? this.model;
    const batchId = randomUUID().slice(0, 8);
    const MAX_INPUT_CHARS = 7000;

    // 1. Write requests .jsonl
    const requestLines = request.texts.map((text, idx) => {
      const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
      return JSON.stringify({
        custom_id: `emb-${idx}`,
        method: 'POST',
        url: '/v1/embeddings',
        body: {
          model,
          input: truncated,
          ...(this.dimensions ? { dimensions: this.dimensions } : {}),
        },
      });
    });

    const inputPath = resolve(this.outputDir, `batch-${batchId}-input.jsonl`);
    writeFileSync(inputPath, requestLines.join('\n'));
    console.log(`[batch-embed] Written ${request.texts.length} requests to ${inputPath}`);

    // 2. Upload file
    const fileId = await this.uploadFile(inputPath);
    console.log(`[batch-embed] Uploaded file: ${fileId}`);

    // 3. Create batch
    const batch = await this.createBatch(fileId);
    console.log(`[batch-embed] Created batch: ${batch.id}`);

    // 4. Poll until complete
    const completed = await this.pollBatch(batch.id);
    if (completed.status !== 'completed') {
      throw new Error(`Batch ${batch.id} ended with status: ${completed.status}`);
    }
    console.log(`[batch-embed] Batch completed: ${completed.request_counts?.completed}/${completed.request_counts?.total}`);

    // 5. Download results
    const vectors = await this.downloadResults(completed.output_file_id!, request.texts.length);

    // Save output for reference
    const outputPath = resolve(this.outputDir, `batch-${batchId}-output.json`);
    writeFileSync(outputPath, JSON.stringify({ batchId: batch.id, model, count: vectors.length }));

    return { model, vectors, cached: false };
  }

  public async healthCheck(): Promise<ProviderHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/models/${this.model}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return { healthy: response.ok, message: response.ok ? 'batch-api ready' : `status ${response.status}` };
    } catch (err) {
      return { healthy: false, message: String(err) };
    }
  }

  private async uploadFile(filePath: string): Promise<string> {
    const content = readFileSync(filePath);
    const formData = new FormData();
    formData.append('purpose', 'batch');
    formData.append('file', new Blob([content]), `batch-input.jsonl`);

    const response = await fetch(`${this.baseUrl}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`File upload failed (${response.status}): ${body}`);
    }
    const result = await response.json() as { id: string };
    return result.id;
  }

  private async createBatch(inputFileId: string): Promise<BatchStatus> {
    const response = await fetch(`${this.baseUrl}/batches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input_file_id: inputFileId,
        endpoint: '/v1/embeddings',
        completion_window: '24h',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Batch creation failed (${response.status}): ${body}`);
    }
    return await response.json() as BatchStatus;
  }

  private async pollBatch(batchId: string): Promise<BatchStatus> {
    const startTime = Date.now();
    while (Date.now() - startTime < this.maxWaitMs) {
      const response = await fetch(`${this.baseUrl}/batches/${batchId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!response.ok) {
        throw new Error(`Batch poll failed (${response.status})`);
      }
      const status = await response.json() as BatchStatus;

      if (['completed', 'failed', 'expired', 'cancelled'].includes(status.status)) {
        return status;
      }

      const counts = status.request_counts;
      if (counts) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`[batch-embed] Polling... ${counts.completed}/${counts.total} (${elapsed}s elapsed)`);
      }
      await new Promise(r => setTimeout(r, this.pollIntervalMs));
    }
    throw new Error(`Batch ${batchId} timed out after ${this.maxWaitMs}ms`);
  }

  private async downloadResults(outputFileId: string, expectedCount: number): Promise<readonly (readonly number[])[]> {
    const response = await fetch(`${this.baseUrl}/files/${outputFileId}/content`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!response.ok) {
      throw new Error(`File download failed (${response.status})`);
    }

    // Stream to disk first to avoid V8 string length limit (~1GB)
    const tmpPath = resolve(this.outputDir, `download-${outputFileId}.jsonl`);
    const body = response.body;
    if (!body) {
      throw new Error('Response body is null');
    }

    const fileStream = createWriteStream(tmpPath);
    const reader = body.getReader();
    let totalBytes = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
      totalBytes += value.byteLength;
    }
    fileStream.end();
    await new Promise<void>((res, rej) => { fileStream.on('finish', res); fileStream.on('error', rej); });
    console.log(`[batch-embed] Downloaded ${(totalBytes / 1024 / 1024).toFixed(1)}MB to ${tmpPath}`);

    // Parse line by line from disk
    const vectors: (readonly number[])[] = new Array(expectedCount);
    const rl = createInterface({ input: createReadStream(tmpPath), crlfDelay: Infinity });
    let parsed = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      const result = JSON.parse(line) as {
        custom_id: string;
        response: { body: { data: Array<{ embedding: number[] }> } };
      };
      const idx = parseInt(result.custom_id.replace('emb-', ''), 10);
      vectors[idx] = result.response.body.data[0]!.embedding;
      parsed++;
      if (parsed % 10000 === 0) {
        console.log(`[batch-embed] Parsed ${parsed}/${expectedCount} results...`);
      }
    }

    console.log(`[batch-embed] Parsed ${parsed} total results`);

    // Verify all slots filled
    let missing = 0;
    for (let i = 0; i < expectedCount; i++) {
      if (!vectors[i]) missing++;
    }
    if (missing > 0) {
      throw new Error(`Missing ${missing} embeddings out of ${expectedCount}`);
    }
    return vectors;
  }
}
