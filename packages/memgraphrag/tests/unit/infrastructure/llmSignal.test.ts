/**
 * Unit tests for TextGenerationRequest signal extension (T2).
 * Validates signal propagation through OpenAILLMProvider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAILLMProvider } from '../../../src/infrastructure/llm/OpenAILLMProvider.js';

describe('OpenAILLMProvider — AbortSignal propagation', () => {
  let provider: OpenAILLMProvider;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new OpenAILLMProvider({
      apiKey: 'test-key',
      model: 'gpt-5.4-mini',
    });
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should pass signal to fetch when provided', async () => {
    const controller = new AbortController();

    await provider.generate({
      prompt: 'test',
      signal: controller.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('should pass undefined signal when not provided', async () => {
    await provider.generate({ prompt: 'test' });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: undefined }),
    );
  });

  it('should reject when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    fetchSpy.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    await expect(
      provider.generate({ prompt: 'test', signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('should reject when signal fires during request', async () => {
    const controller = new AbortController();

    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      // Simulate abort during fetch
      if (init.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      // Abort mid-flight
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });

    await expect(
      provider.generate({ prompt: 'test', signal: controller.signal }),
    ).rejects.toThrow();
  });
});
