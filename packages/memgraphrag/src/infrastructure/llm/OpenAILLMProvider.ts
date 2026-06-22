/**
 * Infrastructure Layer — OpenAI-compatible text generation provider.
 * DES-MG-033: Fetch-based adapter with retry and secret redaction.
 */

import type {
  ILLMProvider,
  ProviderHealth,
  TextGenerationRequest,
  TextGenerationResponse,
} from '../../domain/provider/llmProvider.js';

interface OpenAILLMProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}

type ChatMessageContent = string | ReadonlyArray<{
  readonly type?: string;
  readonly text?: string;
}>;

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: ChatMessageContent;
    };
    readonly finish_reason?: string;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 25;

/** Models that support reasoning_effort / verbosity and ignore temperature. */
const REASONING_MODEL_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'];

function toContentText(content: ChatMessageContent | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

export class OpenAILLMProvider implements ILLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  public constructor(options: OpenAILLMProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  public async generate(
    request: TextGenerationRequest,
  ): Promise<TextGenerationResponse> {
    const isReasoning = REASONING_MODEL_PREFIXES.some(
      (prefix) => this.model.startsWith(prefix),
    );

    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [
        ...(request.systemPrompt
          ? [{ role: 'system' as const, content: request.systemPrompt }]
          : []),
        { role: 'user' as const, content: request.prompt },
      ],
      max_completion_tokens: request.maxTokens,
      response_format:
        request.responseFormat === 'json'
          ? { type: 'json_object' as const }
          : undefined,
    };

    if (isReasoning) {
      // Reasoning models: use reasoning_effort/verbosity, skip temperature
      if (request.reasoningEffort) {
        payload.reasoning_effort = request.reasoningEffort;
      }
      if (request.verbosity) {
        payload.verbosity = request.verbosity;
      }
    } else {
      // Non-reasoning models: use temperature
      payload.temperature = request.temperature;
    }

    const response = await this.callWithRetry(payload, request, isReasoning);

    return {
      text: toContentText(response.choices?.[0]?.message?.content),
      model: this.model,
      finishReason: response.choices?.[0]?.finish_reason ?? undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * Call API with retry. If finish_reason=length on a reasoning model,
   * retry once with lower effort to avoid truncated reasoning traces.
   */
  private async callWithRetry(
    payload: Record<string, unknown>,
    request: TextGenerationRequest,
    isReasoning: boolean,
  ): Promise<ChatCompletionResponse> {
    const response = await this.retryWithBackoff(async () => {
      const apiResponse = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal: request.signal,
      });

      if (!apiResponse.ok) {
        const body = await apiResponse.text();
        throw this.createHttpError(apiResponse.status, body);
      }

      return (await apiResponse.json()) as ChatCompletionResponse;
    });

    // If reasoning model hit token limit, retry with lower effort
    if (
      isReasoning
      && response.choices?.[0]?.finish_reason === 'length'
      && request.reasoningEffort !== 'low'
    ) {
      const fallbackPayload = { ...payload, reasoning_effort: 'low' };
      return this.retryWithBackoff(async () => {
        const apiResponse = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(fallbackPayload),
          signal: request.signal,
        });
        if (!apiResponse.ok) {
          const body = await apiResponse.text();
          throw this.createHttpError(apiResponse.status, body);
        }
        return (await apiResponse.json()) as ChatCompletionResponse;
      });
    }

    return response;
  }

  public async healthCheck(): Promise<ProviderHealth> {
    if (!this.apiKey.trim()) {
      return { healthy: false, message: 'OpenAI API key is not configured' };
    }

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        const body = await response.text();
        throw this.createHttpError(response.status, body);
      }

      return { healthy: true, message: `OpenAI model ${this.model} reachable` };
    } catch (error) {
      return {
        healthy: false,
        message: this.sanitizeError(error),
      };
    }
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < MAX_RETRIES) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        attempt += 1;

        if (!this.isTransientError(error) || attempt >= MAX_RETRIES) {
          throw new Error(this.sanitizeError(error));
        }

        await this.sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }

    throw new Error(this.sanitizeError(lastError));
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private createHttpError(status: number, body: string): Error {
    return new Error(`OpenAI request failed with status ${status}: ${body}`);
  }

  private isTransientError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return Array.from(TRANSIENT_STATUS_CODES).some((status) =>
      message.includes(`status ${status}`),
    );
  }

  private sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    if (this.apiKey.length > 8) {
      return raw.replaceAll(this.apiKey, '***API_KEY***');
    }
    return raw;
  }

  private async sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
