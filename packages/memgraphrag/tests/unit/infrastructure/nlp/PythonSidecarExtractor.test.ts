import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PythonSidecarExtractor } from '../../../../src/infrastructure/nlp/PythonSidecarExtractor.js';

class MockChildProcess extends EventEmitter {
  public readonly stdin = {
    write: vi.fn<(chunk: string) => boolean>().mockReturnValue(true),
  };

  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly kill = vi.fn<() => boolean>().mockReturnValue(true);
  public killed = false;
}

describe('TASK-MG-025: PythonSidecarExtractor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds JSON-RPC extract requests and parses responses', async () => {
    const child = new MockChildProcess();
    const extractor = new PythonSidecarExtractor({
      spawnImplementation: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    const pending = extractor.extract({ text: 'TP53 regulates apoptosis.', language: 'en' });
    const rpcRequest = JSON.parse((child.stdin.write.mock.calls[0]?.[0] as string).trim()) as {
      method: string;
      params: { text: string; language: string };
      id: number;
    };

    expect(rpcRequest).toMatchObject({
      method: 'extract',
      params: { text: 'TP53 regulates apoptosis.', language: 'en' },
    });

    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: rpcRequest.id,
        result: {
          entities: [
            { text: 'TP53', label: 'GENE', start: 0, end: 4, confidence: 0.99 },
          ],
          nounPhrases: ['TP53'],
        },
      })}\n`,
    );

    await expect(pending).resolves.toEqual({
      language: 'en',
      entities: [
        { text: 'TP53', label: 'GENE', start: 0, end: 4, confidence: 0.99 },
      ],
      nounPhrases: ['TP53'],
    });
  });

  it('kills the subprocess when a request times out', async () => {
    const child = new MockChildProcess();
    child.kill.mockImplementation(() => {
      child.killed = true;
      return true;
    });

    const extractor = new PythonSidecarExtractor({
      requestTimeoutMs: 10,
      spawnImplementation: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    await expect(
      extractor.extract({ text: 'No response', language: 'en' }),
    ).rejects.toThrow('Python sidecar request timed out for method extract');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('parses health check responses from the sidecar', async () => {
    const child = new MockChildProcess();
    const extractor = new PythonSidecarExtractor({
      spawnImplementation: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    const pending = extractor.healthCheck();
    const rpcRequest = JSON.parse((child.stdin.write.mock.calls[0]?.[0] as string).trim()) as {
      method: string;
      id: number;
    };

    expect(rpcRequest.method).toBe('health');
    child.stdout.emit(
      'data',
      `${JSON.stringify({ jsonrpc: '2.0', id: rpcRequest.id, result: { ok: true } })}\n`,
    );

    await expect(pending).resolves.toEqual({
      healthy: true,
      message: 'Python sidecar is healthy',
    });
  });

  it('uses bounded JSON-RPC methods for Japanese chunking and extraction', async () => {
    const child = new MockChildProcess();
    const extractor = new PythonSidecarExtractor({
      requestTimeoutMs: 100,
      spawnImplementation: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    const chunking = extractor.chunkSentences('第一文。第二文。', 250);
    const chunkRequest = JSON.parse((child.stdin.write.mock.calls[0]?.[0] as string).trim()) as {
      method: string;
      params: { text: string; maxTokens: number };
      id: number;
    };
    expect(chunkRequest).toMatchObject({
      method: 'chunk_sentences',
      params: { text: '第一文。第二文。', maxTokens: 250 },
    });
    child.stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0',
      id: chunkRequest.id,
      result: { chunks: [{ text: '第一文。', sentenceCount: 1, estimatedTokens: 2 }] },
    })}\n`);
    await expect(chunking).resolves.toEqual([
      { text: '第一文。', sentenceCount: 1, estimatedTokens: 2 },
    ]);

    const extraction = extractor.extractEntitiesJa('東京大学');
    const extractRequest = JSON.parse((child.stdin.write.mock.calls[1]?.[0] as string).trim()) as {
      method: string;
      params: { text: string };
      id: number;
    };
    expect(extractRequest).toMatchObject({
      method: 'extract_entities_ja',
      params: { text: '東京大学' },
    });
    child.stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0',
      id: extractRequest.id,
      result: {
        entities: [{ text: '東京大学', label: 'ORG', start: 0, end: 4, confidence: 0.9 }],
        nounPhrases: ['東京大学'],
      },
    })}\n`);
    await expect(extraction).resolves.toEqual({
      language: 'ja',
      entities: [{ text: '東京大学', label: 'ORG', start: 0, end: 4, confidence: 0.9 }],
      nounPhrases: ['東京大学'],
    });
  });

  it('ignores malformed and unmatched frames before returning the authoritative RPC error', async () => {
    const child = new MockChildProcess();
    const extractor = new PythonSidecarExtractor({
      spawnImplementation: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    const pending = extractor.extract({ text: 'bad response', language: 'en' });
    const request = JSON.parse((child.stdin.write.mock.calls[0]?.[0] as string).trim()) as {
      id: number;
    };
    child.stdout.emit(
      'data',
      `not-json\n${JSON.stringify({ jsonrpc: '2.0', id: request.id + 1, result: {} })}\n\n`,
    );
    child.stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message: 'sidecar rejected request' },
    })}\n`);

    await expect(pending).rejects.toThrow('sidecar rejected request');
  });
});
