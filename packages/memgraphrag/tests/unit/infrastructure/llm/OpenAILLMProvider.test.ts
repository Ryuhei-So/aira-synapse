import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAILLMProvider } from '../../../../src/infrastructure/llm/OpenAILLMProvider.js';

const API_KEY = 'sk-test-secret';

describe('TASK-MG-023: OpenAILLMProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retries transient failures and eventually returns generated text', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('rate limit', { status: 429 }))
      .mockResolvedValueOnce(new Response('server error', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Generated answer' } }],
            usage: { prompt_tokens: 12, completion_tokens: 7 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAILLMProvider({ apiKey: API_KEY, model: 'gpt-test' });
    const result = await provider.generate({ prompt: 'Summarize this paper.' });

    expect(result).toEqual({
      text: 'Generated answer',
      model: 'gpt-test',
      usage: { inputTokens: 12, outputTokens: 7 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('redacts API keys from thrown errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(
      new Error(`network failure for ${API_KEY}`),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAILLMProvider({ apiKey: API_KEY, model: 'gpt-test' });

    await expect(provider.generate({ prompt: 'Hello' })).rejects.toThrow('***');
    await expect(provider.generate({ prompt: 'Hello again' })).rejects.not.toThrow(
      API_KEY,
    );
  });

  it('reports healthy when the models endpoint succeeds', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAILLMProvider({ apiKey: API_KEY, model: 'gpt-test' });
    const health = await provider.healthCheck();

    expect(health).toEqual({
      healthy: true,
      message: 'OpenAI model gpt-test reachable',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
