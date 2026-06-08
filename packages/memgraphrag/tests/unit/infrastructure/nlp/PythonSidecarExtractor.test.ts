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
});
